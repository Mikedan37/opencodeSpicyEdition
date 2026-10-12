// Investigations: a persisted record of one debugging effort, separate from the conversation.
// Status moves only on events the server recorded (debug stops, edits, check and repro results),
// through an explicit transition table, with the supervisor able to block or hand it to the user.
// Evidence is written only here; the model can add notes (inferred), never evidence.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Context, Effect, Layer, Option, Schema, Semaphore, Types } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Storage } from "@/storage/storage"
import { DebugError } from "../dap/client"
import { DebugLaunch } from "../dap/launch"
import { WorkbenchDebug } from "../dap/service"
import { DebugSession } from "../dap/session"
import { DebugSnapshot } from "../dap/snapshot"
import { Redact } from "../redact"
import { Supervisor } from "./supervisor"

export type Status = Workbench.InvestigationStatus

export const DEFAULT_POLICY: Workbench.RecoveryPolicy = {
  maxRepairAttempts: 2,
  maxDebugSteps: 200,
  maxInvestigationDurationMs: 1_800_000,
  requireApprovalForExecution: true,
  requireApprovalForAttach: true,
  stopOnRepeatedFailures: true,
  stopOnPermissionDenial: true,
}

// Statuses the agent is working in. Paused ones wait for the user; terminal ones never move again.
export const ACTIVE: readonly Status[] = ["created", "reproducing", "debugging", "diagnosing", "patching", "verifying"]
export const TERMINAL: readonly Status[] = ["resolved", "cancelled", "failed"]

// The forward flow. Any active status may also go to blocked, needs_human, failed, cancelled or
// interrupted; paused ones may also be cancelled or failed.
const FLOW: Record<Status, readonly Status[]> = {
  created: ["reproducing"],
  reproducing: ["debugging", "diagnosing", "patching"],
  debugging: ["diagnosing", "patching"],
  diagnosing: ["debugging", "patching"],
  patching: ["verifying"],
  verifying: ["resolved", "patching"],
  blocked: ["needs_human"],
  interrupted: ["reproducing"],
  needs_human: ["reproducing"],
  resolved: [],
  cancelled: [],
  failed: [],
}

export function allowed(from: Status, to: Status) {
  if (FLOW[from].includes(to)) return true
  if (ACTIVE.includes(from)) return ["blocked", "needs_human", "failed", "cancelled", "interrupted"].includes(to)
  if (!TERMINAL.includes(from)) return to === "cancelled" || to === "failed"
  return false
}

// The record and its detail view are part of the shared contract.
export const Info = Workbench.Investigation
export type Info = Workbench.Investigation
export type Draft = Types.DeepMutable<Info>

/** A problem as the verification engine reports it. */
export type Found = Problem & { readonly severity: string; readonly new: boolean }

export type Problem = {
  readonly tool: string
  readonly code?: string | number
  readonly file?: string
  readonly message: string
}

export type Event =
  | { readonly type: "debug.started"; readonly debugSessionID: Workbench.DebugSessionID }
  | { readonly type: "debug.processes"; readonly processes: readonly DebugSession.Process[] }
  | {
      readonly type: "debug.stopped"
      readonly debugSessionID: Workbench.DebugSessionID
      readonly snapshot: Workbench.StopSnapshot
    }
  | { readonly type: "debug.ended"; readonly debugSessionID: Workbench.DebugSessionID; readonly exitCode?: number }
  | { readonly type: "debug.crashed"; readonly debugSessionID: Workbench.DebugSessionID; readonly error: string }
  | { readonly type: "debug.steps"; readonly delta: number }
  | {
      readonly type: "console.eval"
      readonly debugSessionID: Workbench.DebugSessionID
      readonly expression: string
      readonly result: string
    }
  | { readonly type: "patch"; readonly file: string; readonly hash: string }
  | {
      readonly type: "check"
      readonly passed: boolean
      readonly runIDs: readonly string[]
      readonly problems: readonly Problem[]
      readonly unverified?: readonly string[]
    }
  | { readonly type: "repro"; readonly passed: boolean; readonly summary: string; readonly runID?: Workbench.RunID }
  | { readonly type: "permission.denied"; readonly permission: string }

export const Full = Workbench.InvestigationDetail
export type Full = Workbench.InvestigationDetail

