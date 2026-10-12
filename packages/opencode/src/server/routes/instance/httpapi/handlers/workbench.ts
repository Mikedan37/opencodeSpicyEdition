import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Doctor } from "@/workbench/doctor"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { CheckPayload, ProblemsQuery } from "../groups/workbench"

export const workbenchHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "workbench",
  (handlers) =>
    Effect.gen(function* () {
      const problems = yield* WorkbenchProblems.Service
      const verify = yield* WorkbenchVerify.Service
      const agents = yield* Agent.Service
      const config = yield* Config.Service
      const flags = yield* RuntimeFlags.Service
      const appProcess = yield* AppProcess.Service

      const list = Effect.fn("WorkbenchHttpApi.problems")(function* (ctx: { query: typeof ProblemsQuery.Type }) {
        return yield* problems.snapshot({
          severity: ctx.query.severity,
          source: ctx.query.source,
          file: ctx.query.file,
        })
      })

      const check = Effect.fn("WorkbenchHttpApi.check")(function* (ctx: { payload: typeof CheckPayload.Type }) {
        const trigger = ctx.payload.trigger ?? "user"
        // A person who starts a check in the IDE has approved it, so checks that run project code run. An agent
        // outside opencode (the MCP bridge) only gets what the permission rules already allow; nobody is asked.
        const rules = trigger === "agent" ? (yield* agents.defaultInfo()).permission : []
        const result = yield* verify.run({
          files: ctx.payload.files,
          unit: ctx.payload.unit,
          tests: ctx.payload.tests,
          trigger,
          budgetMs: ctx.payload.tests ? WorkbenchVerify.TEST_BUDGET_MS : undefined,
          approve: (units) =>
            Effect.succeed(
              trigger === "user"
                ? units
                : units.filter((unit) => Permission.evaluate("verify.exec", unit, rules).action === "allow"),
            ),
          approval: trigger === "agent" ? "needs approval in the IDE" : undefined,
        })
        return result.report
      })

      const runs = Effect.fn("WorkbenchHttpApi.runs")(function* () {
        return yield* verify.runs()
      })

      const run = Effect.fn("WorkbenchHttpApi.run")(function* (ctx: { params: { runID: Workbench.RunID } }) {
        const record = yield* verify.record(ctx.params.runID)
        if (!record) return yield* notFound(`Run not found: ${ctx.params.runID}`)
        return record
      })

      const doctor = Effect.fn("WorkbenchHttpApi.doctor")(function* () {
        const directory = yield* InstanceState.directory
        const cfg = yield* config.get()
        const report = yield* Doctor.report({
          directory,
          lsp: cfg.lsp,
          experimentalLspTy: flags.experimentalLspTy,
        }).pipe(Effect.provideService(AppProcess.Service, appProcess))
        // repository checks are listed (located, never run) next to the built-in tools
        const checks = cfg.workbench?.checks
        if (!checks || !Object.keys(checks).length) return report
        const repo = yield* Effect.promise(() => WorkbenchCheckers.doctor(checks, directory))
        return { languages: [...report.languages, repo] }
      })

      return handlers
        .handle("problems", list)
        .handle("check", check)
        .handle("runs", runs)
        .handle("run", run)
        .handle("doctor", doctor)
    }),
  // The doctor spawns probes through AppProcess, a stateless process runner the app graph does not expose.
).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
