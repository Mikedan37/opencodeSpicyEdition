import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentOrchestrator } from "@/agenthq/orchestrator"
import { AgentProvider } from "@/agenthq/provider"
import { AgentRegistry } from "@/agenthq/registry"
import { AgentSessions } from "@/agenthq/session"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "../api"
import { ApiNotFoundError, ConflictError, InvalidRequestError, notFound, UpstreamError } from "../errors"
import { CreateAgentPayload, PermissionPayload, SendPayload, StartSessionPayload } from "../groups/agenthq"

type DomainError =
  | AgentProvider.ConflictError
  | AgentProvider.NotFoundError
  | AgentProvider.InvalidInputError
  | AgentProvider.UnsupportedError
  | AgentProvider.ProviderError

type Http<E> = E extends AgentProvider.NotFoundError
  ? ApiNotFoundError
  : E extends AgentProvider.InvalidInputError
    ? InvalidRequestError
    : E extends AgentProvider.UnsupportedError | AgentProvider.ConflictError
      ? ConflictError
      : UpstreamError

// Domain errors stay free of HttpApi types; translate them once here. `Http<E>` keeps each endpoint's
// declared error list exact, which the runtime mapping below guarantees.
function http<E extends DomainError>(error: E): Http<E> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- translate maps each tag to exactly Http<tag>
  return translate(error) as Http<E>
}

function translate(error: DomainError) {
  if (error._tag === "AgentHQ.NotFoundError") return notFound(error.message)
  if (error._tag === "AgentHQ.InvalidInputError") return new InvalidRequestError({ message: error.message })
  if (error._tag === "AgentHQ.UnsupportedError")
    return new ConflictError({ message: error.message, resource: error.provider })
  if (error._tag === "AgentHQ.ConflictError") return new ConflictError({ message: error.message })
  return new UpstreamError({ message: error.message, service: error.provider })
}

export const agenthqHandlers = HttpApiBuilder.group(InstanceHttpApi, "agenthq", (handlers) =>
  Effect.gen(function* () {
    const registry = yield* AgentRegistry.Service
    const sessions = yield* AgentSessions.Service
    const orchestrator = yield* AgentOrchestrator.Service

    const createAgent = Effect.fn("AgentHQHttpApi.createAgent")(function* (ctx: {
      payload: typeof CreateAgentPayload.Type
    }) {
      return yield* registry
        .create({ ...ctx.payload, projectDirectory: ctx.payload.projectDirectory ?? (yield* InstanceState.directory) })
        .pipe(Effect.mapError(http))
    })

    const removeAgent = Effect.fn("AgentHQHttpApi.removeAgent")(function* (ctx: {
      params: { agentID: AgentHQ.AgentID }
    }) {
      yield* registry.get(ctx.params.agentID).pipe(Effect.mapError(http))
      yield* sessions.forget(ctx.params.agentID)
      yield* registry.remove(ctx.params.agentID).pipe(Effect.mapError(http))
      return true
    })

    return handlers
      .handle("providers", () => sessions.providers())
      .handle("agents", () => registry.list())
      .handle("createAgent", createAgent)
      .handle("updateAgent", (ctx) => registry.update(ctx.params.agentID, ctx.payload).pipe(Effect.mapError(http)))
      .handle("removeAgent", removeAgent)
      .handle("sessions", (ctx) => sessions.list(ctx.params.agentID).pipe(Effect.mapError(http)))
      .handle(
        "startSession",
        (ctx: { params: { agentID: AgentHQ.AgentID }; payload: typeof StartSessionPayload.Type }) =>
          sessions.start(ctx.params.agentID, ctx.payload).pipe(Effect.mapError(http)),
      )
      .handle("session", (ctx) => sessions.get(ctx.params.sessionID).pipe(Effect.mapError(http)))
      .handle(
        "sendMessage",
        (ctx: { params: { sessionID: AgentHQ.AgentSessionID }; payload: typeof SendPayload.Type }) =>
          sessions.send(ctx.params.sessionID, ctx.payload.text).pipe(Effect.mapError(http), Effect.as(true)),
      )
      .handle("cancelSession", (ctx) => sessions.cancel(ctx.params.sessionID).pipe(Effect.mapError(http)))
      .handle(
        "respondPermission",
        (ctx: {
          params: { sessionID: AgentHQ.AgentSessionID; requestID: string }
          payload: typeof PermissionPayload.Type
        }) =>
          sessions
            .respond(ctx.params.sessionID, ctx.params.requestID, ctx.payload.optionID)
            .pipe(Effect.mapError(http), Effect.as(true)),
      )
      .handle("tasks", () => orchestrator.list())
      .handle("createTask", (ctx) => orchestrator.create(ctx.payload).pipe(Effect.mapError(http)))
      .handle("task", (ctx) => orchestrator.get(ctx.params.taskID).pipe(Effect.mapError(http)))
      .handle("updateTask", (ctx) => orchestrator.update(ctx.params.taskID, ctx.payload).pipe(Effect.mapError(http)))
      .handle("removeTask", (ctx) =>
        orchestrator.remove(ctx.params.taskID).pipe(Effect.mapError(http), Effect.as(true)),
      )
      .handle("startTask", (ctx) => orchestrator.start(ctx.params.taskID).pipe(Effect.mapError(http)))
      .handle("cancelTask", (ctx) => orchestrator.cancel(ctx.params.taskID).pipe(Effect.mapError(http)))
      .handle("reviewTask", (ctx) => orchestrator.review(ctx.params.taskID).pipe(Effect.mapError(http)))
      .handle("approveTask", (ctx) =>
        orchestrator.approve(ctx.params.taskID, ctx.payload.head).pipe(Effect.mapError(http)),
      )
      .handle("agentMessages", (ctx) =>
        orchestrator.messages({
          ...(ctx.query.taskID ? { taskID: ctx.query.taskID } : {}),
          ...(ctx.query.agentID ? { agentID: ctx.query.agentID } : {}),
        }),
      )
      .handle("sendAgentMessage", (ctx) => orchestrator.send(ctx.payload).pipe(Effect.mapError(http)))
  }),
)
