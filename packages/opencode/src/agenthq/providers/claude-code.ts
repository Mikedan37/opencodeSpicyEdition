// Claude Code through @anthropic-ai/claude-agent-sdk: one SDK `query()` in streaming-input mode per Agent HQ
// session, so a single Claude Code process serves every turn of the session.
//
// Isolation: the installed `claude` binary (and so the owner's existing login) is used, but none of the owner's
// settings, hooks or MCP servers are loaded (`settingSources: []`, `strictMcpConfig`). Permissions stay manual
// (`permissionMode: "default"`): every prompt Claude Code raises waits for the human through Agent HQ.
import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect"
import { AgentProvider } from "../provider"

const PREVIEW_LIMIT = 2_000

export const capabilities: AgentHQ.ProviderCapabilities = {
  streaming: true,
  toolEvents: true,
  permissionRequests: true,
  cancel: true,
  resume: true,
  models: true,
  mcpTools: false,
  notes: ["Uses the installed claude binary and its login; ~/.claude settings, hooks and MCP servers are not loaded"],
}

/** The SDK boundary: the real `query`, or a scripted stand-in in contract tests. */
export type Run = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "close">

// Tools whose input names the file they change.
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

export const make = Effect.fn("AgentHQ.claudeCode.make")(function* (input: {
  readonly status: Effect.Effect<AgentHQ.ProviderStatus>
  /** The `claude` executable to run, or undefined when it is not installed. */
  readonly binary: () => string | undefined
  readonly run?: Run
  /** Extra SDK options for tests (for example `maxTurns`). */
  readonly options?: Pick<Options, "maxTurns" | "persistSession">
}) {
  const parent = yield* Scope.Scope
  const failure = (message: string) => new AgentProvider.ProviderError({ provider: "claude-code", message })

  const open = Effect.fnUntraced(function* (
    agent: AgentHQ.AgentIdentity,
    emit: AgentProvider.Emit,
    resume: string | undefined,
  ) {
    const status = yield* input.status
    const binary = input.binary()
    if (!status.available || !binary)
      return yield* new AgentProvider.UnsupportedError({
        provider: "claude-code",
        action: "createSession",
        message: status.reason ?? "claude is not installed",
      })
    const run = input.run ?? (yield* Effect.promise(() => import("@anthropic-ai/claude-agent-sdk"))).query
    const sessionID = resume ?? crypto.randomUUID()
    const scope = yield* Scope.fork(parent)
    const inbox = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
    const stderr: string[] = []
    const state = new ClaudeState(emit, sessionID)
    const query = run({
      prompt: Stream.toAsyncIterable(Stream.fromQueue(inbox)),
      options: {
        cwd: agent.workingDirectory ?? agent.projectDirectory,
        pathToClaudeCodeExecutable: binary,
        ...(resume ? { resume } : { sessionId: sessionID }),
        ...(agent.model ? { model: agent.model } : {}),
        settingSources: [],
        strictMcpConfig: true,
        // Hook for the Workbench MCP bridge once it exists.
        mcpServers: {},
        permissionMode: "default",
        includePartialMessages: true,
        canUseTool: (tool, toolInput, options) => state.ask(tool, toolInput, options),
        stderr: (data) => void stderr.push(data),
        ...input.options,
      },
    })
    const tail = () => {
      const text = stderr.join("").slice(-PREVIEW_LIMIT).trim()
      return text ? `\n${text}` : ""
    }
    yield* Stream.fromAsyncIterable(query, (error) => error).pipe(
      Stream.runForEach((message) => Effect.sync(() => state.map(message))),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.sync(() =>
          state.disconnect(
            Exit.isFailure(exit)
              ? `Claude Code stopped: ${Cause.pretty(exit.cause).slice(0, PREVIEW_LIMIT)}${tail()}`
              : `Claude Code ended the session${tail()}`,
          ),
        ),
      ),
      Effect.forkIn(scope),
    )

    const close = Effect.suspend(() => {
      state.closing = true
      state.settle()
      Queue.endUnsafe(inbox)
      query.close()
      return Scope.close(scope, Exit.void)
    })

    return {
      providerSessionID: sessionID,
      send: (text) =>
        Effect.suspend(() => {
          if (state.gone) return Effect.fail(failure("Claude Code is no longer running"))
          const uuid = crypto.randomUUID()
          state.inflight.add(uuid)
          Queue.offerUnsafe(inbox, {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: sessionID,
            uuid,
          })
          return Effect.void
        }),
      cancel: Effect.suspend(() => {
        state.cancelled = new Set(state.inflight)
        state.inflight.clear()
        state.settle()
        return Effect.tryPromise({
          try: () => query.interrupt(),
          catch: (error) => failure(`interrupt failed: ${error instanceof Error ? error.message : String(error)}`),
        }).pipe(Effect.asVoid)
      }),
      respondPermission: (requestID, optionID) =>
        Effect.suspend((): Effect.Effect<void, AgentProvider.NotFoundError | AgentProvider.InvalidInputError> => {
          const pending = state.pending.get(requestID)
          if (!pending)
            return Effect.fail(
              new AgentProvider.NotFoundError({ message: `Permission request not found: ${requestID}` }),
            )
          const result = decision(optionID, pending.always)
          if (!result)
            return Effect.fail(
              new AgentProvider.InvalidInputError({ message: `Unknown permission option: ${optionID}` }),
            )
          pending.resolve(result)
          emit({
            type: "permission.resolved",
            requestID,
            outcome: result.behavior === "allow" ? "allowed" : "rejected",
          })
          return Effect.void
        }),
      close,
    } satisfies AgentProvider.Session
  })

  return {
    id: "claude-code",
    status: input.status,
    createSession: (session) => open(session.agent, session.emit, undefined),
    resumeSession: (session) => open(session.agent, session.emit, session.providerSessionID),
  } satisfies AgentProvider.Interface
})

