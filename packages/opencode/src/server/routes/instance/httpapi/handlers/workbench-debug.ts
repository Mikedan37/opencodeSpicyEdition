// spicy: Workbench debug route handlers. Requests here come from the user, so they act as "human" — except
// `agent`, which runs the agent's debug tool for an agent outside opencode, with its permission asks.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import { DebugError } from "@/workbench/dap/client"
import { WorkbenchDebug } from "@/workbench/dap/service"
import { WorkbenchInvestigation } from "@/workbench/investigation/investigation"
import { DebugTool } from "@/workbench/tool/debug"
import { InstanceHttpApi } from "../api"
import type { AgentPayload } from "../groups/workbench-debug"
import {
  ConflictError,
  ForbiddenError,
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

// The debug tool reports failures as defects; the agent route turns the expected ones into API errors.
function fromDefect(
  defect: unknown,
): Effect.Effect<never, ReturnType<typeof toApi> | ForbiddenError | InvalidRequestError> {
  if (defect instanceof DebugError) return Effect.fail(toApi(defect))
  if (
    defect instanceof PermissionV1.RejectedError ||
    defect instanceof PermissionV1.DeniedError ||
    defect instanceof PermissionV1.CorrectedError
  )
    return Effect.fail(
      new ForbiddenError({ message: `permission denied in the IDE: ${defect.message || defect._tag}` }),
    )
  if (defect instanceof Tool.InvalidArgumentsError)
    return Effect.fail(new InvalidRequestError({ message: defect.message }))
  return Effect.die(defect)
}

export const workbenchDebugHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-debug", (handlers) =>
  Effect.gen(function* () {
    const debug = yield* WorkbenchDebug.Service
    const investigations = yield* WorkbenchInvestigation.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const tool = yield* Tool.init(yield* DebugTool)
    const session = (id: string) => debug.get(id)

    // Exactly the in-process tool, acting as the agent of `sessionID`: its asks go through the permission service
    // with the default agent's rules plus the session's, so "ask" waits for the human in the IDE.
    const agent = Effect.fn("WorkbenchDebugHttpApi.agent")(function* (ctx: { payload: typeof AgentPayload.Type }) {
      const owner = yield* sessions
        .get(ctx.payload.sessionID)
        .pipe(Effect.catch(() => Effect.fail(notFound(`no session ${ctx.payload.sessionID}`))))
      const info = yield* agents.defaultInfo()
      const ruleset = Permission.merge(info.permission, owner.permission ?? [])
      const controller = new AbortController()
      const { sessionID: _, ...args } = ctx.payload
      const result = yield* tool
        .execute(args, {
          sessionID: owner.id,
          messageID: MessageID.ascending(),
          agent: info.name,
          abort: controller.signal,
          messages: [],
          metadata: () => Effect.void,
          ask: (request) => permission.ask({ ...request, sessionID: owner.id, ruleset }).pipe(Effect.orDie),
        })
        // A cancelled request ends the agent's debug sessions, like aborting the in-process tool.
        .pipe(
          Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
          Effect.catchDefect(fromDefect),
        )
      return { title: result.title, output: result.output, metadata: result.metadata }
    })

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
      .handle("agent", agent)
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
