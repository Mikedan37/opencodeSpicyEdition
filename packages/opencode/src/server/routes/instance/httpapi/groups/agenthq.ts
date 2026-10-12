import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { AgentRegistry } from "@/agenthq/registry"
import { ApiNotFoundError, ConflictError, InvalidRequestError, UpstreamError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/agenthq"

// projectDirectory defaults to the directory of the instance that serves the request.
export const CreateAgentPayload = Schema.Struct({
  ...AgentRegistry.CreateInput.fields,
  projectDirectory: Schema.optional(Schema.String),
})
export const UpdateAgentPayload = AgentRegistry.UpdateInput
export const StartSessionPayload = Schema.Struct({ title: Schema.optional(Schema.String) })
export const SendPayload = Schema.Struct({ text: Schema.String })
export const PermissionPayload = Schema.Struct({ optionID: Schema.String })
export const SessionDetail = Schema.Struct({
  session: AgentHQ.AgentSessionInfo,
  history: Schema.Array(AgentHQ.AgentEventEnvelope),
}).annotate({ identifier: "AgentHQSessionDetail" })

const agentParams = { agentID: AgentHQ.AgentID }
const sessionParams = { sessionID: AgentHQ.AgentSessionID }

function doc(identifier: string, summary: string) {
  return OpenApi.annotations({ identifier, summary })
}

export const AgentHQApi = HttpApi.make("agenthq").add(
  HttpApiGroup.make("agenthq")
    .add(
      HttpApiEndpoint.get("providers", `${root}/providers`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(AgentHQ.ProviderStatus), "Provider availability and capabilities"),
      }).annotateMerge(doc("agenthq.providers", "List Agent HQ providers")),
      HttpApiEndpoint.get("agents", `${root}/agents`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(AgentHQ.AgentIdentity), "All agent identities"),
      }).annotateMerge(doc("agenthq.agents.list", "List agent identities")),
      HttpApiEndpoint.post("createAgent", `${root}/agents`, {
        query: WorkspaceRoutingQuery,
        payload: CreateAgentPayload,
        success: described(AgentHQ.AgentIdentity, "Created identity"),
        error: [InvalidRequestError],
      }).annotateMerge(doc("agenthq.agents.create", "Create an agent identity")),
      HttpApiEndpoint.patch("updateAgent", `${root}/agents/:agentID`, {
        params: agentParams,
        query: WorkspaceRoutingQuery,
        payload: UpdateAgentPayload,
        success: described(AgentHQ.AgentIdentity, "Updated identity"),
        error: [ApiNotFoundError, InvalidRequestError],
      }).annotateMerge(doc("agenthq.agents.update", "Update an agent identity")),
      HttpApiEndpoint.delete("removeAgent", `${root}/agents/:agentID`, {
        params: agentParams,
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Identity and its sessions removed"),
        error: [ApiNotFoundError],
      }).annotateMerge(doc("agenthq.agents.remove", "Remove an agent identity")),
      HttpApiEndpoint.get("sessions", `${root}/agents/:agentID/sessions`, {
        params: agentParams,
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(AgentHQ.AgentSessionInfo), "Sessions of the identity"),
        error: [ApiNotFoundError],
      }).annotateMerge(doc("agenthq.sessions.list", "List an agent's sessions")),
      HttpApiEndpoint.post("startSession", `${root}/agents/:agentID/sessions`, {
        params: agentParams,
        query: WorkspaceRoutingQuery,
        payload: StartSessionPayload,
        success: described(AgentHQ.AgentSessionInfo, "Started session"),
        error: [ApiNotFoundError, ConflictError, UpstreamError],
      }).annotateMerge(doc("agenthq.sessions.start", "Start a provider session for an agent")),
      HttpApiEndpoint.get("session", `${root}/sessions/:sessionID`, {
        params: sessionParams,
        query: WorkspaceRoutingQuery,
        success: described(SessionDetail, "Session info and compacted history"),
        error: [ApiNotFoundError],
      }).annotateMerge(doc("agenthq.sessions.get", "Get an agent session with its history")),
      HttpApiEndpoint.post("sendMessage", `${root}/sessions/:sessionID/messages`, {
        params: sessionParams,
        query: WorkspaceRoutingQuery,
        payload: SendPayload,
        success: described(Schema.Boolean, "Message accepted; progress arrives as agenthq.session.event"),
        error: [ApiNotFoundError, InvalidRequestError, ConflictError, UpstreamError],
      }).annotateMerge(doc("agenthq.sessions.message", "Send a message to an agent session")),
      HttpApiEndpoint.post("cancelSession", `${root}/sessions/:sessionID/cancel`, {
        params: sessionParams,
        query: WorkspaceRoutingQuery,
        success: described(AgentHQ.AgentSessionInfo, "Session after cancel"),
        error: [ApiNotFoundError, ConflictError, UpstreamError],
      }).annotateMerge(doc("agenthq.sessions.cancel", "Cancel the running turn")),
      HttpApiEndpoint.post("respondPermission", `${root}/sessions/:sessionID/permissions/:requestID`, {
        params: { ...sessionParams, requestID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: PermissionPayload,
        success: described(Schema.Boolean, "Reply accepted"),
        error: [ApiNotFoundError, InvalidRequestError, ConflictError, UpstreamError],
      }).annotateMerge(doc("agenthq.sessions.permission", "Answer a provider permission request")),
    )
    .annotateMerge(OpenApi.annotations({ title: "agenthq", description: "Spicy Agent HQ routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