export interface Interface {
  readonly list: () => Effect.Effect<Workbench.InvestigationSummary[]>
  readonly get: (id: string) => Effect.Effect<Info, DebugError>
  /** The record with its evidence and the final report. */
  readonly full: (id: string) => Effect.Effect<Full, DebugError>
  /** The agent session's latest investigation that has not ended, or a new one. */
  readonly open: (input: {
    readonly sessionID: string
    readonly title: string
    readonly target?: DebugLaunch.StartInput
    readonly policy?: Workbench.RecoveryPolicy
  }) => Effect.Effect<Info>
  readonly current: (sessionID: string) => Effect.Effect<Info | undefined>
  /** Starts a debug session for the investigation; its stops, exits and crashes become evidence. */
  readonly launch: (
    id: Workbench.InvestigationID,
    spec: DebugLaunch.Spec,
    actor: DebugSession.Actor,
    limits?: Partial<DebugSession.Limits>,
  ) => Effect.Effect<WorkbenchDebug.Started, DebugError>
  /** Records a server-observed event: evidence, attempts, supervisor rules, derived status. */
  readonly record: (id: Workbench.InvestigationID, event: Event) => Effect.Effect<Info, DebugError>
  readonly note: (
    id: Workbench.InvestigationID,
    note: { kind: "hypothesis" | "question"; text: string },
  ) => Effect.Effect<Info, DebugError>
  readonly escalate: (id: Workbench.InvestigationID, reason: string) => Effect.Effect<Info, DebugError>
  /** Interrupted or waiting for the user → reproducing again, relaunching the stored target. */
  readonly resume: (id: Workbench.InvestigationID, actor: DebugSession.Actor) => Effect.Effect<Info, DebugError>
  readonly cancel: (id: Workbench.InvestigationID, reason: string) => Effect.Effect<Info, DebugError>
  /**
   * A finished verification run for an agent session: recorded on its open investigation as check evidence,
   * plus reproduction evidence when the report includes test runs. Returns the updated record, if any.
   */
  readonly verified: (
    sessionID: string,
    report: Workbench.VerificationReport,
    problems: readonly Found[],
  ) => Effect.Effect<Info | undefined>
  /** Why automatic repairs must stop for this session: its investigation is blocked or waits for the user. */
  readonly halted: (sessionID: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchInvestigation") {}

type State = {
  readonly ctx: InstanceContext
  // Per investigation: events are applied one at a time, in arrival order.
  readonly locks: Map<string, Semaphore.Semaphore>
  // Per debug session: what the observer already turned into events.
  readonly seen: Map<string, { stopAt?: number; steps: number; processes: string; ended?: boolean; ran?: boolean }>
}

// Tokens of the investigation services alive in this process.
const LIVE = new Set<string>()

const key = (projectID: string, id: string) => ["workbench", "investigation", projectID, id]
const evidenceKey = (id: string) => ["workbench", "evidence", id]
const decodeRecord = Schema.decodeUnknownOption(Info)
const decodePolicy = Schema.decodeUnknownOption(Workbench.RecoveryPolicy)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const debug = yield* WorkbenchDebug.Service
    // This service instance in this opencode process, recorded as the owner of active work.
    const token = crypto.randomUUID()
    LIVE.add(token)
    yield* Effect.addFinalizer(() => Effect.sync(() => LIVE.delete(token)))
    const host = yield* Effect.cached(
      Effect.promise(() => DebugSession.startTime(process.pid)).pipe(
        Effect.map((startedAt) => ({ pid: process.pid, token, ...(startedAt ? { startedAt } : {}) })),
      ),
    )

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("WorkbenchInvestigation.state")(function* (ctx) {
        const data: State = { ctx, locks: new Map(), seen: new Map() }
        yield* recover(ctx)
        // Edits by the agent's tools are the patches of the running attempt.
        const off = yield* events.listen((event) =>
          event.type === FileSystem.Event.Edited.type && event.location?.directory === ctx.directory
            ? edited(ctx, String((event.data as { file?: unknown }).file ?? "")).pipe(
                Effect.provideService(InstanceRef, ctx),
                Effect.catchCause((cause) => Effect.logWarning("investigation edit not recorded", { cause })),
              )
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => off)
        return data
      }),
    )

    const load = Effect.fnUntraced(function* (projectID: string) {
      const keys = yield* storage.list(["workbench", "investigation", projectID]).pipe(Effect.orElseSucceed(() => []))
      const items = yield* Effect.forEach(keys, (item) => storage.read<unknown>(item).pipe(Effect.option), {
        concurrency: 8,
      })
      const records = items.flatMap((item) => (Option.isSome(item) ? Option.toArray(validate(item.value)) : []))
      const fallback = items.filter((item) => Option.isSome(item) && invalidPolicy(item.value)).length
      if (fallback) yield* Effect.logWarning("investigation policy invalid; using defaults", { records: fallback })
      return records
    })

