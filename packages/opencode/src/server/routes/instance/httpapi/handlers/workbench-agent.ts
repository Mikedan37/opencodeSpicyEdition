// spicy: running workbench tools for agents outside opencode (the Workbench MCP bridge) as the agent of an opencode
// session. Asks go through the permission service with the default agent's rules plus the session's (as
// session/tools.ts does), so "ask" waits for the human in the IDE; nothing is approved here.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import { ForbiddenError, InvalidRequestError, notFound } from "../errors"

/** Built once per handler group: `run(sessionID, execute)` calls `execute` with that session's agent context. */
export const runner = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const permission = yield* Permission.Service
  return <A, E>(sessionID: SessionID, execute: (ctx: Tool.Context) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const owner = yield* sessions
        .get(sessionID)
        .pipe(Effect.catch(() => Effect.fail(notFound(`no session ${sessionID}`))))
      const info = yield* agents.defaultInfo()
      const ruleset = Permission.merge(info.permission, owner.permission ?? [])
      const controller = new AbortController()
      return yield* execute({
        sessionID: owner.id,
        messageID: MessageID.ascending(),
        agent: info.name,
        abort: controller.signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (request) => permission.ask({ ...request, sessionID: owner.id, ruleset }).pipe(Effect.orDie),
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
    })
})

/**
 * Tools report failures as defects. `known` maps the tool's own errors; a refused ask is 403 and bad arguments are
 * 400; anything else stays a defect.
 */
export function defect<E>(
  cause: unknown,
  known: (cause: unknown) => E | undefined,
): Effect.Effect<never, E | ForbiddenError | InvalidRequestError> {
  const mapped = known(cause)
  if (mapped !== undefined) return Effect.fail(mapped)
  if (
    cause instanceof PermissionV1.RejectedError ||
    cause instanceof PermissionV1.DeniedError ||
    cause instanceof PermissionV1.CorrectedError
  )
    return Effect.fail(new ForbiddenError({ message: `permission denied in the IDE: ${cause.message || cause._tag}` }))
  if (cause instanceof Tool.InvalidArgumentsError)
    return Effect.fail(new InvalidRequestError({ message: cause.message }))
  return Effect.die(cause)
}

export * as WorkbenchAgent from "./workbench-agent"
