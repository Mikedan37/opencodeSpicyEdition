// Generic Agent Client Protocol adapter: spawns an ACP agent over stdio and drives it as the client.
// Used for Cursor (`cursor-agent acp`, once it exists) and for custom ACP agents (`provider: "acp"`).
//
// The client advertises no file-system or terminal capabilities, so the agent does its own file and shell
// work and must ask through `session/request_permission`; those requests wait for the human.
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallContent,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Cause, Effect, Exit, Queue, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentProvider } from "../provider"

const PREVIEW_LIMIT = 2_000

export const capabilities: AgentHQ.ProviderCapabilities = {
  streaming: true,
  toolEvents: true,
  permissionRequests: true,
  cancel: true,
  resume: false,
  models: false,
  mcpTools: true,
  notes: ["Resumes only when the agent advertises session/resume or session/load"],
}

export interface Launch {
  readonly command: string
  readonly args: readonly string[]
}

const TOOL_STATE: Record<ToolCallStatus, Extract<AgentHQ.AgentEvent, { type: "tool" }>["state"]> = {
  pending: "started",
  in_progress: "running",
  completed: "completed",
  failed: "error",
}

export const make = Effect.fn("AgentHQ.acp.make")(function* (input: {
  readonly id: AgentHQ.ProviderID
  readonly status: Effect.Effect<AgentHQ.ProviderStatus>
  /** What to spawn for an identity, or why this provider cannot start a session for it. */
  readonly launch: (
    agent: AgentHQ.AgentIdentity,
  ) => Effect.Effect<Launch, AgentProvider.UnsupportedError | AgentProvider.ProviderError>
}) {
  const spawner = yield* AppProcess.Service
  const parent = yield* Scope.Scope
  const failure = (message: string) => new AgentProvider.ProviderError({ provider: input.id, message })

  const open = Effect.fnUntraced(function* (agent: AgentHQ.AgentIdentity, emit: AgentProvider.Emit) {
    const launch = yield* input.launch(agent)
    const cwd = agent.workingDirectory ?? agent.projectDirectory
    // Everything the session owns (the agent's process group, its readers) dies with this scope.
    const scope = yield* Scope.fork(parent)
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const proc = yield* spawner
      .spawn(
        ChildProcess.make(launch.command, [...launch.args], {
          cwd,
          // Never this server's credentials. An agent that is opencode itself (`opencode acp`) runs a listener of
          // its own, which keeps a password that way; other agents ignore it.
          env: { ...AgentProvider.agentEnv(), OPENCODE_SERVER_PASSWORD: crypto.randomUUID() },
          stdin: { stream: Stream.fromQueue(stdin) },
          forceKillAfter: "3 seconds",
        }),
      )
      .pipe(
        Scope.provide(scope),
        Effect.catchCause((cause) =>
          Scope.close(scope, Exit.void).pipe(
            Effect.andThen(Effect.fail(failure(`could not start ${launch.command}: ${Cause.pretty(cause)}`))),
          ),
        ),
      )
    const stderr: string[] = []
    yield* proc.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.sync(() => stderr.push(chunk))),
      Effect.ignore,
      Effect.forkIn(scope),
    )
    const tail = () => {
      const text = stderr.join("").slice(-PREVIEW_LIMIT).trim()
      return text ? `\n${text}` : ""
    }

    const state = new ClientState(emit)
    const connection = new ClientSideConnection(
      () => state.client,
      ndJsonStream(
        new WritableStream<Uint8Array>({
          write: (chunk) => void Queue.offerUnsafe(stdin, chunk),
          close: () => void Queue.endUnsafe(stdin),
        }),
        Stream.toReadableStream<Uint8Array>()(proc.stdout),
      ),
    )
    const call = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (error) => failure(`${what} failed: ${describe(error)}${tail()}`) })

    // An exit we did not ask for is reported once; the manager keeps the history.
    yield* proc.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.sync(() =>
          state.disconnect(
            `${launch.command} exited (${Exit.isSuccess(exit) ? `code ${exit.value}` : "signal"})${tail()}`,
          ),
        ),
      ),
      Effect.forkIn(scope),
    )

    const close = Effect.suspend(() => {
      state.closing = true
      state.turn++
      state.settle()
      Queue.endUnsafe(stdin)
      return Scope.close(scope, Exit.void)
    })

    const initialized = yield* call("initialize", () =>
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "opencode-agenthq", version: InstallationVersion },
      }),
    ).pipe(Effect.tapError(() => close))

    const finish = (turn: number, exit: Exit.Exit<PromptResponse, AgentProvider.ProviderError>) => {
      if (Exit.isFailure(exit) && connection.signal.aborted)
        // A dead agent is reported by the exit watcher with its exit code; this covers a live one that
        // closed its stream.
        return proc.exitCode.pipe(
          Effect.timeout("2 seconds"),
          Effect.ignore,
          Effect.andThen(Effect.sync(() => state.disconnect(`ACP connection closed${tail()}`))),
        )
      return Effect.sync(() => state.finish(turn, exit))
    }
    return { connection, state, cwd, initialized, call, close, finish }
  })

  type Opened = Effect.Success<ReturnType<typeof open>>

  const handle = (opened: Opened, sessionID: string): AgentProvider.Session => {
    const turns = Semaphore.makeUnsafe(1)
    opened.state.sessionID = sessionID
    return {
      providerSessionID: sessionID,
      send: (text) =>
        Effect.gen(function* () {
          if (opened.state.gone) return yield* failure("the ACP agent is no longer running")
          const turn = opened.state.turn
          // ACP serves one prompt per session at a time; later messages wait for the running turn.
          yield* turns
            .withPermit(
              Effect.suspend(() => {
                if (turn !== opened.state.turn) return Effect.void
                return opened
                  .call("prompt", () =>
                    opened.connection.prompt({ sessionId: sessionID, prompt: [{ type: "text", text }] }),
                  )
                  .pipe(
                    Effect.exit,
                    Effect.flatMap((exit) => opened.finish(turn, exit)),
                  )
              }),
            )
            .pipe(Effect.forkIn(parent))
        }),
      cancel: Effect.suspend(() => {
        opened.state.turn++
        opened.state.settle()
        return opened.call("cancel", () => opened.connection.cancel({ sessionId: sessionID }))
      }),
      respondPermission: (requestID, optionID) =>
        Effect.suspend((): Effect.Effect<void, AgentProvider.NotFoundError | AgentProvider.InvalidInputError> => {
          const pending = opened.state.pending.get(requestID)
          if (!pending)
            return Effect.fail(
              new AgentProvider.NotFoundError({ message: `Permission request not found: ${requestID}` }),
            )
          const option = pending.options.find((item) => item.optionId === optionID)
          if (!option)
            return Effect.fail(
              new AgentProvider.InvalidInputError({ message: `Unknown permission option: ${optionID}` }),
            )
          opened.state.pending.delete(requestID)
          pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
          opened.state.emit({
            type: "permission.resolved",
            requestID,
            outcome: option.kind.startsWith("allow") ? "allowed" : "rejected",
          })
          return Effect.void
        }),
      close: opened.close,
    }
  }

  const createSession = Effect.fn("AgentHQ.acp.createSession")(function* (session: AgentProvider.SessionInput) {
    const opened = yield* open(session.agent, session.emit)
    const created = yield* opened
      .call("session/new", () => opened.connection.newSession({ cwd: opened.cwd, mcpServers: mcp(session.workbench) }))
      .pipe(Effect.tapError(() => opened.close))
    return handle(opened, created.sessionId)
  })

  const resumeSession = Effect.fn("AgentHQ.acp.resumeSession")(function* (
    session: AgentProvider.SessionInput & { readonly providerSessionID: string },
  ) {
    const opened = yield* open(session.agent, session.emit)
    const sessionId = session.providerSessionID
    const advertised = opened.initialized.agentCapabilities
    if (advertised?.sessionCapabilities?.resume) {
      yield* opened
        .call("session/resume", () =>
          opened.connection.resumeSession({ sessionId, cwd: opened.cwd, mcpServers: mcp(session.workbench) }),
        )
        .pipe(Effect.tapError(() => opened.close))
      return handle(opened, sessionId)
    }
    if (advertised?.loadSession) {
      // session/load replays the conversation as updates; the manager already holds that history.
      opened.state.replaying = true
      yield* opened
        .call("session/load", () =>
          opened.connection.loadSession({ sessionId, cwd: opened.cwd, mcpServers: mcp(session.workbench) }),
        )
        .pipe(
          Effect.ensuring(Effect.sync(() => (opened.state.replaying = false))),
          Effect.tapError(() => opened.close),
        )
      return handle(opened, sessionId)
    }
    yield* opened.close
    return yield* new AgentProvider.UnsupportedError({
      provider: input.id,
      action: "resume",
      message: "This ACP agent advertises neither session/resume nor session/load",
    })
  })

  return { id: input.id, status: input.status, createSession, resumeSession } satisfies AgentProvider.Interface
})

