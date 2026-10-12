export * as AgentHQ from "./agent-hq"

// Spicy Agent HQ shared contract. An agent identity (name, avatar, provider,
// project) is separate from provider sessions: an identity stays available while
// its provider process is stopped, and one identity can own many sessions.
// Server: packages/opencode/src/agenthq. UI: packages/app/src/agenthq.

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, statics } from "./schema"

const AgentIDSchema = Schema.String.check(Schema.isStartsWith("agt")).pipe(Schema.brand("AgentHQAgentID"))
export const AgentID = AgentIDSchema.pipe(
  statics((schema: typeof AgentIDSchema) => ({ create: () => schema.make("agt_" + ascending()) })),
)
export type AgentID = typeof AgentID.Type

const AgentSessionIDSchema = Schema.String.check(Schema.isStartsWith("ags")).pipe(Schema.brand("AgentHQSessionID"))
export const AgentSessionID = AgentSessionIDSchema.pipe(
  statics((schema: typeof AgentSessionIDSchema) => ({ create: () => schema.make("ags_" + ascending()) })),
)
export type AgentSessionID = typeof AgentSessionID.Type

// "acp": a custom Agent Client Protocol agent launched with the identity's `launch` command.
export const ProviderID = Schema.Literals(["opencode", "claude-code", "codex", "cursor", "acp"])
export type ProviderID = typeof ProviderID.Type

// Every adapter reports these honestly; the UI hides or disables what is false.
export const ProviderCapabilities = Schema.Struct({
  streaming: Schema.Boolean,
  toolEvents: Schema.Boolean,
  permissionRequests: Schema.Boolean,
  cancel: Schema.Boolean,
  resume: Schema.Boolean,
  models: Schema.Boolean,
  mcpTools: Schema.Boolean, // can be given the Workbench MCP bridge
  notes: optional(Schema.Array(Schema.String)),
})
export interface ProviderCapabilities extends Schema.Schema.Type<typeof ProviderCapabilities> {}

export const ProviderStatus = Schema.Struct({
  id: ProviderID,
  name: Schema.String,
  available: Schema.Boolean, // binary or runtime found and runnable
  version: optional(Schema.String),
  auth: Schema.Literals(["ok", "required", "unknown"]), // never carries credentials
  reason: optional(Schema.String), // why unavailable, e.g. "cursor-agent 2025.09.12 has no ACP mode"
  capabilities: ProviderCapabilities,
}).annotate({ identifier: "AgentHQProviderStatus" })
export interface ProviderStatus extends Schema.Schema.Type<typeof ProviderStatus> {}

export const Avatar = Schema.Struct({
  kind: Schema.Literals(["preset", "emoji", "initials"]),
  value: Schema.String, // preset id ("fox", "octopus", "owl", "robot"...), an emoji, or initials
  color: optional(Schema.String), // theme token name, not a raw color
})

export const AgentIdentity = Schema.Struct({
  id: AgentID,
  name: Schema.String,
  avatar: Avatar,
  provider: ProviderID,
  model: optional(Schema.String),
  specialty: optional(Schema.String),
  projectDirectory: Schema.String,
  workingDirectory: optional(Schema.String), // a git worktree when isolated
  // Provider "acp" only: the ACP agent to spawn over stdio. Never put secrets in args.
  launch: optional(Schema.Struct({ command: Schema.String, args: Schema.Array(Schema.String) })),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "AgentHQAgent" })
export interface AgentIdentity extends Schema.Schema.Type<typeof AgentIdentity> {}

export const AgentSessionStatus = Schema.Literals([
  "starting",
  "idle",
  "thinking",
  "working",
  "needs_approval",
  "blocked",
  "completed",
  "failed",
  "disconnected",
  "interrupted",
  "cancelled",
])
export type AgentSessionStatus = typeof AgentSessionStatus.Type

export const AgentSessionInfo = Schema.Struct({
  id: AgentSessionID,
  agentID: AgentID,
  provider: ProviderID,
  providerSessionID: optional(Schema.String), // opencode session id, Claude session id, ACP session id
  title: optional(Schema.String),
  status: AgentSessionStatus,
  pendingPermissions: NonNegativeInt,
  error: optional(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "AgentHQSession" })
export interface AgentSessionInfo extends Schema.Schema.Type<typeof AgentSessionInfo> {}

export const PermissionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
})

// Normalized events every adapter emits. Provider-specific detail goes in
// optional fields rather than new event types.
export const AgentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("status"), status: AgentSessionStatus }),
  Schema.Struct({
    type: Schema.Literal("message"),
    messageID: Schema.String,
    role: Schema.Literals(["user", "assistant", "system"]),
    text: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("message.delta"), messageID: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), messageID: Schema.String, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    callID: Schema.String,
    tool: Schema.String,
    state: Schema.Literals(["started", "running", "completed", "error"]),
    title: optional(Schema.String),
    output: optional(Schema.String), // capped preview
  }),
  Schema.Struct({
    type: Schema.Literal("permission.requested"),
    requestID: Schema.String,
    title: Schema.String,
    tool: optional(Schema.String),
    details: optional(Schema.String),
    options: Schema.Array(PermissionOption),
  }),
  Schema.Struct({
    type: Schema.Literal("permission.resolved"),
    requestID: Schema.String,
    outcome: Schema.Literals(["allowed", "rejected", "cancelled"]),
  }),
  Schema.Struct({ type: Schema.Literal("file.changed"), path: Schema.String }),
  // The agent's current plan; each event replaces the previous one.
  Schema.Struct({
    type: Schema.Literal("plan"),
    entries: Schema.Array(
      Schema.Struct({
        content: Schema.String,
        status: Schema.Literals(["pending", "in_progress", "completed"]),
        priority: optional(Schema.Literals(["high", "medium", "low"])),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    stopReason: optional(Schema.String),
    // What the turn cost, when the provider reports it.
    usage: optional(
      Schema.Struct({ inputTokens: Schema.Finite, outputTokens: Schema.Finite, costUSD: optional(Schema.Finite) }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]).annotate({ identifier: "AgentHQEvent" })
export type AgentEvent = typeof AgentEvent.Type

export const AgentEventEnvelope = Schema.Struct({
  sessionID: AgentSessionID,
  seq: NonNegativeInt, // per session, gap-free; the UI resyncs from history on a gap
  at: Schema.Finite,
  event: AgentEvent,
}).annotate({ identifier: "AgentHQEventEnvelope" })
export interface AgentEventEnvelope extends Schema.Schema.Type<typeof AgentEventEnvelope> {}

// ---------------------------------------------------------------- events

const AgentUpdated = define({ type: "agenthq.agent.updated", schema: { agent: AgentIdentity } })
const AgentRemoved = define({ type: "agenthq.agent.removed", schema: { id: AgentID } })
const ProviderUpdated = define({ type: "agenthq.provider.updated", schema: { provider: ProviderStatus } })
const SessionUpdated = define({ type: "agenthq.session.updated", schema: { session: AgentSessionInfo } })
const SessionEvent = define({ type: "agenthq.session.event", schema: { envelope: AgentEventEnvelope } })

export const Event = {
  AgentUpdated,
  AgentRemoved,
  ProviderUpdated,
  SessionUpdated,
  SessionEvent,
  Definitions: inventory(AgentUpdated, AgentRemoved, ProviderUpdated, SessionUpdated, SessionEvent),
}
