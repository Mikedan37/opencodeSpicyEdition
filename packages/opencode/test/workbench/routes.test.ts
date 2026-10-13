import { describe, expect } from "bun:test"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { write, zoo } from "../fixture/workbench/zoo"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const it = testEffect(
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
// Real-toolchain tests skip when the tool is missing; the test name says which tool.
const needs = (...tools: string[]) => (tools.every((tool) => which(tool)) ? it.live : it.live.skip)

const call = (dir: string, route: string, body?: unknown) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(
      route,
      dir,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    )
    return { status: response.status, body: JSON.parse(yield* response.text) as unknown }
  })

describe("workbench routes", () => {
  needs("clang")("[clang] POST /workbench/check, then the run list and the run's output", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => write(dir, zoo["link-c"]))

      const checked = yield* call(dir, "/workbench/check", { files: ["main.c"] })
      expect(checked.status).toBe(200)
      const report = checked.body as Workbench.VerificationReport
      expect(report).toMatchObject({ trigger: "user", changedFiles: [path.join(dir, "main.c")] })
      expect(report.checks.map((check) => [check.run.checker, check.run.status])).toEqual([["clang", "failed"]])
      const id = report.checks[0].run.id

      const runs = yield* call(dir, "/workbench/runs")
      expect((runs.body as Workbench.RunInfo[])[0]).toMatchObject({ id, status: "failed", checker: "clang" })

      const record = yield* call(dir, `/workbench/runs/${id}`)
      expect(record.status).toBe(200)
      expect(record.body).toMatchObject({ run: { id, status: "failed" }, truncated: false })
      expect((record.body as { output: string }).output).toContain("Undefined symbols")

      expect((yield* call(dir, "/workbench/runs/run_missing")).status).toBe(404)
    }),
  )

  needs("cargo")("[cargo] exec-class checks run for a person, not for an agent without verify.exec", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => write(dir, zoo["rust-build"]))
      const runs = (body: unknown) =>
        (body as Workbench.VerificationReport).checks.map((check) => [
          check.run.execClass,
          check.run.status,
          check.run.reason,
        ])

      const user = yield* call(dir, "/workbench/check", { files: ["src/main.rs"] })
      expect(runs(user.body)).toEqual([["exec", "passed", undefined]])

      const agent = yield* call(dir, "/workbench/check", { files: ["src/main.rs"], trigger: "agent" })
      expect(agent.body).toMatchObject({ trigger: "agent" })
      expect(runs(agent.body)).toEqual([["exec", "skipped", "needs approval in the IDE"]])
    }),
  )

  needs("cargo")("[cargo] an agent's exec-class check runs when the permission rules allow verify.exec", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { permission: { "verify.exec": "allow" } } })
      yield* Effect.promise(() => write(dir, zoo["rust-build"]))
      const agent = yield* call(dir, "/workbench/check", { files: ["src/main.rs"], trigger: "agent" })
      expect((agent.body as Workbench.VerificationReport).checks.map((check) => check.run.status)).toEqual(["passed"])
    }),
  )

  it.live("GET /workbench/doctor lists languages with probes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const doctor = yield* call(dir, "/workbench/doctor")
      expect(doctor.status).toBe(200)
      expect((doctor.body as { languages: { id: string }[] }).languages.map((language) => language.id)).toEqual([
        "swift",
        "c",
        "python",
        "typescript",
        "rust",
        "go",
      ])
    }),
  )

  it.live("DIAG-12 GET /workbench/problems says whether language servers are on", () =>
    Effect.gen(function* () {
      const lsp = (dir: string) =>
        call(dir, "/workbench/problems").pipe(Effect.map((result) => (result.body as Workbench.ProblemsSnapshot).lsp))
      expect(yield* lsp(yield* tmpdirScoped({ git: true }))).toBe("off")
      expect(yield* lsp(yield* tmpdirScoped({ git: true, config: { lsp: true } }))).toBe("on")
    }),
  )
})