/** The Workbench MCP server as ACP's stdio server entry (credentials only in its environment). */
function mcp(server: AgentProvider.McpServer | undefined) {
  if (!server) return []
  const env = Object.entries(server.env).map(([name, value]) => ({ name, value }))
  return [{ name: server.name, command: server.command, args: [...server.args], env }]
}

/** Per-connection client state: maps ACP updates to AgentEvents and parks permission requests. */
class ClientState {
  sessionID: string | undefined
  turn = 0
  closing = false
  gone = false
  replaying = false
  readonly pending = new Map<
    string,
    { readonly options: readonly PermissionOption[]; readonly resolve: (value: RequestPermissionResponse) => void }
  >()
  private readonly text = new Map<string, { kind: "message" | "reasoning"; id: string; value: string }>()
  // Text that resumes under an ACP messageId whose text was already completed gets a new segment id, so each
  // completed message keeps its own text.
  private readonly segments = new Map<string, number>()
  private readonly tools = new Map<string, { tool: string; title?: string; state?: string }>()
  private block: string | undefined
  private requests = 0

  constructor(readonly emit: AgentProvider.Emit) {}

  readonly client: Client = {
    sessionUpdate: async (notification) => this.update(notification),
    requestPermission: (request) => this.ask(request),
  }

  /** A prompt finished: completed text first, then how the turn ended. */
  finish(turn: number, exit: Exit.Exit<PromptResponse, AgentProvider.ProviderError>) {
    this.flush()
    if (turn !== this.turn || this.closing) return
    if (Exit.isFailure(exit)) {
      this.emit({ type: "error", message: Cause.pretty(exit.cause).slice(0, PREVIEW_LIMIT) })
      this.emit({ type: "status", status: "failed" })
      return
    }
    if (exit.value.stopReason === "cancelled") return this.emit({ type: "status", status: "cancelled" })
    this.emit({ type: "turn.completed", stopReason: exit.value.stopReason })
  }