    const read = Effect.fnUntraced(function* (id: string) {
      const ctx = (yield* InstanceState.get(state)).ctx
      const raw = yield* storage.read<unknown>(key(ctx.project.id, id)).pipe(Effect.option)
      const record = Option.isSome(raw) ? validate(raw.value) : Option.none()
      if (Option.isNone(record)) return yield* new DebugError({ kind: "not_found", message: `no investigation ${id}` })
      return record.value
    })

    const publish = (record: Info) =>
      events.publish(Workbench.Event.InvestigationUpdated, { investigation: summary(record) }).pipe(Effect.asVoid)

    /** Read-modify-write under the storage key lock, then publish. */
    const change = Effect.fnUntraced(function* (id: string, fn: (draft: Draft) => Workbench.Evidence | void) {
      const ctx = (yield* InstanceState.get(state)).ctx
      yield* read(id)
      const evidence: Workbench.Evidence[] = []
      const record = yield* storage
        .update<Draft>(key(ctx.project.id, id), (draft) => {
          const item = fn(draft)
          if (item) evidence.push(item)
        })
        .pipe(Effect.mapError((error) => new DebugError({ kind: "not_found", message: error.message })))
      yield* Effect.forEach(evidence, (item) => storage.write(evidenceKey(item.id), item), { discard: true }).pipe(
        Effect.orDie,
      )
      yield* publish(record)
      return record as Info
    })

    const record = Effect.fn("WorkbenchInvestigation.record")(function* (id: Workbench.InvestigationID, event: Event) {
      const data = yield* InstanceState.get(state)
      const lock = data.locks.get(id) ?? Semaphore.makeUnsafe(1)
      data.locks.set(id, lock)
      return yield* lock.withPermits(1)(change(id, (draft) => apply(draft, event, Date.now())))
    })

