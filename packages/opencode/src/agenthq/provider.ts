// AgentProvider: what every Agent HQ adapter (OpenCode, Claude Code, Cursor, Codex) implements.
// Adapters push normalized AgentEvents through `emit`; the session manager assigns seq,
// persists and publishes. Capabilities are reported honestly and an unsupported action fails
// with UnsupportedError instead of silently doing nothing.
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect, Schema } from "effect"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("AgentHQ.NotFoundError", {
  message: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("AgentHQ.InvalidInputError", {
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

export interface SessionInput {
  readonly agent: AgentHQ.AgentIdentity
  readonly emit: Emit
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