  disconnect(message: string) {
    if (this.closing || this.gone) return
    this.gone = true
    this.settle()
    this.flush()
    this.emit({ type: "error", message })
    this.emit({ type: "status", status: "disconnected" })
  }

  /** Answer every parked permission request with `cancelled`, as ACP requires on cancel. */
  settle() {
    this.pending.forEach((item) => item.resolve({ outcome: { outcome: "cancelled" } }))
    this.pending.clear()
  }

  private update(notification: SessionNotification) {
    if (this.replaying || notification.sessionId !== this.sessionID) return
    const update = notification.update
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return
        const kind = update.sessionUpdate === "agent_message_chunk" ? "message" : "reasoning"
        const base = update.messageId ?? (this.block ??= crypto.randomUUID())
        const segment = this.segments.get(`${kind}:${base}`) ?? 0
        const id = segment === 0 ? base : `${base}-${segment}`
        const key = `${kind}:${base}`
        this.text.set(key, { kind, id, value: (this.text.get(key)?.value ?? "") + update.content.text })
        if (kind === "message") this.emit({ type: "message.delta", messageID: id, text: update.content.text })
        return
      }
      case "tool_call":
      case "tool_call_update": {
        this.flush()
        const known = this.tools.get(update.toolCallId)
        const tool = update.kind ?? known?.tool ?? "tool"
        const title = update.title ?? known?.title
        const state = update.status ? TOOL_STATE[update.status] : known ? undefined : "started"
        this.tools.set(update.toolCallId, { tool, title, state: state ?? known?.state })
        update.content
          ?.flatMap((item) => (item.type === "diff" ? [item.path] : []))
          .forEach((file) => this.emit({ type: "file.changed", path: file }))
        if (!state || state === known?.state) return
        const output =
          state === "completed" || state === "error" ? preview(update.content, update.rawOutput) : undefined
        this.emit({
          type: "tool",
          callID: update.toolCallId,
          tool,
          state,
          ...(title ? { title } : {}),
          ...(output ? { output } : {}),
        })
        return
      }
      case "session_info_update":
        if (update.title) this.emit({ type: "title", title: update.title })
        return
      case "plan":
        this.flush()
        this.emit({
          type: "plan",
          entries: update.entries.map((entry) => ({
            content: entry.content,
            status: entry.status,
            priority: entry.priority,
          })),
        })
        return
      default:
        return
    }
  }

  private ask(request: RequestPermissionRequest) {
    if (this.replaying || this.closing || request.sessionId !== this.sessionID)
      return Promise.resolve<RequestPermissionResponse>({ outcome: { outcome: "cancelled" } })
    this.flush()
    const requestID = `acp_${++this.requests}_${request.toolCall.toolCallId}`
    const details = request.toolCall.rawInput === undefined ? undefined : JSON.stringify(request.toolCall.rawInput)
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pending.set(requestID, { options: request.options, resolve })
      this.emit({
        type: "permission.requested",
        requestID,
        title: request.toolCall.title ?? "Permission requested",
        ...(request.toolCall.kind ? { tool: request.toolCall.kind } : {}),
        ...(details ? { details: details.slice(0, PREVIEW_LIMIT) } : {}),
        options: request.options.map((option) => ({ id: option.optionId, label: option.name, kind: option.kind })),
      })
    })
  }

  // Text accumulated since the last non-text update becomes complete messages and reasoning.
  private flush() {
    this.text.forEach((item, key) => {
      this.segments.set(key, (this.segments.get(key) ?? 0) + 1)
      if (item.kind === "message")
        this.emit({ type: "message", messageID: item.id, role: "assistant", text: item.value })
      if (item.kind === "reasoning") this.emit({ type: "reasoning", messageID: item.id, text: item.value })
    })
    this.text.clear()
    this.block = undefined
  }
}

function preview(content: readonly ToolCallContent[] | null | undefined, raw: unknown) {
  const text = (content ?? [])
    .flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : []))
    .join("\n")
  const value = text || (typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw))
  return value.slice(0, PREVIEW_LIMIT) || undefined
}

function describe(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return String(error)
}

export * as AcpProvider from "./acp"