    const open = Effect.fn("WorkbenchInvestigation.open")(function* (input: {
      readonly sessionID: string
      readonly title: string
      readonly target?: DebugLaunch.StartInput
      readonly policy?: Workbench.RecoveryPolicy
    }) {
      const existing = yield* current(input.sessionID)
      if (existing) return existing
      const ctx = (yield* InstanceState.get(state)).ctx
      const created = create({
        projectID: ctx.project.id,
        directory: ctx.directory,
        sessionID: input.sessionID,
        title: input.title,
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.target ? { target: input.target } : {}),
        host: yield* host,
        now: Date.now(),
      })
      yield* storage.write(key(ctx.project.id, created.id), created).pipe(Effect.orDie)
      yield* publish(created)
      return created
    })

    const current = Effect.fn("WorkbenchInvestigation.current")(function* (sessionID: string) {
      const ctx = (yield* InstanceState.get(state)).ctx
      return (yield* load(ctx.project.id))
        .filter(
          (item) => item.sessionID === sessionID && item.directory === ctx.directory && !TERMINAL.includes(item.status),
        )
        .toSorted((a, b) => a.createdAt - b.createdAt)
        .at(-1)
    })

    /** Turns debug session updates into events. Deduplicated synchronously, applied in order. */
    const observe = (id: Workbench.InvestigationID) => (session: DebugSession.Session) =>
      InstanceState.get(state).pipe(
        Effect.flatMap((data) => {
          const info = session.info()
          const first = !data.seen.has(session.id)
          const seen = data.seen.get(session.id) ?? { steps: 0, processes: "" }
          data.seen.set(session.id, seen)
          const list: Event[] = first ? [{ type: "debug.started", debugSessionID: session.id }] : []
          // Start times arrive a moment after the pids; both are needed for safe cleanup after a restart.
          const processes = session.processes.map((item) => `${item.pid}:${item.startedAt ?? ""}`).join(",")
          if (processes !== seen.processes) {
            seen.processes = processes
            list.push({ type: "debug.processes", processes: [...session.processes] })
          }
          if (session.steps > seen.steps) {
            list.push({ type: "debug.steps", delta: session.steps - seen.steps })
            seen.steps = session.steps
          }
          if (info.state === "running" || info.state === "stopped") seen.ran = true
          if (info.stop && info.stop.at !== seen.stopAt) {
            seen.stopAt = info.stop.at
            list.push({ type: "debug.stopped", debugSessionID: session.id, snapshot: info.stop })
          }
          if ((info.state === "terminated" || info.state === "failed") && !seen.ended) {
            seen.ended = true
            // A failure after the program ran is an adapter crash; one during start is a launch error.
            list.push(
              info.state === "failed" && seen.ran
                ? { type: "debug.crashed", debugSessionID: session.id, error: info.error ?? "the debug adapter failed" }
                : {
                    type: "debug.ended",
                    debugSessionID: session.id,
                    ...(session.exitCode !== undefined && Number.isFinite(session.exitCode)
                      ? { exitCode: session.exitCode }
                      : {}),
                  },
            )
          }
          return Effect.forEach(list, (event) => record(id, event), { discard: true })
        }),
        Effect.catchCause((cause) => Effect.logWarning("investigation observer failed", { cause })),
      )

    const launch = Effect.fn("WorkbenchInvestigation.launch")(function* (
      id: Workbench.InvestigationID,
      spec: DebugLaunch.Spec,
      actor: DebugSession.Actor,
      limits?: Partial<DebugSession.Limits>,
    ) {
      yield* read(id)
      return yield* debug.start(spec, actor, {
        investigationID: id,
        ...(limits ? { limits } : {}),
        observe: observe(id),
      })
    })

    const note = Effect.fn("WorkbenchInvestigation.note")(function* (
      id: Workbench.InvestigationID,
      input: { kind: "hypothesis" | "question"; text: string },
    ) {
      return yield* change(id, (draft) => {
        draft.notes.push({ kind: input.kind, text: Redact.text(input.text).slice(0, 2_000), at: Date.now() })
        draft.updatedAt = Date.now()
      })
    })

    /** An explicit transition (user or escalation), checked against the table under the record lock. */
    const move = Effect.fnUntraced(function* (
      id: Workbench.InvestigationID,
      to: Status,
      why: string,
      extra?: (draft: Draft) => void,
    ) {
      const data = yield* InstanceState.get(state)
      const lock = data.locks.get(id) ?? Semaphore.makeUnsafe(1)
      data.locks.set(id, lock)
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* read(id)
          if (existing.status === to) return existing
          if (!allowed(existing.status, to)) {
            yield* Effect.logWarning("investigation transition rejected", { id, from: existing.status, to })
            return yield* new DebugError({
              kind: "invalid",
              message: `investigation ${id} cannot go from ${existing.status} to ${to}`,
            })
          }
          return yield* change(id, (draft) => {
            transition(draft, to, Date.now(), why)
            extra?.(draft)
          })
        }),
      )
    })

    const escalate = Effect.fn("WorkbenchInvestigation.escalate")(function* (
      id: Workbench.InvestigationID,
      reason: string,
    ) {
      return yield* move(id, "needs_human", `escalated: ${reason}`)
    })

    const cancel = Effect.fn("WorkbenchInvestigation.cancel")(function* (
      id: Workbench.InvestigationID,
      reason: string,
    ) {
      const record = yield* move(id, "cancelled", reason)
      yield* Effect.forEach(record.debugSessions, (item) =>
        debug.get(item).pipe(
          Effect.flatMap((session) => session.terminate(`investigation ${id} was cancelled`)),
          Effect.ignore,
        ),
      )
      return record
    })

    const resume = Effect.fn("WorkbenchInvestigation.resume")(function* (
      id: Workbench.InvestigationID,
      actor: DebugSession.Actor,
    ) {
      const existing = yield* read(id)
      if (!["interrupted", "needs_human", "blocked"].includes(existing.status))
        return yield* new DebugError({
          kind: "invalid",
          message: `investigation ${id} is ${existing.status}, not waiting to resume`,
        })
      if (!existing.target)
        return yield* new DebugError({
          kind: "invalid",
          message: `investigation ${id} has no stored target to relaunch`,
        })
      const spec = yield* debug.prepare(existing.target)
      // blocked only leads to needs_human; the user taking it over is that step.
      if (existing.status === "blocked") yield* move(id, "needs_human", `taken over by the ${actor.by}`)
      yield* move(id, "reproducing", `resumed by the ${actor.by}`, (draft) => {
        // A resume starts a fresh budget window for steps and time.
        draft.steps = 0
        draft.since = Date.now()
      })
      yield* launch(id, spec, actor)
      return yield* read(id)
    })

    const list = Effect.fn("WorkbenchInvestigation.list")(function* () {
      const ctx = (yield* InstanceState.get(state)).ctx
      return (yield* load(ctx.project.id)).toSorted((a, b) => b.updatedAt - a.updatedAt).map(summary)
    })

    const get = Effect.fn("WorkbenchInvestigation.get")(function* (id: string) {
      return yield* read(id)
    })

    const full = Effect.fn("WorkbenchInvestigation.full")(function* (id: string) {
      const investigation = yield* read(id)
      const evidence = yield* Effect.forEach(investigation.evidence, (item) =>
        storage.read<Workbench.Evidence>(evidenceKey(item)).pipe(Effect.option),
      )
      const items = evidence.flatMap((item) => Option.toArray(item))
      return { investigation, evidence: items, report: report(investigation, items) }
    })

    /**
     * Active records whose owner is gone become interrupted, and their recorded processes are killed when pid and
     * start time still match (a reused pid is left alone). Nothing is relaunched.
     */
    const recoverRecords = Effect.fnUntraced(function* (records: readonly Info[], boot: boolean) {
      const self = yield* host
      for (const item of records.filter((record) => ACTIVE.includes(record.status))) {
        // At boot, anything this service instance already owns was created after the scan started: it is live.
        // On an instance load, our own records are from before a reload, whose debug sessions died with it.
        if (
          item.host.pid === self.pid && item.host.token === self.token
            ? boot
            : yield* Effect.promise(() => owned(item.host, self))
        )
          continue
        const killed = yield* Effect.promise(() => cleanup(item.processes))
        const updated = yield* storage
          .update<Draft>(key(item.projectID, item.id), (draft) => {
            // Boot recovery and an instance load can race (the first one wins), and the record may have changed
            // owner since it was read (a resume): only the snapshot's owner is replaced.
            if (
              !ACTIVE.includes(draft.status) ||
              draft.host.pid !== item.host.pid ||
              draft.host.token !== item.host.token
            )
              return
            transition(
              draft,
              "interrupted",
              Date.now(),
              `the app restarted${killed.length ? `; killed ${killed.join(", ")}` : ""}`,
            )
            draft.host = { ...self }
          })
          .pipe(Effect.option)
        if (Option.isSome(updated)) yield* publish(updated.value as Info)
      }
    })

    // On instance load (also after an instance reload in this process): this directory's records.
    const recover = Effect.fnUntraced(function* (ctx: InstanceContext) {
      yield* recoverRecords(
        (yield* load(ctx.project.id)).filter((item) => item.directory === ctx.directory),
        false,
      )
    })

    // Once per server start: every project's records, before any project is opened.
    yield* Effect.gen(function* () {
      const keys = yield* storage.list(["workbench", "investigation"]).pipe(Effect.orElseSucceed(() => []))
      const items = yield* Effect.forEach(keys, (item) => storage.read<unknown>(item).pipe(Effect.option), {
        concurrency: 8,
      })
      yield* recoverRecords(
        items.flatMap((item) => (Option.isSome(item) ? Option.toArray(validate(item.value)) : [])),
        true,
      )
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("investigation boot recovery failed", { cause })),
      Effect.forkScoped,
    )

    // Runs inside the edit tool's publish, so the patch is recorded before the turn-end check runs.
    const edited = Effect.fnUntraced(function* (ctx: InstanceContext, file: string) {
      if (!file) return
      const active = (yield* load(ctx.project.id)).filter(
        (item) =>
          item.directory === ctx.directory &&
          ["reproducing", "debugging", "diagnosing", "patching", "verifying"].includes(item.status),
      )
      if (!active.length) return
      const hash = yield* Effect.promise(() =>
        Bun.file(file)
          .arrayBuffer()
          .then(
            (buffer) => new Bun.CryptoHasher("sha256").update(buffer).digest("hex"),
            () => "deleted",
          ),
      )
      yield* Effect.forEach(active, (item) => record(item.id, { type: "patch", file, hash }), { discard: true })
    })

    const verified = Effect.fn("WorkbenchInvestigation.verified")(
      function* (sessionID: string, report: Workbench.VerificationReport, problems: readonly Found[]) {
        const open = yield* current(sessionID)
        if (!open) return undefined
        const runs = report.checks.map((check) => check.run)
        const tests = runs.filter((run) => run.kind === "test")
        // A skipped, timed-out, unavailable or cancelled run is never a pass; neither is a report with no runs.
        yield* record(open.id, {
          type: "check",
          passed: runs.length > 0 && runs.every((run) => run.status === "passed"),
          runIDs: runs.map((run) => run.id),
          // The errors repairs are about: in changed files (or without a file), as the gate counts them.
          problems: problems
            .filter((item) => item.severity === "error" && item.new)
            .map((item) => ({
              tool: item.tool,
              message: item.message,
              ...(item.code !== undefined ? { code: item.code } : {}),
              ...(item.file ? { file: item.file } : {}),
            })),
          unverified: report.unverifiedFiles,
        })
        if (!tests.length) return yield* get(open.id)
        // A test run is the reproduction for a bug a failing test shows.
        const passed = tests.every((run) => run.status === "passed")
        yield* record(open.id, {
          type: "repro",
          passed,
          summary: `${tests.length} test run${tests.length === 1 ? "" : "s"} ${passed ? "passed" : "did not pass"} (${tests.map((run) => `${run.checker} ${run.status}`).join(", ")})`,
          runID: tests[0].id,
        })
        return yield* get(open.id)
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("verification not recorded on the investigation", { cause }).pipe(Effect.as(undefined)),
      ),
    )

    const halted = Effect.fn("WorkbenchInvestigation.halted")(function* (sessionID: string) {
      const open = yield* current(sessionID)
      if (!open || (open.status !== "blocked" && open.status !== "needs_human")) return undefined
      return `investigation ${open.id} is ${open.status}${open.checkpoints.at(-1)?.reason ? `: ${open.checkpoints.at(-1)?.reason}` : ""}`
    })

    return Service.of({
      list,
      get,
      full,
      open,
      current,
      launch,
      record,
      note,
      escalate,
      resume,
      cancel,
      verified,
      halted,
    })
  }),
)

