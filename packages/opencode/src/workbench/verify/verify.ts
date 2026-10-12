import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ascending } from "@opencode-ai/schema/identifier"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Context, Effect, Fiber, Layer, Option, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { containsPath } from "@/project/instance-context"
import { Filesystem } from "@/util/filesystem"
import { Config } from "@/config/config"
import { WorkbenchProblems } from "../problems/store"
import { WorkbenchInvestigation } from "../investigation/investigation" // spicy: runs feed investigations
import { WorkbenchCheckers } from "./checkers"
import { WorkbenchParse } from "./parse"

export const BUDGET_MS = 60_000
export const TEST_BUDGET_MS = 180_000 // when tests run
const CONCURRENCY = 2 // units at a time
const MAX_OUTPUT = 4 * 1024 * 1024 // per stream, in memory for parsing
const MAX_STREAMED = 1024 * 1024 // per run, as workbench.run.output events
const MAX_KEPT = 256 * 1024 // per run, kept for GET /workbench/runs/:runID
const MAX_UNIT_FILES = 200
const REPORTS = 50
const RUNS = 100
const NEEDS_APPROVAL = "needs approval (verify.exec)"

export type Input = {
  files?: ReadonlyArray<string>
  /** A folder (its source files, gitignore-aware, at most 200) or one file. */
  unit?: string
  trigger: Workbench.VerificationReport["trigger"]
  sessionID?: string
  budgetMs?: number
  /** Also run test runners (always exec-class). */
  tests?: boolean
  /** Returns the exec-class units allowed to run. The check tool asks; the gate and the MCP bridge never ask. */
  approve: (units: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>
  /** Why exec-class units that were not approved are skipped. */
  approval?: string
}

export type Found = WorkbenchProblems.Draft & { tool: string; new: boolean }
export type Result = { report: Workbench.VerificationReport; problems: Found[] }
export type RunRecord = { run: Workbench.RunInfo; output: string; truncated: boolean }

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<Result>
  /** Reports this instance produced, oldest first. Only the engine writes them. */
  readonly reports: () => Effect.Effect<ReadonlyArray<Workbench.VerificationReport>>
  /** Recent runs, newest first. */
  readonly runs: () => Effect.Effect<ReadonlyArray<Workbench.RunInfo>>
  /** One recent run with the output it printed (stdout and stderr as they arrived, capped). */
  readonly record: (id: Workbench.RunID) => Effect.Effect<RunRecord | undefined>
  /** File extensions some checker handles. */
  readonly extensions: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchVerify") {}

type Planned = WorkbenchCheckers.Unit & {
  checker: WorkbenchCheckers.Info
  plan: WorkbenchCheckers.Plan
}
type Check = Result["report"]["checks"][number] & { problems: Found[] }

export const layerFor = (checkers: WorkbenchCheckers.Info[]) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* WorkbenchProblems.Service
      const config = yield* Config.Service
      const investigations = yield* WorkbenchInvestigation.Service // spicy: runs feed investigations
      const events = yield* EventV2Bridge.Service
      const spawner = yield* ChildProcessSpawner
      const ripgrep = yield* Ripgrep.Service
      const fs = yield* FSUtil.Service
      const extensions = [...new Set(checkers.flatMap((checker) => checker.extensions))]
      const state = yield* InstanceState.make(() =>
        Effect.succeed({ reports: [] as Workbench.VerificationReport[], runs: new Map<string, RunRecord>() }),
      )

      const publish = (record: RunRecord, run: Workbench.RunInfo) => {
        record.run = run
        return events.publish(Workbench.Event.RunUpdated, { run })
      }

      // Runs one command, streaming output as workbench.run.output at most four times a second and keeping the
      // start of it on the run record. Interruption (budget, newer run) closes the scope, which kills the
      // process group.
      const execute = Effect.fnUntraced(function* (record: RunRecord, command: string[], cwd: string) {
        const output = { stdout: "", stderr: "", streamed: 0, pending: "", seq: 0 }
        const flush = Effect.suspend(() => {
          if (!output.pending) return Effect.void
          const chunk = output.pending
          output.pending = ""
          return events.publish(Workbench.Event.RunOutput, { runID: record.run.id, seq: output.seq++, chunk })
        })
        const collect = (stream: Stream.Stream<Uint8Array, unknown>, key: "stdout" | "stderr") =>
          stream.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) =>
              Effect.sync(() => {
                if (output[key].length < MAX_OUTPUT) output[key] += text
                if (output.streamed < MAX_STREAMED) output.pending += text
                output.streamed += text.length
                if (record.output.length < MAX_KEPT) record.output = (record.output + text).slice(0, MAX_KEPT)
                record.truncated = output.streamed > MAX_KEPT
              }),
            ),
          )
        const exitCode = yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command[0], command.slice(1), {
              cwd,
              extendEnv: true,
              env: { NO_COLOR: "1", CLICOLOR: "0", CARGO_TERM_COLOR: "never", TERM: "dumb" },
              stdin: "ignore",
              forceKillAfter: "2 seconds",
            }),
          )
          const ticker = yield* flush.pipe(Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped)
          const [code] = yield* Effect.all(
            [handle.exitCode, collect(handle.stdout, "stdout"), collect(handle.stderr, "stderr")],
            { concurrency: "unbounded" },
          )
          yield* Fiber.interrupt(ticker)
          return code
        }).pipe(Effect.scoped, Effect.ensuring(flush))
        return { exitCode, stdout: output.stdout, stderr: output.stderr }
      })

      // XML reports the tool wrote into its report directory, in name order.
      const reports = (dir: string) =>
        fs.readDirectory(dir).pipe(
          Effect.flatMap((names) =>
            Effect.forEach(names.toSorted(), (name) => fs.readFileString(path.join(dir, name))),
          ),
          Effect.map((texts) => texts.join("\n")),
          Effect.orElseSucceed(() => ""),
        )

      const runUnit = Effect.fnUntraced(function* (
        unit: Planned,
        context: {
          changed: Set<string>
          deadline: number
          approved: Set<string>
          approval: string
          passed: Set<string>
        },
      ) {
        const checker = unit.checker
        const s = yield* InstanceState.get(state)
        // A fresh directory for tools that write JUnit/xUnit reports; removed when the run ends.
        const reportDir =
          "command" in unit.plan && unit.plan.command.some((arg) => arg.includes(WorkbenchCheckers.REPORT_DIR))
            ? yield* fs.makeTempDirectoryScoped({ prefix: "opencode-report-" }).pipe(Effect.orDie)
            : undefined
        const command =
          "command" in unit.plan
            ? unit.plan.command.map((arg) =>
                reportDir ? arg.replaceAll(WorkbenchCheckers.REPORT_DIR, reportDir) : arg,
              )
            : []
        const record: RunRecord = {
          run: {
            id: Workbench.RunID.create(),
            kind: checker.test ? "test" : "check",
            unit: unit.root,
            checker: checker.id,
            command,
            execClass: "command" in unit.plan ? unit.plan.execClass : "inert",
            status: "queued",
          },
          output: "",
          truncated: false,
        }
        s.runs.set(record.run.id, record)
        for (const id of [...s.runs.keys()].slice(0, -RUNS)) s.runs.delete(id)
        const info = record.run
        const done = Effect.fnUntraced(function* (run: Workbench.RunInfo, problems: Found[] = []) {
          yield* publish(record, run)
          return {
            run,
            problems,
            newErrors: problems.filter((item) => item.severity === "error" && item.new).length,
            otherErrors: problems.filter((item) => item.severity === "error" && !item.new).length,
          } satisfies Check
        })
        const producer = `check:${checker.id}:${unit.root}`
        const meta = { kind: checker.kind, tool: checker.id }

        if (!("command" in unit.plan)) {
          const reason = unit.plan.unavailable
          const begun = yield* store.begin(producer, meta)
          yield* store.finish(producer, begun.generation, { state: "unavailable", reason, observedAt: Date.now() })
          return yield* done({ ...info, status: "unavailable", reason })
        }
        if (checker.after && !context.passed.has(`${checker.after}\0${unit.root}`))
          return yield* done({ ...info, status: "skipped", reason: `${checker.after} did not pass` })
        if (info.execClass === "exec" && !context.approved.has(unit.root))
          return yield* done({ ...info, status: "skipped", reason: context.approval })
        const remaining = context.deadline - Date.now()
        if (remaining <= 0) return yield* done({ ...info, status: "skipped", reason: "budget" })

        const begun = yield* store.begin(producer, meta)
        const running = { ...info, status: "running" as const, startedAt: Date.now() }
        yield* publish(record, running)
        const plan = unit.plan
        const outcome = yield* execute(record, command, plan.cwd).pipe(
          Effect.map((result) => ({ type: "exit" as const, ...result })),
          Effect.timeoutOption(remaining),
          Effect.map(Option.getOrElse(() => ({ type: "timeout" as const }))),
          Effect.raceFirst(abort(begun.signal)),
          Effect.catch((error) => Effect.succeed({ type: "error" as const, reason: String(error) })),
        )
        const finishedAt = Date.now()
        const settle = (result: WorkbenchProblems.Result) => store.finish(producer, begun.generation, result)

        if (outcome.type === "cancelled")
          return yield* done({ ...running, status: "cancelled", reason: "superseded by a newer run", finishedAt })
        if (outcome.type === "timeout") {
          yield* settle({ state: "failed", reason: "timed out (budget)", observedAt: running.startedAt })
          return yield* done({ ...running, status: "timed_out", reason: "budget", finishedAt })
        }
        if (outcome.type === "error") {
          yield* settle({ state: "unavailable", reason: outcome.reason, observedAt: running.startedAt })
          return yield* done({ ...running, status: "unavailable", reason: outcome.reason, finishedAt })
        }

        const parsed = checker.parse({
          stdout: WorkbenchParse.stripAnsi(outcome.stdout),
          stderr: WorkbenchParse.stripAnsi(outcome.stderr),
          exitCode: outcome.exitCode,
          cwd: plan.cwd,
          report: reportDir ? yield* reports(reportDir) : undefined,
        })
        const empty = checker.empty?.[outcome.exitCode]
        // A failing exit with nothing parsed is still a failure, never a pass.
        const silent =
          outcome.exitCode !== 0 &&
          empty === undefined &&
          !(checker.findings ?? []).includes(outcome.exitCode) &&
          !parsed.some((item) => item.severity === "error")
        const drafts = silent
          ? [
              ...parsed,
              {
                severity: "error" as const,
                message: [`${checker.id} exited with code ${outcome.exitCode}`, ...tail(outcome)].join("\n"),
              },
            ]
          : parsed
        const problems = drafts.map((item) => ({
          ...item,
          tool: checker.id,
          new: item.file === undefined || context.changed.has(item.file),
        }))
        const failed = problems.some((item) => item.severity === "error")
        if (!failed) context.passed.add(`${checker.id}\0${unit.root}`)
        yield* settle({ state: "idle", observedAt: running.startedAt, runID: info.id, problems: drafts })
        const final = {
          ...running,
          finishedAt,
          exitCode: outcome.exitCode,
          counts: WorkbenchProblems.count(problems),
        }
        // the tool ran but found nothing to run (pytest exit 5): not a pass
        if (!failed && empty !== undefined) return yield* done({ ...final, status: "skipped", reason: empty }, problems)
        return yield* done({ ...final, status: failed ? "failed" : "passed" }, problems)
      }, Effect.scoped)

      // A folder's source files (gitignore-aware), or the file itself. Repository checks select files by glob, so
      // with any configured every file is a candidate.
      const expand = Effect.fnUntraced(function* (target: string, all: boolean) {
        if (!(yield* fs.isDir(target))) return [target]
        const entries = yield* ripgrep
          .glob({ cwd: target, pattern: all ? "**/*" : `**/*{${extensions.join(",")}}`, limit: MAX_UNIT_FILES })
          .pipe(Effect.orElseSucceed(() => []))
        return entries.map((entry) => path.join(target, entry.path))
      })

      const run = Effect.fn("WorkbenchVerify.run")(function* (input: Input) {
        const ctx = yield* InstanceState.context
        const stop = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        const resolve = (file: string) => path.resolve(ctx.directory, file)
        const deadline = Date.now() + (input.budgetMs ?? BUDGET_MS)
        // Repository checks are read when a check runs, never when the configuration loads (VER-07).
        const repo = Object.entries((yield* config.get()).workbench?.checks ?? {}).map(([name, check]) =>
          WorkbenchCheckers.repo(name, check, ctx.directory),
        )
        const active = [...checkers.filter((checker) => !repo.some((item) => item.id === checker.id)), ...repo]
        // the files asked about are the changed files: errors in them are new, errors elsewhere in a unit are not
        const requested = [
          ...(input.files ?? []),
          ...(input.unit ? yield* expand(resolve(input.unit), repo.length > 0) : []),
        ]
        const changed = new Set(requested.map(resolve))
        const files = yield* Effect.promise(async () => {
          const candidates = [...changed].filter((file) => containsPath(file, ctx))
          const exists = await Promise.all(candidates.map((file) => Filesystem.exists(file)))
          return candidates.filter((_, index) => exists[index])
        })
        const units = yield* Effect.promise(() =>
          plan(
            active.filter((checker) => input.tests || !checker.test),
            files,
            stop,
          ),
        )
        const exec = units.flatMap((unit) =>
          "command" in unit.plan && unit.plan.execClass === "exec" ? [unit.root] : [],
        )
        const approved = new Set(exec.length ? yield* input.approve([...new Set(exec)]) : [])
        const context = {
          changed,
          deadline,
          approved,
          approval: input.approval ?? NEEDS_APPROVAL,
          passed: new Set<string>(),
        }
        // Checkers that share a root run in order (go vet waits for go build); other roots run CONCURRENCY at a
        // time. Test runners come after all checkers, one at a time: suites share ports, databases and tool state
        // (two pytest processes starting together tripped over a plugin's data folder on this machine).
        const groups = Object.values(
          Object.groupBy(
            units.filter((unit) => !unit.checker.test),
            (unit) => unit.root,
          ),
        ).flatMap((group) => (group ? [group] : []))
        const checks = [
          ...(yield* Effect.forEach(groups, (group) => Effect.forEach(group, (unit) => runUnit(unit, context)), {
            concurrency: CONCURRENCY,
          })).flat(),
          ...(yield* Effect.forEach(
            units.filter((unit) => unit.checker.test),
            (unit) => runUnit(unit, context),
          )),
        ]

        const covering = (file: string) =>
          checks.filter((check) =>
            units.some(
              (unit) =>
                unit.root === check.run.unit && unit.checker.id === check.run.checker && unit.files.includes(file),
            ),
          )
        const report: Workbench.VerificationReport = {
          id: "vr_" + ascending(),
          sessionID: input.sessionID,
          trigger: input.trigger,
          changedFiles: [...changed],
          checks: checks.map((check) => ({
            run: check.run,
            newErrors: check.newErrors,
            otherErrors: check.otherErrors,
          })),
          summary: {
            passed: checks.filter((check) => check.run.status === "passed").length,
            failed: checks.filter((check) => check.run.status === "failed").length,
            // cancelled runs have no field of their own; they are counted as skipped, never as passed
            skipped: checks.filter((check) => check.run.status === "skipped" || check.run.status === "cancelled")
              .length,
            unavailable: checks.filter((check) => check.run.status === "unavailable").length,
            timedOut: checks.filter((check) => check.run.status === "timed_out").length,
          },
          unverifiedFiles: [...changed].filter((file) => {
            const runs = covering(file)
            return !runs.length || runs.some((check) => check.run.status !== "passed")
          }),
          completedAt: Date.now(),
        }
        const s = yield* InstanceState.get(state)
        s.reports = [...s.reports, report].slice(-REPORTS)
        const problems = checks.flatMap((check) => check.problems)
        // spicy: a run for a session with an open investigation is recorded as its check (and test) evidence
        if (input.sessionID) yield* investigations.verified(input.sessionID, report, problems)
        return { report, problems }
      })

      return Service.of({
        run,
        reports: Effect.fn("WorkbenchVerify.reports")(function* () {
          return (yield* InstanceState.get(state)).reports
        }),
        runs: Effect.fn("WorkbenchVerify.runs")(function* () {
          return [...(yield* InstanceState.get(state)).runs.values()].map((record) => record.run).toReversed()
        }),
        record: Effect.fn("WorkbenchVerify.record")(function* (id: Workbench.RunID) {
          const record = (yield* InstanceState.get(state)).runs.get(id)
          return record && { ...record }
        }),
        extensions,
      })
    }),
  )