/** Maps SDK messages to AgentEvents and parks permission requests until the human answers. */
class ClaudeState {
  closing = false
  gone = false
  readonly inflight = new Set<string>()
  cancelled = new Set<string>()
  readonly pending = new Map<
    string,
    { readonly always: PermissionUpdate[]; readonly resolve: (result: PermissionResult) => void }
  >()
  private current: string | undefined
  private readonly streamed = new Set<string>()
  private readonly blocks = new Map<number, { type: string; text: string }>()
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>()

  constructor(
    readonly emit: AgentProvider.Emit,
    readonly sessionID: string,
  ) {}

  map(message: SDKMessage) {
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return // subagent traffic
    if (message.type === "stream_event") return this.stream(message.event)
    if (message.type === "assistant") {
      if (message.error) this.emit({ type: "error", message: `Claude Code: ${message.error}` })
      const streamed = this.streamed.has(message.message.id)
      message.message.content.forEach((block, index) => {
        if (block.type === "tool_use") return this.tool(block.id, block.name, toRecord(block.input))
        if (streamed) return
        const id = `${message.message.id}-${index}`
        if (block.type === "text" && block.text)
          this.emit({ type: "message", messageID: id, role: "assistant", text: block.text })
        if (block.type === "thinking" && block.thinking)
          this.emit({ type: "reasoning", messageID: id, text: block.thinking })
      })
      return
    }
    if (message.type === "user") {
      const content = message.message.content
      if (typeof content === "string") return
      content.forEach((block) => {
        if (block.type !== "tool_result") return
        const known = this.tools.get(block.tool_use_id)
        const file = known && EDITS.has(known.name) ? known.input.file_path : undefined
        if (typeof file === "string" && !block.is_error) this.emit({ type: "file.changed", path: file })
        const output = resultText(block.content)
        this.emit({
          type: "tool",
          callID: block.tool_use_id,
          tool: known?.name ?? "tool",
          state: block.is_error ? "error" : "completed",
          ...(output ? { output: output.slice(0, PREVIEW_LIMIT) } : {}),
        })
      })
      return
    }
    if (message.type !== "result") return
    const ids = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])
    ids.forEach((id) => this.inflight.delete(id))
    // A turn the human cancelled ends quietly; the manager already recorded the cancel.
    const quiet = ids.length > 0 ? ids.every((id) => this.cancelled.has(id)) : this.cancelled.size > 0
    if (quiet) {
      ids.forEach((id) => this.cancelled.delete(id))
      if (ids.length === 0) this.cancelled.clear()
      return
    }
    if (message.subtype === "success" && !message.is_error) {
      this.emit({
        type: "turn.completed",
        stopReason: message.stop_reason ?? "end_turn",
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          costUSD: message.total_cost_usd,
        },
      })
      return
    }
    const errors = "errors" in message && message.errors.length ? message.errors.join("\n") : undefined
    this.emit({ type: "error", message: errors ?? `Claude Code turn failed (${message.subtype})` })
    this.emit({ type: "status", status: "failed" })
  }

  /** Parks Claude Code's permission prompt until `respondPermission`; never answers on its own. */
  readonly ask: CanUseTool = (tool, toolInput, options) => {
    const requestID = `cc_${options.toolUseID || options.requestId}`
    // "Always" re-scopes Claude Code's own allow-rule suggestions to this session only; nothing is written to disk.
    const always = (options.suggestions ?? []).flatMap((suggestion): PermissionUpdate[] =>
      suggestion.type === "addRules" && suggestion.behavior === "allow"
        ? [{ ...suggestion, destination: "session" }]
        : [],
    )
    const subject = describe(toolInput)
    const details = JSON.stringify(toolInput)
    return new Promise<PermissionResult>((resolve) => {
      const settle = (result: PermissionResult) => {
        if (this.pending.delete(requestID)) resolve(result)
      }
      this.pending.set(requestID, { always, resolve: settle })
      options.signal.addEventListener("abort", () => settle({ behavior: "deny", message: "Cancelled" }), {
        once: true,
      })
      this.emit({
        type: "permission.requested",
        requestID,
        title: options.title ?? (subject ? `${tool}: ${subject}` : tool),
        tool,
        ...(details && details !== "{}" ? { details: details.slice(0, PREVIEW_LIMIT) } : {}),
        options: [
          { id: "allow", label: "Allow once", kind: "allow_once" },
          ...(always.length > 0
            ? [{ id: "always", label: "Always allow in this session", kind: "allow_always" as const }]
            : []),
          { id: "deny", label: "Reject", kind: "reject_once" },
        ],
      })
    })
  }

  /** Deny every parked request: the turn is being cancelled or the session closed. */
  settle() {
    this.pending.forEach((item) => item.resolve({ behavior: "deny", message: "Cancelled", interrupt: true }))
    this.pending.clear()
  }

  disconnect(message: string) {
    if (this.closing || this.gone) return
    this.gone = true
    this.settle()
    this.emit({ type: "error", message })
    this.emit({ type: "status", status: "disconnected" })
  }

  private stream(event: Extract<SDKMessage, { type: "stream_event" }>["event"]) {
    if (event.type === "message_start") {
      this.current = event.message.id
      this.streamed.add(event.message.id)
      return
    }
    if (event.type === "content_block_start") {
      this.blocks.set(event.index, { type: event.content_block.type, text: "" })
      if (event.content_block.type === "tool_use")
        this.tool(event.content_block.id, event.content_block.name, toRecord(event.content_block.input))
      return
    }
    if (event.type === "content_block_delta") {
      const block = this.blocks.get(event.index)
      if (!block) return
      if (event.delta.type === "text_delta") {
        block.text += event.delta.text
        this.emit({ type: "message.delta", messageID: `${this.current}-${event.index}`, text: event.delta.text })
      }
      if (event.delta.type === "thinking_delta") block.text += event.delta.thinking
      return
    }
    if (event.type !== "content_block_stop") return
    const block = this.blocks.get(event.index)
    this.blocks.delete(event.index)
    const id = `${this.current}-${event.index}`
    if (block?.type === "text" && block.text)
      this.emit({ type: "message", messageID: id, role: "assistant", text: block.text })
    if (block?.type === "thinking" && block.text) this.emit({ type: "reasoning", messageID: id, text: block.text })
  }

  private tool(id: string, name: string, toolInput: Record<string, unknown>) {
    const known = this.tools.get(id)
    // The streamed start has no input yet; the complete message brings it.
    this.tools.set(id, { name, input: Object.keys(toolInput).length ? toolInput : (known?.input ?? toolInput) })
    if (known) return
    const subject = describe(toolInput)
    this.emit({ type: "tool", callID: id, tool: name, state: "started", ...(subject ? { title: subject } : {}) })
  }
}

function decision(optionID: string, always: PermissionUpdate[]): PermissionResult | undefined {
  if (optionID === "allow") return { behavior: "allow" }
  if (optionID === "always" && always.length > 0) return { behavior: "allow", updatedPermissions: always }
  if (optionID === "deny") return { behavior: "deny", message: "The user rejected this action." }
  return undefined
}

function describe(input: Record<string, unknown>) {
  const value = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description
  return typeof value === "string" ? value.slice(0, 200) : undefined
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function resultText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  return content
    .flatMap((item: unknown) =>
      item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item
        ? [String(item.text)]
        : [],
    )
    .join("\n")
}

export * as ClaudeCodeProvider from "./claude-code"
