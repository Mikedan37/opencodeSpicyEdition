// AgentProvider: what every Agent HQ adapter (OpenCode, Claude Code, Cursor, Codex) implements.
// Adapters push normalized AgentEvents through `emit`; the session manager assigns seq,
// persists and publishes. Capabilities are reported honestly and an unsupported action fails
// with UnsupportedError instead of silently doing nothing.
import { Pty } from "@opencode-ai/core/pty"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect, Schema } from "effect"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("AgentHQ.NotFoundError", {
  message: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("AgentHQ.InvalidInputError", {
  message: Schema.String,
}) {}

/** The request conflicts with the current state (a task that is not ready, a dirty project, a merge conflict). */
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("AgentHQ.ConflictError", {
  message: Schema.String,
}) {}

export class UnsupportedError extends Schema.TaggedErrorClass<UnsupportedError>()("AgentHQ.UnsupportedError", {
  provider: AgentHQ.ProviderID,
  action: Schema.String,
  message: Schema.String,
}) {}

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()("AgentHQ.ProviderError", {
  provider: AgentHQ.ProviderID,
  message: Schema.String,
}) {}

export type Emit = (event: AgentHQ.AgentEvent) => void

export interface Session {
  readonly providerSessionID: string
  /** Starts a turn and returns once the provider accepted it; progress arrives through `emit`. */
  readonly send: (text: string) => Effect.Effect<void, ProviderError>
  readonly cancel: Effect.Effect<void, ProviderError>
  readonly respondPermission?: (
    requestID: string,
    optionID: string,
  ) => Effect.Effect<void, NotFoundError | InvalidInputError | ProviderError>
  /** Stops observing the provider session. Emits nothing afterwards. */
  readonly close: Effect.Effect<void>
}

/**
 * The environment for every process a provider spawns: this process's environment without the opencode server's
 * credentials. The Workbench MCP server gets a token of its own instead, through its own `env`. Shells the agent
 * starts are not the Terminal.app window opencode came from either (Pty.ownTerminal: no macOS session files).
 */
export function agentEnv() {
  const env = Pty.ownTerminal({ ...process.env }) // spicy(dap): see Pty.ownTerminal
  delete env.OPENCODE_SERVER_USERNAME
  delete env.OPENCODE_SERVER_PASSWORD
  delete env.OPENCODE_SERVER_TOKEN
  return env
}

/** A stdio MCP server to give the agent: the Workbench tools (see ./workbench.ts). */
export interface McpServer {
  readonly name: string
  readonly command: string
  /** Never carries a secret. */
  readonly args: readonly string[]
  /** The bridge's own token (OPENCODE_SERVER_TOKEN), never the server password, and nothing else. Never logged or stored. */
  readonly env: Readonly<Record<string, string>>
}

export interface SessionInput {
  readonly agent: AgentHQ.AgentIdentity
  readonly emit: Emit
  /** Absent when this process cannot serve the Workbench tools (it has no HTTP listener). */
  readonly workbench?: McpServer
}

export interface Interface {
  readonly id: AgentHQ.ProviderID
  readonly status: Effect.Effect<AgentHQ.ProviderStatus>
  readonly createSession: (
    input: SessionInput & { readonly title?: string },
  ) => Effect.Effect<Session, UnsupportedError | ProviderError>
  readonly resumeSession?: (
    input: SessionInput & { readonly providerSessionID: string },
  ) => Effect.Effect<Session, UnsupportedError | ProviderError>
}

export * as AgentProvider from "./provider"
