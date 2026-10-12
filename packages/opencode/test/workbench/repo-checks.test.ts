import { describe, expect } from "bun:test"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ConfigWorkbenchV1 } from "@opencode-ai/core/v1/config/workbench"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { resetDatabase } from "../fixture/db"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { write } from "../fixture/workbench/zoo"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

// VER-07: check commands defined in the repository's configuration (workbench.checks). The command is a small
// script that records each run in `ran` and fails through ordinary exits; nothing crashes.
const script = `const fs = require("fs")
fs.appendFileSync("ran", process.argv[2] + "\\n")
if (process.argv[2] === "problems") {
  console.log("src/a.txt:2:5: error: bad thing")
  console.log("src/a.txt:4: warning: odd thing")
  process.exit(1)
}
if (process.argv[2] === "silent") {
  console.error("the tool fell over before printing anything useful")
  process.exit(3)
}
if (process.argv[2] === "slow") {
  const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  })
  fs.writeFileSync("child", String(child.pid))
  setTimeout(() => {}, 30000)
}
`
const files = { "check.js": script, "src/a.txt": "one\ntwo\nthree\nfour\n" }
const check = (mode: string, format: ConfigWorkbenchV1.Format = "plain"): ConfigWorkbenchV1.Check => ({
  command: [process.execPath, "check.js", mode],
  files: ["src/**/*.txt"],
  format,
})
const config = (checks: Record<string, ConfigWorkbenchV1.Check>, allow = false): Partial<ConfigV1.Info> => ({
  workbench: { checks },
  ...(allow ? { permission: { "verify.exec": "allow" } } : {}),
})

const engine = testEffect(
  LayerNode.compile(
    LayerNode.group([WorkbenchVerify.node, WorkbenchProblems.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
  ),
)
const none = () => Effect.succeed([] as string[])
const all = (units: ReadonlyArray<string>) => Effect.succeed([...units])

const runs = (result: WorkbenchVerify.Result) =>
  result.report.checks.map((item) => [item.run.checker, item.run.execClass, item.run.status, item.run.reason])

const ran = (dir: string) =>
  Effect.promise(() =>
    Bun.file(path.join(dir, "ran"))
      .text()
      .catch(() => ""),
  )

describe("VER-07 repository check commands", () => {
  engine.instance(
    "default rules: an exec-class repository check is skipped as needing approval and never runs",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() => write(dir, files))
        const verify = yield* WorkbenchVerify.Service
        const result = yield* verify.run({ files: ["src/a.txt"], trigger: "turn-end", approve: none })
        expect(runs(result)).toEqual([["lint", "exec", "skipped", "needs approval (verify.exec)"]])
        expect(result.report.checks[0].run.startedAt).toBeUndefined()
        expect(result.report.unverifiedFiles).toEqual([path.join(dir, "src/a.txt")])
        expect(yield* ran(dir)).toBe("")
      }),
    { config: config({ lint: check("problems") }) },
  )

  engine.instance(
    "approved: the command runs once and its output is parsed into problems",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() => write(dir, files))
        const verify = yield* WorkbenchVerify.Service
        const asked: string[] = []
        const result = yield* verify.run({
          files: ["src/a.txt"],
          trigger: "agent",
          approve: (units) =>
            Effect.sync(() => {
              asked.push(...units)
              return [...units]
            }),
        })
        expect(asked).toEqual([dir])
        expect(runs(result)).toEqual([["lint", "exec", "failed", undefined]])
        expect(result.problems).toEqual([
          {
            file: path.join(dir, "src/a.txt"),
            range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } },
            severity: "error",
            message: "bad thing",
            tool: "lint",
            new: true,
          },
          {
            file: path.join(dir, "src/a.txt"),
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
            severity: "warning",
            message: "odd thing",
            tool: "lint",
            new: true,
          },
        ])
        expect(yield* ran(dir)).toBe("problems\n")

        const problems = yield* WorkbenchProblems.Service
        const snapshot = yield* problems.snapshot()
        expect(snapshot.problems.map((item) => [item.source.producer, item.source.kind, item.message])).toEqual([
          [`check:lint:${dir}`, "build", "bad thing"],
          [`check:lint:${dir}`, "build", "odd thing"],
        ])
        expect((yield* verify.runs()).map((item) => item.checker)).toContain("lint")
      }),
    { config: config({ lint: check("problems") }) },
  )

  engine.instance(
    "a failing command with nothing parseable is failed with the output tail, never a pass",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() => write(dir, files))
        const verify = yield* WorkbenchVerify.Service
        const result = yield* verify.run({ files: ["src/a.txt"], trigger: "agent", approve: all })
        expect(runs(result)).toEqual([["broken", "exec", "failed", undefined]])
        expect(result.report.checks[0].run.exitCode).toBe(3)
        expect(result.problems).toMatchObject([
          {
            severity: "error",
            message: "broken exited with code 3\nthe tool fell over before printing anything useful",
          },
        ])
        expect(result.report.summary).toMatchObject({ passed: 0, failed: 1 })
      }),
    { config: config({ broken: check("silent") }) },
  )

  engine.instance(
    "same budget and process-tree kill as built-in checks",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() => write(dir, files))
        const verify = yield* WorkbenchVerify.Service
        const result = yield* verify.run({ files: ["src/a.txt"], trigger: "agent", approve: all, budgetMs: 1500 })
        expect(runs(result)).toEqual([["slow", "exec", "timed_out", "budget"]])
        expect(result.report.summary.passed).toBe(0)
        // the command's own child went down with it (process-group kill)
        const child = Number(yield* Effect.promise(() => Bun.file(path.join(dir, "child")).text()))
        yield* pollWithTimeout(
          Effect.try({ try: () => process.kill(child, 0), catch: () => "gone" }).pipe(
            Effect.as(undefined),
            Effect.orElseSucceed(() => true),
          ),
          "the check command's child process survived the timeout",
        )
      }),
    { config: config({ slow: check("slow") }) },
  )

  engine.instance(
    "files outside the check's globs do not trigger it, and test formats wait for tests",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() => write(dir, { ...files, "notes.md": "x\n" }))
        const verify = yield* WorkbenchVerify.Service
        expect(runs(yield* verify.run({ files: ["notes.md"], trigger: "agent", approve: all }))).toEqual([])
        expect(runs(yield* verify.run({ files: ["src/a.txt"], trigger: "agent", approve: all }))).toEqual([])
        expect(
          (yield* verify.run({ files: ["src/a.txt"], trigger: "agent", approve: all, tests: true })).report.checks.map(
            (item) => [item.run.checker, item.run.kind],
          ),
        ).toEqual([["unit", "test"]])
      }),
    { config: config({ unit: check("problems", "junit") }) },
  )

  engine.instance("the doctor lists repository checks without running them", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, files))
      const section = yield* Effect.promise(() =>
        WorkbenchCheckers.doctor(
          {
            lint: check("problems"),
            gone: { command: ["opencode-no-such-check-command"], format: "plain" },
          },
          dir,
        ),
      )
      expect(section).toEqual({
        id: "repo",
        name: "Repository checks",
        lsp: { server: "none", enabled: false, reason: "defined in workbench.checks" },
        probes: [
          {
            area: "check",
            tool: "lint",
            status: "ok",
            path: process.execPath,
            reason: "repository command: runs after verify.exec approval",
          },
          {
            area: "check",
            tool: "gone",
            status: "missing",
            path: undefined,
            reason: "opencode-no-such-check-command not found",
          },
        ],
      })
      expect(yield* ran(dir)).toBe("")
    }),
  )
})

