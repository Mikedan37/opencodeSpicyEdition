// OpenCode native adapter: runs the agent's session in-process through this server's own session
// machinery, inside the instance of the identity's directory, and maps that session's events to
// normalized AgentEvents.
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import { Agent } from "@/agent/agent"
import { WorkspaceRef } from "@/effect/instance-ref"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { AgentProvider } from "../provider"

const PREVIEW_LIMIT = 2_000

export const status: AgentHQ.ProviderStatus = {
  id: "opencode",
  name: "OpenCode",
  available: true,
  version: InstallationVersion,
  // Model credentials are managed by opencode's own providers; Agent HQ never inspects them.
  auth: "unknown",
  capabilities: {
    streaming: true,
    toolEvents: true,
    permissionRequests: true,
    cancel: true,
    resume: true,
    models: true,
    mcpTools: true,
  },
}

const OPTIONS: Extract<AgentHQ.AgentEvent, { type: "permission.requested" }>["options"] = [
  { id: "once", label: "Allow once", kind: "allow_once" },
  { id: "always", label: "Always allow", kind: "allow_always" },
  { id: "reject", label: "Reject", kind: "reject_once" },
]

const TOOL_STATE = { pending: "started", running: "running", completed: "completed", error: "error" } as const

// Tools that only read (the list the main chat shares); everything else (bash, edit/write/patch, task, MCP tools,
// verify, debug...) asks the human even where the agent's rules say "allow".
const READ_ONLY: readonly string[] = Agent.READ_ONLY_TOOLS

/**
 * Agent HQ never auto-approves execution or file mutation: every "allow" in the agent's rules becomes
 * "ask" except for read-only tools. Deny and ask rules keep their order, so nothing gets looser.
 * Interactive tools are denied because Agent HQ has no question surface yet (a question would block
 * the turn forever).
 */
export function guard(rules: PermissionV1.Ruleset): PermissionV1.Rule[] {
  return [
    ...rules.flatMap((rule): PermissionV1.Rule[] =>
      rule.action !== "allow" || READ_ONLY.includes(rule.permission)
        ? [rule]
        : [
            { ...rule, action: "ask" },
            ...READ_ONLY.filter((permission) => Wildcard.match(permission, rule.permission)).map(
              (permission): PermissionV1.Rule => ({ permission, pattern: rule.pattern, action: "allow" }),
            ),
          ],
    ),
    ...["question", "plan_enter", "plan_exit"].map(
      (permission): PermissionV1.Rule => ({ permission, pattern: "*", action: "deny" }),
    ),
  ]
}

