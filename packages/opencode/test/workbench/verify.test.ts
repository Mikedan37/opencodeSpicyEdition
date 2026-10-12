import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { which } from "@opencode-ai/core/util/which"
import { Effect } from "effect"
import { Workbench } from "@opencode-ai/schema/workbench"
import { EventV2Bridge } from "@/event-v2-bridge"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { TestInstance } from "../fixture/fixture"
import { write, zoo } from "../fixture/workbench/zoo"
import { pollWithTimeout, testEffect } from "../lib/effect"

const graph = LayerNode.group([
  WorkbenchVerify.node,
  WorkbenchProblems.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(LayerNode.compile(graph))

// Stand-in checkers that run real processes through the real runner.
const sleepy: WorkbenchCheckers.Info = {
  id: "sleepy",
  kind: "typecheck",
  extensions: [".slow"],
  unit: async (file) => path.dirname(file),
  plan: async (unit) => ({
    command: [
      process.execPath,
      "-e",
      "require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 20000)",
    ],
    cwd: unit.root,
    execClass: "inert",
  }),
  parse: () => [],
}
const absent: WorkbenchCheckers.Info = {
  ...sleepy,
  id: "absent",
  extensions: [".nope"],
  plan: async () => ({ unavailable: "absent-checker not found" }),
}
const ghost: WorkbenchCheckers.Info = {
  ...sleepy,
  id: "ghost",
  extensions: [".ghost"],
  plan: async (unit) => ({ command: ["opencode-no-such-checker-binary"], cwd: unit.root, execClass: "inert" }),
}
const chatty: WorkbenchCheckers.Info = {
  ...sleepy,
  id: "chatty",
  extensions: [".talk"],
  plan: async (unit) => ({
    command: [process.execPath, "-e", "console.log('hello from the checker'); console.error('and stderr')"],
    cwd: unit.root,
    execClass: "inert",
  }),
}
const fakes = testEffect(
  LayerNode.compile(graph, [[WorkbenchVerify.node, WorkbenchVerify.nodeFor([sleepy, absent, ghost, chatty])]]),
)

// Real-toolchain tests skip when the tool is missing; the test name says which tool.
const needs = (...tools: string[]) => (tools.every((tool) => which(tool)) ? it.instance : it.instance.skip)
const none = () => Effect.succeed([] as string[])

const run = Effect.fn("VerifyTest.run")(function* (
  files: string[],
  approve: WorkbenchVerify.Input["approve"] = none,
  budgetMs?: number,
) {
  const verify = yield* WorkbenchVerify.Service
  return yield* verify.run({ files, trigger: "agent", approve, budgetMs })
})

const checks = (result: WorkbenchVerify.Result, dir: string) =>
  result.report.checks.map((check) => [check.run.checker, path.relative(dir, check.run.unit), check.run.status])

describe("workbench verification engine", () => {
  needs("clang")("VER-02 [clang] a C program that type-checks but does not link fails", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo["link-c"]))
      const file = path.join(dir, "main.c")
      const result = yield* run([file])

      expect(checks(result, dir)).toEqual([["clang", "", "failed"]])
      expect(result.report.checks[0].run.command).toContain("-o")
      expect(result.report.checks[0].newErrors).toBe(1)
      expect(result.problems).toMatchObject([{ kind: "build", code: "link", severity: "error", tool: "clang" }])
      expect(result.report.summary).toEqual({ passed: 0, failed: 1, skipped: 0, unavailable: 0, timedOut: 0 })
      expect(result.report.unverifiedFiles).toEqual([file])

      const problems = yield* WorkbenchProblems.Service
      const snapshot = yield* problems.snapshot()
      expect(snapshot.problems).toMatchObject([
        { severity: "error", code: "link", source: { kind: "build", tool: "clang", producer: `check:clang:${dir}` } },
      ])
    }),
  )

  needs("clang")("VER-02 [clang] the same program with the function defined passes", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() =>
        write(dir, { "main.c": "int helper(int x) { return x; }\n\nint main(void) { return helper(0); }\n" }),
      )
      const result = yield* run([path.join(dir, "main.c")])
      expect(checks(result, dir)).toEqual([["clang", "", "passed"]])
      expect(result.report.unverifiedFiles).toEqual([])
    }),
  )

  needs("clang")("[clang] a compile_commands.json entry is its own unit and keeps its flags", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const file = path.join(dir, "src/main.c")
      yield* Effect.promise(() =>
        write(dir, {
          "src/main.c": "#ifndef FROM_DB\n#error FROM_DB missing\n#endif\nint main(void) { return 0; }\n",
          "compile_commands.json": JSON.stringify([
            {
              directory: dir,
              file: "src/main.c",
              arguments: ["clang", "-DFROM_DB", "-c", "src/main.c", "-o", "main.o"],
            },
          ]),
        }),
      )
      const result = yield* run([file])
      expect(checks(result, dir)).toEqual([["clang", "src/main.c", "passed"]])
      const command = result.report.checks[0].run.command
      expect(command).toContain("-DFROM_DB")
      expect(command).toContain("-fsyntax-only")
      expect(command).not.toContain("-o")
      expect(command).not.toContain("-c")
    }),
  )

  needs("tsc")("VER-03 [tsc] an edit in one TS project runs only that project", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo.mono))
      const result = yield* run([path.join(dir, "web/src/app.ts")])
      expect(checks(result, dir)).toEqual([["tsc", "web/tsconfig.json", "passed"]])
    }),
  )

  needs("go")("VER-03 [go] an edit in one Go module runs only that package", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo.mono))
      const result = yield* run([path.join(dir, "svc-a/main.go")])
      expect(checks(result, dir)).toEqual([
        ["go", "svc-a", "passed"],
        ["go-vet", "svc-a", "passed"],
      ])
    }),
  )

  needs("cargo")("VER-03 [cargo] an edit in one workspace crate checks only that crate", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo.mono))
      const result = yield* run([path.join(dir, "crates/one/src/lib.rs")])
      expect(checks(result, dir)).toEqual([["cargo", "crates/one", "passed"]])
      expect(result.report.checks[0].run.command.slice(-2)).toEqual(["-p", "one"])
      expect(result.report.checks[0].run.execClass).toBe("inert")
    }),
  )

  it.instance("VER-03 unit mapping keeps nested projects apart", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo.mono))
      const units = yield* Effect.promise(() =>
        Promise.all([
          WorkbenchCheckers.tsc.unit(path.join(dir, "web/src/app.ts"), dir),
          WorkbenchCheckers.tsc.unit(path.join(dir, "api/src/server.ts"), dir),
          WorkbenchCheckers.go.unit(path.join(dir, "svc-b/main.go"), dir),
          WorkbenchCheckers.cargo.unit(path.join(dir, "crates/two/src/lib.rs"), dir),
          WorkbenchCheckers.tsc.unit(path.join(dir, "loose.ts"), dir),
        ]),
      )
      expect(units).toEqual([
        path.join(dir, "web/tsconfig.json"),
        path.join(dir, "api/tsconfig.json"),
        path.join(dir, "svc-b"),
        path.join(dir, "crates/two"),
        undefined,
      ])
    }),
  )

  fakes.instance("VER-04 runs over budget are timed out, later units are skipped, nothing passes", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const files = ["a", "b", "c"].map((name) => path.join(dir, name, "x.slow"))
      yield* Effect.promise(() => write(dir, { "a/x.slow": "", "b/x.slow": "", "c/x.slow": "" }))
      const started = Date.now()
      const result = yield* run(files, none, 500)

      expect(Date.now() - started).toBeLessThan(10_000)
      expect(result.report.checks.map((check) => [check.run.status, check.run.reason])).toEqual([
        ["timed_out", "budget"],
        ["timed_out", "budget"],
        ["skipped", "budget"],
      ])
      expect(result.report.summary).toEqual({ passed: 0, failed: 0, skipped: 1, unavailable: 0, timedOut: 2 })
      expect(result.report.unverifiedFiles).toEqual(files)
      // the timed-out checkers were killed, not left running
      for (const name of ["a", "b"]) {
        const pid = Number(yield* Effect.promise(() => Bun.file(path.join(dir, name, "pid")).text()))
        expect(() => process.kill(pid, 0)).toThrow()
      }
    }),
  )

  fakes.instance("VER-05 a missing checker is unavailable with the reason and its files stay unverified", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, { "x.nope": "", "y.ghost": "" }))
      const result = yield* run([path.join(dir, "x.nope"), path.join(dir, "y.ghost")])

      expect(result.report.checks.map((check) => [check.run.checker, check.run.status])).toEqual([
        ["absent", "unavailable"],
        ["ghost", "unavailable"],
      ])
      expect(result.report.checks[0].run.reason).toBe("absent-checker not found")
      expect(result.report.checks[1].run.reason).toContain("opencode-no-such-checker-binary")
      expect(result.report.summary).toEqual({ passed: 0, failed: 0, skipped: 0, unavailable: 2, timedOut: 0 })
      expect(result.report.unverifiedFiles).toEqual([path.join(dir, "x.nope"), path.join(dir, "y.ghost")])

      const problems = yield* WorkbenchProblems.Service
      const snapshot = yield* problems.snapshot()
      expect(snapshot.producers.find((item) => item.producer === `check:absent:${dir}`)).toMatchObject({
        state: "unavailable",
        reason: "absent-checker not found",
      })
    }),
  )

  fakes.instance("a run publishes workbench.run.updated and streams workbench.run.output", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, { "x.talk": "" }))
      const events = yield* EventV2Bridge.Service
      const runs: Workbench.RunInfo[] = []
      const output: { runID: string; seq: number; chunk: string }[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Workbench.Event.RunUpdated.type) runs.push((event.data as { run: Workbench.RunInfo }).run)
          if (event.type === Workbench.Event.RunOutput.type)
            output.push(event.data as { runID: string; seq: number; chunk: string })
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const result = yield* run([path.join(dir, "x.talk")])
      const id = result.report.checks[0].run.id
      yield* pollWithTimeout(
        Effect.sync(() => (runs.some((item) => item.status === "passed") ? true : undefined)),
        "final workbench.run.updated never arrived",
      )
      expect(runs.filter((item) => item.id === id).map((item) => item.status)).toEqual(["running", "passed"])
      expect(output.every((item) => item.runID === id)).toBe(true)
      expect(output.map((item) => item.seq)).toEqual(output.map((_, index) => index))
      expect(output.map((item) => item.chunk).join("")).toContain("hello from the checker")
      expect(output.map((item) => item.chunk).join("")).toContain("and stderr")
    }),
  )

  needs("cargo")("VER-06 [cargo] a crate with a build script asks verify.exec and does not run without it", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo["rust-build"]))
      const asked: string[] = []
      const deny = (units: ReadonlyArray<string>) =>
        Effect.sync(() => {
          asked.push(...units)
          return [] as string[]
        })
      const denied = yield* run([path.join(dir, "src/main.rs")], deny)
      expect(asked).toEqual([dir])
      expect(denied.report.checks.map((check) => [check.run.execClass, check.run.status, check.run.reason])).toEqual([
        ["exec", "skipped", "needs approval (verify.exec)"],
      ])
      expect(denied.report.checks[0].run.startedAt).toBeUndefined()

      const allowed = yield* run([path.join(dir, "src/main.rs")], (units) => Effect.succeed([...units]))
      expect(allowed.report.checks.map((check) => check.run.status)).toEqual(["passed"])
    }),
  )

  needs("go")("VER-13 [go] tests run only when requested, ask verify.exec and report the failing tests", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, zoo["go-test"]))
      const file = path.join(dir, "avg.go")
      const plain = yield* run([file])
      expect(checks(plain, dir)).toEqual([
        ["go", "", "passed"],
        ["go-vet", "", "passed"],
      ])

      const verify = yield* WorkbenchVerify.Service
      const asked: string[] = []
      const result = yield* verify.run({
        files: [file],
        trigger: "agent",
        tests: true,
        approve: (units) =>
          Effect.sync(() => {
            asked.push(...units)
            return [...units]
          }),
      })
      expect(asked).toEqual([dir])
      expect(result.report.checks.map((check) => [check.run.checker, check.run.kind, check.run.status])).toEqual([
        ["go", "check", "passed"],
        ["go-vet", "check", "passed"],
        ["go-test", "test", "failed"],
      ])
      expect(
        result.problems.map((item) => [
          path.relative(dir, item.file ?? ""),
          item.range?.start.line,
          item.code,
          item.kind,
        ]),
      ).toEqual([
        ["avg_test.go", 6, "TestAverage", "test"],
        ["avg_test.go", 12, "TestEmpty", "test"],
      ])
    }),
  )

  needs("pytest")("VER-14 [pytest] tests run through the JUnit report; no tests is not a pass", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(path.join(dir, "app"), zoo.pytest))
      yield* Effect.promise(() => write(path.join(dir, "lib"), { "pyproject.toml": "", "lib.py": "VALUE = 1\n" }))
      const verify = yield* WorkbenchVerify.Service
      // One project per run: two pytest processes starting together can race inside plugins installed on this
      // machine (xonsh's creates its data folder without exist_ok and exits 3), which is not what this tests.
      const run = (file: string) =>
        verify.run({
          files: [path.join(dir, file)],
          trigger: "agent",
          tests: true,
          approve: (units) => Effect.succeed([...units]),
        })
      const pytest = (result: WorkbenchVerify.Result) =>
        result.report.checks
          .filter((check) => check.run.checker === "pytest")
          .map((check) => [path.relative(dir, check.run.unit), check.run.status, check.run.reason])

      const app = yield* run("app/avg.py")
      expect(pytest(app)).toEqual([["app", "failed", undefined]])
      expect(
        app.problems
          .filter((item) => item.tool === "pytest")
          .map((item) => [path.relative(dir, item.file ?? ""), item.range?.start.line, item.code]),
      ).toEqual([
        ["app/test_avg.py", 4, "test_avg::test_average"],
        ["app/avg.py", 1, "test_avg::test_empty"],
      ])
      expect(pytest(yield* run("lib/lib.py"))).toEqual([["lib", "skipped", "no tests collected"]])
    }),
  )

  needs("swift")(
    "VER-14 [swift] swift test runs through its xUnit reports after a clean build",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* Effect.promise(() => write(dir, zoo["swift-test"]))
        const verify = yield* WorkbenchVerify.Service
        const result = yield* verify.run({
          files: [path.join(dir, "Sources/Avg/Avg.swift")],
          trigger: "agent",
          tests: true,
          approve: (units) => Effect.succeed([...units]),
        })
        expect(result.report.checks.map((check) => [check.run.checker, check.run.status])).toEqual([
          ["swift", "passed"],
          ["swift-test", "failed"],
        ])
        expect(
          result.problems.map((item) => [path.relative(dir, item.file ?? ""), item.range?.start.line, item.code]),
        ).toEqual([
          ["Tests/AvgTests/AvgSwiftTesting.swift", 4, "emptyList()"],
          ["Tests/AvgTests/AvgTests.swift", 5, "testAverage"],
        ])
      }),
    180_000,
  )

  needs("swift")("VER-06 [swift] a package with a plugin is exec-class", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(path.join(dir, "plugin"), zoo["swiftpm-plugin"]))
      yield* Effect.promise(() => write(path.join(dir, "plain"), zoo.swiftpm))
      const plan = (root: string) => WorkbenchCheckers.swift.plan({ root, files: [] }, dir)
      expect(yield* Effect.promise(() => plan(path.join(dir, "plugin")))).toMatchObject({ execClass: "exec" })
      expect(yield* Effect.promise(() => plan(path.join(dir, "plain")))).toMatchObject({ execClass: "inert" })
    }),
  )

  needs("mypy")("VER-06 [mypy] configured mypy plugins make the run exec-class", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() =>
        write(dir, { "pyproject.toml": '[tool.mypy]\nplugins = ["pydantic.mypy"]\n', "app.py": "x = 1\n" }),
      )
      const plan = yield* Effect.promise(() =>
        WorkbenchCheckers.mypy.plan({ root: dir, files: [path.join(dir, "app.py")] }, dir),
      )
      expect(plan).toMatchObject({ execClass: "exec" })
    }),
  )
})
