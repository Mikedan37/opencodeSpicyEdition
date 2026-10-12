// Every HTTP call the fork's UI makes (Agent HQ + Workbench) lives here so route paths and payload shapes can be
// adjusted in one place during integration. Routes: docs/SPICY_IDE_MASTER_PLAN.md. Responses are decoded against the
// shared contracts; a reply that does not decode is an error, never data.
import { Option, Schema } from "effect"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Workbench } from "@opencode-ai/schema/workbench"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export class WorkbenchRequestError extends Error {
  // "unavailable": 404 or a non-JSON reply, i.e. this server has no fork routes yet.
  readonly kind: "unavailable" | "failed"
  constructor(kind: "unavailable" | "failed", message: string) {
    super(message)
    this.kind = kind
  }
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type AgentDraft = {
  name: string
  avatar: AgentHQ.AgentIdentity["avatar"]
  provider: AgentHQ.ProviderID
  // null clears the field on update (AgentRegistry.UpdateInput); creation omits it
  model?: string | null
  specialty?: string | null
  projectDirectory: string
}

// GET /agenthq/sessions/:id (`SessionDetail` in groups/agenthq.ts)
const SessionDetail = Schema.Struct({
  session: AgentHQ.AgentSessionInfo,
  history: Schema.Array(AgentHQ.AgentEventEnvelope),
})

// GET /workbench/runs/:runID: the run plus its capped output. Assumed shape until spicy-problems lands the route.
const RunDetail = Schema.Struct({ run: Workbench.RunInfo, output: Schema.String })

export type CheckInput = { files?: string[]; units?: string[] }

const decoders = {
  providers: Schema.decodeUnknownOption(Schema.Array(AgentHQ.ProviderStatus)),
  agents: Schema.decodeUnknownOption(Schema.Array(AgentHQ.AgentIdentity)),
  agent: Schema.decodeUnknownOption(AgentHQ.AgentIdentity),
  sessions: Schema.decodeUnknownOption(Schema.Array(AgentHQ.AgentSessionInfo)),
  session: Schema.decodeUnknownOption(AgentHQ.AgentSessionInfo),
  detail: Schema.decodeUnknownOption(SessionDetail),
  problems: Schema.decodeUnknownOption(Workbench.ProblemsSnapshot),
  runs: Schema.decodeUnknownOption(Schema.Array(Workbench.RunInfo)),
  run: Schema.decodeUnknownOption(RunDetail),
  report: Schema.decodeUnknownOption(Workbench.VerificationReport),
}

export type WorkbenchClient = ReturnType<typeof createWorkbenchClient>

export function createWorkbenchClient(input: {
  server: ServerConnection.HttpBase
  directory: string
  fetch?: (input: URL, init: RequestInit) => Promise<Response>
}) {
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(input.server.url.replace(/\/+$/, "") + path)
    url.searchParams.set("directory", input.directory)
    const response = await (input.fetch ?? globalThis.fetch)(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.server.password
          ? {
              authorization: `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`,
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new WorkbenchRequestError(
        response.ok || response.status === 404 ? "unavailable" : "failed",
        `${method} ${path}: ${response.status}`,
      )
    const value: unknown = await response.json()
    if (response.status === 404) throw new WorkbenchRequestError("unavailable", serverMessage(value) ?? `${path}: 404`)
    if (!response.ok)
      throw new WorkbenchRequestError("failed", serverMessage(value) ?? `${method} ${path}: ${response.status}`)
    return value
  }
  const decoded = <T>(decode: (value: unknown) => Option.Option<T>, method: string, path: string, body?: unknown) =>
    call(method, path, body).then((value) => {
      const result = decode(value)
      if (Option.isNone(result)) throw new WorkbenchRequestError("failed", `${method} ${path}: unexpected response`)
      return result.value
    })
  const agent = (id: string) => `/agenthq/agents/${encodeURIComponent(id)}`
  const session = (id: string) => `/agenthq/sessions/${encodeURIComponent(id)}`

  return {
    providers: () => decoded(decoders.providers, "GET", "/agenthq/providers"),
    agents: () => decoded(decoders.agents, "GET", "/agenthq/agents"),
    createAgent: (draft: AgentDraft) => decoded(decoders.agent, "POST", "/agenthq/agents", draft),
    updateAgent: (id: string, draft: Partial<AgentDraft>) => decoded(decoders.agent, "PATCH", agent(id), draft),
    removeAgent: (id: string) => call("DELETE", agent(id)),
    sessions: (agentID: string) => decoded(decoders.sessions, "GET", `${agent(agentID)}/sessions`),
    startSession: (agentID: string) => decoded(decoders.session, "POST", `${agent(agentID)}/sessions`, {}),
    session: (id: string) => decoded(decoders.detail, "GET", session(id)),
    send: (id: string, text: string) => call("POST", `${session(id)}/messages`, { text }),
    // The reply is the updated info when it decodes; the session.updated event covers it otherwise.
    cancel: (id: string) =>
      call("POST", `${session(id)}/cancel`).then((value) => Option.getOrUndefined(decoders.session(value))),
    respond: (id: string, requestID: string, optionID: string) =>
      call("POST", `${session(id)}/permissions/${encodeURIComponent(requestID)}`, { optionID }),
    problems: () => decoded(decoders.problems, "GET", "/workbench/problems"),
    runs: () => decoded(decoders.runs, "GET", "/workbench/runs"),
    run: (id: string) => decoded(decoders.run, "GET", `/workbench/runs/${encodeURIComponent(id)}`),
    check: (body: CheckInput = {}) => decoded(decoders.report, "POST", "/workbench/check", body),
  }
}

function serverMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const record = value as { message?: unknown; error?: unknown; data?: { message?: unknown } }
  if (typeof record.message === "string") return record.message
  if (typeof record.error === "string") return record.error
  if (typeof record.data?.message === "string") return record.data.message
}
