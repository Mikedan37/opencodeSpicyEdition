// spicy: Workbench debug route handlers. Requests here come from the user, so they act as "human".
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { DebugError } from "@/workbench/dap/client"
import { WorkbenchDebug } from "@/workbench/dap/service"
import { WorkbenchInvestigation } from "@/workbench/investigation/investigation"
import { InstanceHttpApi } from "../api"
import {
  ConflictError,
  InvalidRequestError,
  notFound,
  ServiceUnavailableError,
  TimeoutError,
  UpstreamError,
} from "../errors"

const human = { by: "human" as const }

function toApi(error: DebugError) {
  if (error.kind === "not_found") return notFound(error.message)
  if (error.kind === "not_owner" || error.kind === "limit")
    return new ConflictError({ message: error.message, resource: "debug-session" })
  if (error.kind === "unavailable")
    return new ServiceUnavailableError({ message: error.message, service: "debug-adapter" })
  if (error.kind === "adapter") return new UpstreamError({ message: error.message, service: "debug-adapter" })
  if (error.kind === "timeout") return new TimeoutError({ message: error.message, operation: "debug" })
  return new InvalidRequestError({ message: error.message, kind: error.kind })
}

export const workbenchDebugHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-debug", (handlers) =>
  Effect.gen(function* () {
    const debug = yield* WorkbenchDebug.Service
    const investigations = yield* WorkbenchInvestigation.Service
    const session = (id: string) => debug.get(id)

    return handlers
      .handle("list", () => debug.list())
      .handle("start", (ctx) =>
        debug.prepare(ctx.payload).pipe(
          Effect.flatMap((spec) => debug.start(spec, human)),
          Effect.map((started) => started.result.info),
          Effect.mapError(toApi),
        ),
      )
      .handle("control", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.control(ctx.payload.action, human, false)),
          Effect.map((result) => result.info),
          Effect.mapError(toApi),
        ),
      )
      .handle("breakpoints", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.breakpoints(ctx.payload, human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("variables", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.variables(ctx.query.ref, human, ctx.query.start ?? 0)),
          Effect.mapError(toApi),
        ),
      )
      .handle("evaluate", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.evaluate(ctx.payload, human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("completions", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) =>
            item.completions(
              {
                text: ctx.query.text,
                ...(ctx.query.column !== undefined ? { column: ctx.query.column } : {}),
                ...(ctx.query.frameID !== undefined ? { frameID: ctx.query.frameID } : {}),
              },
              human,
            ),
          ),
          Effect.mapError(toApi),
        ),
      )
      .handle("output", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.map((item) => item.output(ctx.query.after ?? 0)),
          Effect.mapError(toApi),
        ),
      )
      .handle("owner", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.setOwner(ctx.payload.owner, human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("stop", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.stop(human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("investigations", () => investigations.list())
      .handle("investigation", (ctx) => investigations.full(ctx.params.investigationID).pipe(Effect.mapError(toApi)))
      .handle("resume", (ctx) =>
        investigations
          .resume(ctx.params.investigationID, human)
          .pipe(Effect.map(WorkbenchInvestigation.summary), Effect.mapError(toApi)),
      )
      .handle("cancel", (ctx) =>
        investigations
          .cancel(ctx.params.investigationID, "cancelled by the user")
          .pipe(Effect.map(WorkbenchInvestigation.summary), Effect.mapError(toApi)),
      )
  }),
)