export const make = Effect.gen(function* () {
  const store = yield* InstanceStore.Service
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const permissions = yield* Permission.Service
  const agents = yield* Agent.Service
  const events = yield* EventV2.Service
  const scope = yield* Scope.Scope

  // Run inside the identity's own instance, never the instance that served the HTTP request.
  const within =
    (agent: AgentHQ.AgentIdentity) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      store.provide(
        { directory: agent.workingDirectory ?? agent.projectDirectory },
        effect.pipe(Effect.provideService(WorkspaceRef, undefined)),
      )

  const failure = (message: string) => new AgentProvider.ProviderError({ provider: "opencode", message })

  const attach = Effect.fnUntraced(function* (
    agent: AgentHQ.AgentIdentity,
    sessionID: SessionID,
    emit: AgentProvider.Emit,
  ) {
    const run = within(agent)
    const model = agent.model ? Provider.parseModel(agent.model) : undefined
    const watched = new Set<string>([sessionID]) // the session plus subagent sessions it spawns
    const assistant = new Set<string>()
    const texts = new Set<string>()
    const tools = new Map<string, string>()
    // `turn` changes on cancel/close so a finishing prompt fiber from before stays silent.
    let turn = 0
    let inflight = 0
    let title: string | undefined

    const part = (input: EventV2.Data<typeof SessionV1.Event.PartUpdated>["part"]) => {
      if (input.sessionID !== sessionID || !assistant.has(input.messageID)) return
      if (input.type === "text") {
        texts.add(input.id)
        if (input.time?.end && !input.synthetic && !input.ignored)
          emit({ type: "message", messageID: input.id, role: "assistant", text: input.text })
        return
      }
      if (input.type === "reasoning") {
        if (input.time.end) emit({ type: "reasoning", messageID: input.id, text: input.text })
        return
      }
      if (input.type === "patch") return input.files.forEach((file) => emit({ type: "file.changed", path: file }))
      if (input.type !== "tool") return
      const state = TOOL_STATE[input.state.status]
      if (tools.get(input.callID) === state) return
      tools.set(input.callID, state)
      const title =
        input.state.status === "running" || input.state.status === "completed" ? input.state.title : undefined
      const output =
        input.state.status === "completed"
          ? input.state.output
          : input.state.status === "error"
            ? input.state.error
            : undefined
      emit({
        type: "tool",
        callID: input.callID,
        tool: input.tool,
        state,
        ...(title ? { title } : {}),
        ...(output !== undefined ? { output: output.slice(0, PREVIEW_LIMIT) } : {}),
      })
    }

    const observe = (event: EventV2.Payload) => {
      // opencode names the session once its title request is answered; default titles are placeholders.
      if (is(SessionV1.Event.Updated, event)) {
        const named = event.data.info.title
        if (event.data.sessionID !== sessionID || named === title || Session.isDefaultTitle(named)) return
        title = named
        emit({ type: "title", title: named })
        return
      }
      if (is(SessionV1.Event.Created, event)) {
        if (event.data.info.parentID && watched.has(event.data.info.parentID)) watched.add(event.data.info.id)
        return
      }
      if (is(SessionV1.Event.MessageUpdated, event)) {
        if (event.data.sessionID === sessionID && event.data.info.role === "assistant")
          assistant.add(event.data.info.id)
        return
      }
      if (is(SessionV1.Event.PartUpdated, event)) return part(event.data.part)
      if (is(SessionV1.Event.PartDelta, event)) {
        if (event.data.sessionID === sessionID && event.data.field === "text" && texts.has(event.data.partID))
          emit({ type: "message.delta", messageID: event.data.partID, text: event.data.delta })
        return
      }
      if (is(PermissionV1.Event.Asked, event)) {
        if (!watched.has(event.data.sessionID)) return
        const metadata = Object.keys(event.data.metadata).length ? JSON.stringify(event.data.metadata) : undefined
        emit({
          type: "permission.requested",
          requestID: event.data.id,
          title: `${event.data.permission}: ${event.data.patterns.join(", ")}`,
          tool: event.data.permission,
          ...(metadata ? { details: metadata.slice(0, PREVIEW_LIMIT) } : {}),
          options: OPTIONS,
        })
        return
      }
      if (is(PermissionV1.Event.Replied, event)) {
        if (!watched.has(event.data.sessionID)) return
        emit({
          type: "permission.resolved",
          requestID: event.data.requestID,
          outcome: event.data.reply === "reject" ? "rejected" : "allowed",
        })
        return
      }
      // Busy/retry only while a turn we started runs; turn ends are reported by `finish`.
      if (is(SessionStatus.Event.Status, event) && event.data.sessionID === sessionID && inflight > 0) {
        if (event.data.status.type === "busy") emit({ type: "status", status: "working" })
        if (event.data.status.type === "retry") emit({ type: "status", status: "blocked" })
      }
    }

    const finish = (current: number, exit: Exit.Exit<SessionV1.WithParts, unknown>) => {
      if (current !== turn) return
      inflight = Math.max(0, inflight - 1)
      if (inflight > 0) return
      if (Exit.isFailure(exit)) {
        emit({ type: "error", message: Cause.pretty(exit.cause).slice(0, PREVIEW_LIMIT) })
        emit({ type: "status", status: Cause.hasInterruptsOnly(exit.cause) ? "disconnected" : "failed" })
        return
      }
      const info = exit.value.info
      if (info.role === "assistant" && info.error?.name === "MessageAbortedError")
        return emit({ type: "status", status: "cancelled" })
      if (info.role === "assistant" && info.error) {
        emit({
          type: "error",
          message: "message" in info.error.data ? info.error.data.message : info.error.name,
        })
        emit({ type: "status", status: "failed" })
        return
      }
      if (info.role !== "assistant") return emit({ type: "turn.completed" })
      emit({
        type: "turn.completed",
        ...(info.finish ? { stopReason: info.finish } : {}),
        usage: { inputTokens: info.tokens.input, outputTokens: info.tokens.output, costUSD: info.cost },
      })
    }

    // Listeners run inside the publisher's fiber: keep this synchronous and never let it fail.
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => observe(event)).pipe(
        Effect.catchCause((cause) => Effect.logError("agenthq opencode event mapping failed", { cause })),
      ),
    )

    return {
      providerSessionID: sessionID,
      send: (text) =>
        Effect.gen(function* () {
          const current = turn
          inflight++
          yield* run(prompts.prompt({ sessionID, ...(model ? { model } : {}), parts: [{ type: "text", text }] })).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Effect.sync(() => finish(current, exit))),
            Effect.forkIn(scope),
          )
        }),
      cancel: Effect.sync(() => {
        turn++
        inflight = 0
      }).pipe(Effect.andThen(run(prompts.cancel(sessionID)))),
      respondPermission: (requestID, optionID) =>
        Effect.gen(function* () {
          const reply = Schema.decodeUnknownOption(PermissionV1.Reply)(optionID)
          if (Option.isNone(reply))
            return yield* new AgentProvider.InvalidInputError({ message: `Unknown permission option: ${optionID}` })
          const missing = new AgentProvider.NotFoundError({ message: `Permission request not found: ${requestID}` })
          const id = Schema.decodeUnknownOption(PermissionV1.ID)(requestID)
          if (Option.isNone(id)) return yield* missing
          yield* run(permissions.reply({ requestID: id.value, reply: reply.value })).pipe(
            Effect.catchTag("Permission.NotFoundError", () => Effect.fail(missing)),
          )
        }),
      close: Effect.sync(() => {
        turn++
        inflight = 0
      }).pipe(Effect.andThen(unsubscribe)),
    } satisfies AgentProvider.Session
  })

  const createSession = Effect.fn("AgentHQ.opencode.createSession")(function* (
    input: AgentProvider.SessionInput & { readonly title?: string },
  ) {
    const info = yield* within(input.agent)(
      Effect.gen(function* () {
        const agent = yield* agents.defaultInfo()
        return yield* sessions.create({
          ...(input.title ? { title: input.title } : {}),
          permission: guard(agent.permission),
        })
      }),
    ).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(
          failure(`could not create an opencode session: ${defect instanceof Error ? defect.message : String(defect)}`),
        ),
      ),
    )
    return yield* attach(input.agent, info.id, input.emit)
  })

  const resumeSession = Effect.fn("AgentHQ.opencode.resumeSession")(function* (
    input: AgentProvider.SessionInput & { readonly providerSessionID: string },
  ) {
    const missing = failure(`opencode session not found: ${input.providerSessionID}`)
    const id = Schema.decodeUnknownOption(SessionID)(input.providerSessionID)
    if (Option.isNone(id)) return yield* missing
    const info = yield* within(input.agent)(sessions.get(id.value)).pipe(Effect.catchCause(() => Effect.fail(missing)))
    return yield* attach(input.agent, info.id, input.emit)
  })

  return {
    id: "opencode",
    status: Effect.succeed(status),
    createSession,
    resumeSession,
  } satisfies AgentProvider.Interface
})

function is<D extends EventV2.Definition>(definition: D, event: EventV2.Payload): event is EventV2.Payload<D> {
  return event.type === definition.type
}

export * as OpenCodeProvider from "./opencode"