// Through the server: POST /workbench/check, the run list and the doctor.
const http = testEffect(
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.promise(() => resetDatabase()),
        () => Effect.promise(() => resetDatabase()),
      ),
    ),
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    httpApiLayer,
  ),
)

const call = (dir: string, route: string, body?: unknown) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(
      route,
      dir,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    )
    return JSON.parse(yield* response.text) as unknown
  })

describe("VER-07 repository checks over HTTP", () => {
  http.live("an agent's check skips them by default; loading config, problems and the doctor never runs them", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: config({ lint: check("problems") }) })
      yield* Effect.promise(() => write(dir, files))
      const doctor = (yield* call(dir, "/workbench/doctor")) as { languages: { id: string; probes: unknown[] }[] }
      expect(doctor.languages.find((item) => item.id === "repo")?.probes).toMatchObject([
        { area: "check", tool: "lint", status: "ok" },
      ])
      yield* call(dir, "/workbench/problems")
      expect(yield* ran(dir)).toBe("")

      const report = (yield* call(dir, "/workbench/check", {
        files: ["src/a.txt"],
        trigger: "agent",
      })) as Workbench.VerificationReport
      expect(report.checks.map((item) => [item.run.checker, item.run.status, item.run.reason])).toEqual([
        ["lint", "skipped", "needs approval in the IDE"],
      ])
      expect(yield* ran(dir)).toBe("")
    }),
  )

  http.live("with verify.exec allowed it runs, and the run appears in the run list with its output", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: config({ lint: check("problems") }, true) })
      yield* Effect.promise(() => write(dir, files))
      const report = (yield* call(dir, "/workbench/check", {
        files: ["src/a.txt"],
        trigger: "agent",
      })) as Workbench.VerificationReport
      expect(report.checks.map((item) => [item.run.checker, item.run.execClass, item.run.status])).toEqual([
        ["lint", "exec", "failed"],
      ])
      const id = report.checks[0].run.id
      expect(((yield* call(dir, "/workbench/runs")) as Workbench.RunInfo[])[0]).toMatchObject({ id, checker: "lint" })
      const record = (yield* call(dir, `/workbench/runs/${id}`)) as { output: string }
      expect(record.output).toContain("src/a.txt:2:5: error: bad thing")
      const problems = (yield* call(dir, "/workbench/problems?source=build")) as Workbench.ProblemsSnapshot
      expect(problems.problems.map((item) => item.message)).toEqual(["bad thing", "odd thing"])
    }),
  )
})
