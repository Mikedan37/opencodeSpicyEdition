import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { InstanceHttpApi } from "../api"
import { ProblemsQuery } from "../groups/workbench"

export const workbenchHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench", (handlers) =>
  Effect.gen(function* () {
    const problems = yield* WorkbenchProblems.Service

    const list = Effect.fn("WorkbenchHttpApi.problems")(function* (ctx: { query: typeof ProblemsQuery.Type }) {
      return yield* problems.snapshot({ severity: ctx.query.severity, source: ctx.query.source, file: ctx.query.file })
    })

    return handlers.handle("problems", list)
  }),
)