/** A new record in status created. */
export function create(input: {
  readonly projectID: string
  readonly directory: string
  readonly sessionID?: string
  readonly title: string
  readonly policy?: Workbench.RecoveryPolicy
  readonly target?: DebugLaunch.StartInput
  readonly host: Info["host"]
  readonly now: number
}): Info {
  return {
    id: Workbench.InvestigationID.create(),
    projectID: input.projectID,
    directory: input.directory,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    title: input.title.slice(0, 200),
    status: "created",
    policy: input.policy ?? DEFAULT_POLICY,
    ...(input.target ? { target: input.target } : {}),
    attempts: [],
    evidence: [],
    notes: [],
    checkpoints: [{ status: "created", at: input.now }],
    processes: [],
    debugSessions: [],
    steps: 0,
    crashes: 0,
    since: input.now,
    seq: 0,
    unverified: [],
    host: input.host,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

/** Applies one event to a record: bookkeeping, evidence, supervisor, derived status. Returns new evidence. */
export function apply(draft: Draft, event: Event, now: number): Workbench.Evidence | undefined {
  draft.seq++
  draft.updatedAt = now
  const evidence = observe(draft, event, now)
  if (evidence) draft.evidence.push(evidence.id)
  const decision = Supervisor.supervise(
    { policy: draft.policy, attempts: draft.attempts, steps: draft.steps, crashes: draft.crashes, since: draft.since },
    trigger(event),
    now,
    event.type === "permission.denied" ? event.permission : undefined,
  )
  if (decision && allowed(draft.status, decision.status)) {
    transition(draft, decision.status, now, `${decision.rule}: ${decision.reason}`, evidence?.id)
    return evidence
  }
  for (const to of derive(draft, event))
    if (to !== draft.status && allowed(draft.status, to)) transition(draft, to, now, reason(event, to), evidence?.id)
  return evidence
}

function trigger(event: Event): Supervisor.Trigger {
  if (event.type === "patch" || event.type === "check") return event.type
  if (event.type === "debug.crashed") return "crash"
  if (event.type === "permission.denied") return "permission"
  if (event.type === "debug.steps") return "steps"
  return "other"
}

function observe(draft: Draft, event: Event, now: number): Workbench.Evidence | undefined {
  const base = (kind: Workbench.Evidence["kind"], summary: string, data: unknown, verified = false) => ({
    id: Workbench.EvidenceID.create(),
    investigationID: draft.id,
    kind,
    class: verified ? ("verified" as const) : ("observed" as const),
    summary: DebugSnapshot.cap(Redact.text(summary), 300),
    data: bounded(data),
    at: now,
  })
  const afterPatch = draft.lastPatch !== undefined
  if (event.type === "debug.started") {
    if (!draft.debugSessions.includes(event.debugSessionID)) draft.debugSessions.push(event.debugSessionID)
    return undefined
  }
  if (event.type === "debug.processes") {
    draft.processes = [
      ...draft.processes.filter((entry) => !event.processes.some((item) => item.pid === entry.pid)),
      ...event.processes.map((item) => ({
        pid: item.pid,
        command: item.command,
        ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      })),
    ]
    return undefined
  }
  if (event.type === "debug.steps") {
    draft.steps += event.delta
    return undefined
  }
  if (event.type === "debug.crashed") {
    draft.crashes++
    return undefined
  }
  if (event.type === "permission.denied") return undefined
  if (event.type === "debug.stopped") {
    const top = event.snapshot.frames[0]
    const at = top ? ` at ${top.file ?? "?"}:${top.line ?? "?"} in ${top.name}` : ""
    return {
      ...base(
        event.snapshot.exception ? "exception" : "debug-stop",
        event.snapshot.exception
          ? `${[event.snapshot.exception.id, event.snapshot.exception.description].filter(Boolean).join(": ")}${at}`
          : `${event.snapshot.reason}${at}`,
        event.snapshot,
      ),
      refs: { debugSessionID: event.debugSessionID },
    }
  }
  if (event.type === "console.eval")
    return {
      ...base("console-eval", `${event.expression} → ${event.result}`, {
        expression: event.expression,
        result: event.result,
      }),
      refs: { debugSessionID: event.debugSessionID },
    }
  if (event.type === "debug.ended" || event.type === "repro") {
    const passed = event.type === "repro" ? event.passed : event.exitCode === 0
    if (event.type === "debug.ended" && event.exitCode === undefined) return undefined
    if (passed && afterPatch) draft.reproPassed = draft.seq
    const summary =
      event.type === "repro" ? event.summary : `program run under the debugger exited with code ${event.exitCode}`
    return {
      ...base(
        "repro-run",
        summary,
        event.type === "repro" ? { passed } : { exitCode: event.exitCode },
        passed && afterPatch,
      ),
      refs:
        event.type === "repro" ? (event.runID ? { runID: event.runID } : {}) : { debugSessionID: event.debugSessionID },
    }
  }
  if (event.type === "patch") {
    const open = draft.attempts.at(-1)
    const attempt =
      open && open.passed === undefined
        ? open
        : (() => {
            const next = {
              n: draft.attempts.length + 1,
              patchHash: "",
              changes: [],
              errorFingerprints: [],
              errorCount: 0,
              checkIDs: [],
              at: now,
            }
            draft.attempts.push(next)
            return draft.attempts.at(-1)!
          })()
    attempt.changes = [
      ...attempt.changes.filter((item) => item.file !== event.file),
      { file: event.file, hash: event.hash },
    ].toSorted((a, b) => a.file.localeCompare(b.file))
    attempt.patchHash = new Bun.CryptoHasher("sha256")
      .update(attempt.changes.map((item) => `${item.file}:${item.hash}`).join("\n"))
      .digest("hex")
    draft.lastPatch = draft.seq
    return base("patch", `edited ${event.file}`, { file: event.file, hash: event.hash, attempt: attempt.n })
  }
  const attempt = draft.attempts.at(-1)
  const fingerprints = [...new Set(event.problems.map(Supervisor.fingerprint))]
  if (attempt && attempt.passed === undefined) {
    attempt.passed = event.passed
    attempt.errorFingerprints = fingerprints
    attempt.errorCount = event.problems.length
    attempt.checkIDs = [...event.runIDs]
  }
  if (event.passed && afterPatch) draft.checkPassed = draft.seq
  draft.unverified = [...(event.unverified ?? [])]
  return {
    ...base(
      "check-run",
      event.passed
        ? `checks passed (${event.runIDs.join(", ")})`
        : `checks failed with ${event.problems.length} errors (${event.runIDs.join(", ")})`,
      { runIDs: event.runIDs, problems: event.problems.slice(0, 20) },
      event.passed && afterPatch,
    ),
    ...(event.runIDs[0] ? { refs: { runID: Workbench.RunID.make(event.runIDs[0]) } } : {}),
  }
}

/** Status the event implies, in order. Applied only where the transition table allows it. */
function derive(draft: Draft, event: Event): Status[] {
  const resolved =
    draft.lastPatch !== undefined &&
    (draft.checkPassed ?? -1) > draft.lastPatch &&
    (draft.reproPassed ?? -1) > draft.lastPatch
  if (event.type === "debug.started") return ["reproducing"]
  if (event.type === "debug.stopped") return [event.snapshot.exception ? "diagnosing" : "debugging"]
  if (event.type === "patch") return ["patching"]
  if (event.type === "check") return resolved ? ["verifying", "resolved"] : ["verifying"]
  if (event.type === "debug.ended" || event.type === "repro") {
    const passed = event.type === "repro" ? event.passed : event.exitCode === 0
    if (event.type === "debug.ended" && event.exitCode === undefined) return []
    return passed ? (resolved ? ["resolved"] : []) : ["diagnosing"]
  }
  return []
}

function reason(event: Event, to: Status) {
  if (to === "resolved") return "the reproduction and the checks passed after the last patch"
  if (event.type === "debug.started") return "debug session started"
  if (event.type === "debug.stopped") return event.snapshot.exception ? "exception observed" : "program stopped"
  if (event.type === "patch") return `edited ${event.file}`
  if (event.type === "check") return event.passed ? "checks passed" : "checks failed"
  if (event.type === "debug.ended" || event.type === "repro") return "reproduction failed"
  return event.type
}

function transition(draft: Draft, to: Status, now: number, why?: string, evidenceID?: Workbench.EvidenceID) {
  draft.status = to
  draft.updatedAt = now
  draft.checkpoints.push({
    status: to,
    at: now,
    ...(why ? { reason: why } : {}),
    ...(evidenceID ? { evidenceID } : {}),
  })
}

function bounded(data: unknown) {
  const redacted = Redact.deep(data)
  const text = JSON.stringify(redacted) ?? ""
  return text.length <= 16_000 ? redacted : `${text.slice(0, 15_999)}…`
}

/** Validates a stored record; an invalid policy falls back to the defaults (load logs a warning). */
function validate(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return Option.none<Info>()
  const policy = decodePolicy((raw as { policy?: unknown }).policy)
  return decodeRecord({ ...raw, policy: Option.getOrElse(policy, () => DEFAULT_POLICY) })
}

function invalidPolicy(raw: unknown) {
  return typeof raw === "object" && raw !== null && Option.isNone(decodePolicy((raw as { policy?: unknown }).policy))
}

export function summary(record: Info): Workbench.InvestigationSummary {
  const reason = record.checkpoints.findLast((item) => item.reason)?.reason
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    ...(record.sessionID ? { sessionID: record.sessionID } : {}),
    ...(record.agentID ? { agentID: record.agentID } : {}),
    attempts: record.attempts.length,
    evidenceCount: record.evidence.length,
    ...(reason ? { reason } : {}),
    updatedAt: record.updatedAt,
  }
}

/** The final report: observed, inferred, verified and unverified items, each with its ID. */
export function report(record: Info, evidence: readonly Workbench.Evidence[]) {
  const line = (item: Workbench.Evidence) => `  ${item.id} ${item.kind}: ${item.summary}`
  const latest = record.checkpoints.at(-1)
  const patched = [...new Set(record.attempts.flatMap((item) => item.changes.map((entry) => entry.file)))]
  const verifiedAfterPatch = record.lastPatch !== undefined && (record.checkPassed ?? -1) > record.lastPatch
  const unverified = [...new Set([...record.unverified, ...(verifiedAfterPatch ? [] : patched)])].toSorted()
  const section = (title: string, items: string[]) => [title, ...(items.length ? items : ["  (none)"])]
  return [
    `Investigation ${record.id}: ${record.title}`,
    `Status: ${record.status}${latest?.reason ? ` (${latest.reason})` : ""}`,
    `Attempts: ${record.attempts.length} · debug steps: ${record.steps} · evidence: ${evidence.length}`,
    "",
    ...section("Observed", evidence.filter((item) => item.class === "observed").map(line)),
    "",
    ...section(
      "Inferred (agent notes, not evidence)",
      record.notes.map((item, index) => `  note-${index + 1} ${item.kind}: ${item.text}`),
    ),
    "",
    ...section("Verified", evidence.filter((item) => item.class === "verified").map(line)),
    "",
    ...section(
      "Unverified",
      unverified.map((file) => `  ${file}: not covered by a passing check`),
    ),
  ].join("\n")
}

/**
 * Whether a record's owner still runs: another service instance in this process (its token is live), or another
 * process whose pid has the recorded start time. A live pid with an unknown start time counts as running.
 */
async function owned(owner: Info["host"], self: { pid: number; token: string }) {
  if (owner.pid === self.pid) return owner.token !== undefined && owner.token !== self.token && LIVE.has(owner.token)
  const started = await DebugSession.startTime(owner.pid)
  if (started === undefined) return false
  return owner.startedAt === undefined || started === owner.startedAt
}

/** Kills recorded processes whose start time still matches; a reused pid is left alone. */
async function cleanup(processes: Info["processes"]) {
  const matching = await Promise.all(
    processes.map(async (item) => {
      const now = await DebugSession.startTime(item.pid)
      return now !== undefined && item.startedAt !== undefined && now === item.startedAt ? item.pid : undefined
    }),
  )
  const pids = matching.filter((item): item is number => item !== undefined)
  await DebugSession.kill(pids)
  return pids
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Storage.node, EventV2Bridge.node, WorkbenchDebug.node],
})

export * as WorkbenchInvestigation from "./investigation"