// Maps every file to a unit per checker, then plans one command per (checker, unit) in checker order.
async function plan(checkers: WorkbenchCheckers.Info[], files: string[], stop: string): Promise<Planned[]> {
  const pairs = checkers.flatMap((checker) =>
    files
      .filter((file) => (checker.matches ? checker.matches(file) : checker.extensions.includes(path.extname(file))))
      .map((file) => ({ checker, file })),
  )
  const roots = await Promise.all(pairs.map((pair) => pair.checker.unit(pair.file, stop).catch(() => undefined)))
  const units = Map.groupBy(
    pairs.flatMap((pair, index) => (roots[index] ? [{ ...pair, root: roots[index] }] : [])),
    (item) => `${item.checker.id}\0${item.root}`,
  )
  const planned = await Promise.all(
    [...units.values()].map(async (items) => {
      const unit = { checker: items[0].checker, root: items[0].root, files: items.map((item) => item.file) }
      const plan = await unit.checker
        .plan(unit, stop)
        .catch((error): WorkbenchCheckers.Plan => ({ unavailable: `${unit.checker.id}: ${String(error)}` }))
      return { ...unit, plan }
    }),
  )
  return planned.filter((unit) => !(unit.checker.optional && "unavailable" in unit.plan))
}

/** One line per problem for the model: path:line:col severity code [tool] message. */
export function formatProblem(item: Found, directory: string) {
  const where = item.file
    ? `${path.relative(directory, item.file)}${item.range ? `:${item.range.start.line + 1}:${item.range.start.character + 1}` : ""}`
    : "(no file)"
  const message = item.message.split("\n").slice(0, 6).join("\n  ")
  return `${where} ${item.severity}${item.code === undefined ? "" : ` ${item.code}`} [${item.tool}] ${message}`
}

function abort(signal: AbortSignal) {
  return Effect.callback<{ type: "cancelled" }>((resume) => {
    const done = () => resume(Effect.succeed({ type: "cancelled" as const }))
    if (signal.aborted) return done()
    signal.addEventListener("abort", done, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", done))
  })
}

function tail(output: { stdout: string; stderr: string }) {
  return WorkbenchParse.stripAnsi(output.stderr.trim() ? output.stderr : output.stdout)
    .split("\n")
    .filter((line) => line.trim())
    .slice(-15)
}

export const layer = layerFor(WorkbenchCheckers.all)

export const nodeFor = (checkers: WorkbenchCheckers.Info[]) =>
  LayerNode.make({
    service: Service,
    layer: layerFor(checkers),
    deps: [
      WorkbenchProblems.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
      FSUtil.node,
      Config.node,
      WorkbenchInvestigation.node, // spicy: investigations
    ],
  })

export const node = nodeFor(WorkbenchCheckers.all)

export * as WorkbenchVerify from "./verify"
