// Every HTTP call the fork's UI makes (Agent HQ + Workbench) lives here so route paths and payload shapes can be
// adjusted in one place during integration. Routes: docs/SPICY_IDE_MASTER_PLAN.md. Responses are decoded against the
// shared contracts; a reply that does not decode is an error, never data.
import { Option, Schema } from "effect"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Review } from "@opencode-ai/schema/review"
import { Workbench } from "@opencode-ai/schema/workbench"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import type { SearchQuery } from "./search"

export class WorkbenchRequestError extends Error {
  // "unavailable": 404 or a non-JSON reply, i.e. this server has no fork routes yet.
  readonly kind: "unavailable" | "failed"
  readonly status?: number // HTTP status of a JSON error reply (409 = the server refused on purpose)
  constructor(kind: "unavailable" | "failed", message: string, status?: number) {
    super(message)
    this.kind = kind
    this.status = status
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

// GET /workbench/runs/:runID (`RunRecord` in groups/workbench.ts on spicy-problems): output capped at 256 KB.
const RunDetail = Schema.Struct({
  run: Workbench.RunInfo,
  output: Schema.String,
  truncated: Schema.optional(Schema.Boolean),
})

// POST /workbench/check (`CheckPayload`): files, or a folder/file as `unit` (its source files, at most 200).
export type CheckInput = { files?: string[]; unit?: string; tests?: boolean }

// Debugger routes (groups/workbench-debug.ts; docs/spicy/notes-dap.md "UI reference"). Requests act as the human.
const DebugBreakpointsResult = Schema.Struct({
  file: Schema.optional(Schema.String),
  breakpoints: Schema.Array(
    Schema.Struct({ line: Schema.Int, verified: Schema.Boolean, message: Schema.optional(Schema.String) }),
  ),
  exceptions: Schema.optional(Schema.Array(Schema.String)),
})
export type DebugBreakpointsResult = typeof DebugBreakpointsResult.Type
export type DebugBreakpointsInput = {
  file?: string
  breakpoints?: { line: number; condition?: string; hitCondition?: string; logMessage?: string }[]
  exceptions?: string[]
}
const DebugCompletion = Schema.Struct({
  label: Schema.String,
  text: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  start: Schema.optional(Schema.Int),
  length: Schema.optional(Schema.Int),
})
export type DebugCompletion = typeof DebugCompletion.Type
export type DebugAction = "continue" | "pause" | "next" | "stepIn" | "stepOut"

// The IDE editor's file access (groups/workbench.ts `FileText` / `FileWritten`): exact text and the hash of its bytes.
const FileText = Schema.Struct({ content: Schema.String, hash: Schema.String })
const FileWritten = Schema.Struct({ hash: Schema.String })

// Project search (groups/workbench-search.ts `SearchResult`): matching lines by file, each file with the hash of its
// bytes when searched (absent when the editor does not open it); `listed` of `total` matches were sent.
const SearchResult = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      hash: Schema.optional(Schema.String),
      lines: Schema.Array(Schema.Struct({ line: Schema.Int, text: Schema.String })),
    }),
  ),
  listed: Schema.Int,
  total: Schema.Int,
})
export type SearchResult = typeof SearchResult.Type

// Agent HQ orchestration (groups/agenthq.ts; docs/spicy/notes-agenthq.md "Routes (wave 2)"). `description: null`
// clears it on edit.
export type TaskDraft = {
  title: string
  description?: string | null
  assignee: string
  dependsOn?: string[]
  isolated?: boolean
}
export type MessageDraft = { from?: string; to: string; text: string; taskID?: string; relay?: boolean }

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
  debugSessions: Schema.decodeUnknownOption(Schema.Array(Workbench.DebugSessionInfo)),
  debugSession: Schema.decodeUnknownOption(Workbench.DebugSessionInfo),
  debugBreakpoints: Schema.decodeUnknownOption(DebugBreakpointsResult),
  debugVariables: Schema.decodeUnknownOption(Schema.Array(Workbench.VariableView)),
  debugRow: Schema.decodeUnknownOption(Workbench.ConsoleRow),
  debugRows: Schema.decodeUnknownOption(Schema.Array(Workbench.ConsoleRow)),
  debugCompletions: Schema.decodeUnknownOption(Schema.Array(DebugCompletion)),
  debugScopes: Schema.decodeUnknownOption(Schema.Array(Workbench.DebugScope)),
  changeset: Schema.decodeUnknownOption(Review.ChangeSet),
  changesets: Schema.decodeUnknownOption(Schema.Array(Review.ChangeSet)),
  content: Schema.decodeUnknownOption(Review.Content),
  tasks: Schema.decodeUnknownOption(Schema.Array(AgentHQ.Task)),
  task: Schema.decodeUnknownOption(AgentHQ.Task),
  taskReview: Schema.decodeUnknownOption(AgentHQ.TaskReview),
  messages: Schema.decodeUnknownOption(Schema.Array(AgentHQ.AgentMessage)),
  message: Schema.decodeUnknownOption(AgentHQ.AgentMessage),
  investigations: Schema.decodeUnknownOption(Schema.Array(Workbench.InvestigationSummary)),
  investigation: Schema.decodeUnknownOption(Workbench.InvestigationDetail),
  investigationSummary: Schema.decodeUnknownOption(Workbench.InvestigationSummary),
  fileText: Schema.decodeUnknownOption(FileText),
  tools: Schema.decodeUnknownOption(Schema.Array(Workbench.CustomTool)),
  tool: Schema.decodeUnknownOption(Workbench.CustomTool),
  toolResult: Schema.decodeUnknownOption(Workbench.CustomToolResult),
  fileWritten: Schema.decodeUnknownOption(FileWritten),
  lspHover: Schema.decodeUnknownOption(Schema.NullOr(Workbench.LspHover)),
  lspLocations: Schema.decodeUnknownOption(Schema.Array(Workbench.LspLocation)),
  searchResult: Schema.decodeUnknownOption(SearchResult),
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
    if (response.status === 404)
      throw new WorkbenchRequestError("unavailable", serverMessage(value) ?? `${path}: 404`, 404)
    if (!response.ok)
      throw new WorkbenchRequestError(
        "failed",
        serverMessage(value) ?? `${method} ${path}: ${response.status}`,
        response.status,
      )
    return value
  }
  const decoded = <T>(decode: (value: unknown) => Option.Option<T>, method: string, path: string, body?: unknown) =>
    call(method, path, body).then((value) => {
      const result = decode(value)
      if (Option.isNone(result)) throw new WorkbenchRequestError("failed", `${method} ${path}: unexpected response`)
      return result.value
    })
  const debug = (id: string) => `/workbench/debug/sessions/${encodeURIComponent(id)}`
  const task = (id: string) => `/agenthq/tasks/${encodeURIComponent(id)}`
  const investigation = (id: string) => `/workbench/investigations/${encodeURIComponent(id)}`
  const agent = (id: string) => `/agenthq/agents/${encodeURIComponent(id)}`
  const session = (id: string) => `/agenthq/sessions/${encodeURIComponent(id)}`
  const changeset = (id: string) => `/review/changesets/${encodeURIComponent(id)}`
  const tool = (name: string) => `/workbench/tools/${encodeURIComponent(name)}`
  // Code intelligence (groups/workbench.ts `workbench.lsp.*`): a 0-based line and UTF-16 column in a project file.
  const lsp = (route: string, path: string, at: { line: number; character: number }) =>
    `/workbench/lsp/${route}?${new URLSearchParams({ path, line: String(at.line), character: String(at.character) })}`

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
    // 409 when the file no longer hashes to baseHash (null: it must not exist); 403 outside the project.
    readFile: (path: string) => decoded(decoders.fileText, "GET", `/workbench/file?path=${encodeURIComponent(path)}`),
    writeFile: (body: { path: string; content: string; baseHash: string | null }) =>
      decoded(decoders.fileWritten, "PUT", "/workbench/file", body),
    // Empty answers (null, []) when the file has no language server or it knows nothing there.
    lspHover: (path: string, at: { line: number; character: number }) =>
      decoded(decoders.lspHover, "GET", lsp("hover", path, at)),
    lspDefinition: (path: string, at: { line: number; character: number }) =>
      decoded(decoders.lspLocations, "GET", lsp("definition", path, at)),
    lspReferences: (path: string, at: { line: number; character: number }) =>
      decoded(decoders.lspLocations, "GET", lsp("references", path, at)),
    // Tool creator (groups/workbench-tools.ts). Approve and enable send the hash of the reviewed source: 409 when the
    // file changed since. The test run is the user's own call and does not ask.
    tools: () => decoded(decoders.tools, "GET", "/workbench/tools"),
    createTool: (draft: Workbench.CustomToolDraft) => decoded(decoders.tool, "POST", "/workbench/tools", draft),
    approveTool: (name: string, hash: string) => decoded(decoders.tool, "POST", `${tool(name)}/approve`, { hash }),
    enableTool: (name: string, hash: string) => decoded(decoders.tool, "POST", `${tool(name)}/enable`, { hash }),
    disableTool: (name: string) => decoded(decoders.tool, "POST", `${tool(name)}/disable`),
    rejectTool: (name: string) => call("POST", `${tool(name)}/reject`),
    removeTool: (name: string) => call("DELETE", tool(name)),
    runTool: (name: string, args: Record<string, unknown>) =>
      decoded(decoders.toolResult, "POST", `${tool(name)}/run`, { args }),
    runs: () => decoded(decoders.runs, "GET", "/workbench/runs"),
    run: (id: string) => decoded(decoders.run, "GET", `/workbench/runs/${encodeURIComponent(id)}`),
    check: (body: CheckInput = {}) => decoded(decoders.report, "POST", "/workbench/check", body),
    debugSessions: () => decoded(decoders.debugSessions, "GET", "/workbench/debug/sessions"),
    debugStart: (input: Workbench.DebugStartInput) =>
      decoded(decoders.debugSession, "POST", "/workbench/debug/sessions", input),
    debugControl: (id: string, action: DebugAction) =>
      decoded(decoders.debugSession, "POST", `${debug(id)}/control`, { action }),
    debugBreakpoints: (id: string, body: DebugBreakpointsInput) =>
      decoded(decoders.debugBreakpoints, "POST", `${debug(id)}/breakpoints`, body),
    debugVariables: (id: string, ref: number, start = 0) =>
      decoded(decoders.debugVariables, "GET", `${debug(id)}/variables?ref=${ref}&start=${start}`),
    // `watch` and `hover` only return the result (seq 0): no console rows, no output event. `repl` is the console's.
    debugEvaluate: (id: string, expression: string, frameID?: number, context?: Workbench.DebugEvaluateContext) =>
      decoded(decoders.debugRow, "POST", `${debug(id)}/evaluate`, { expression, frameID, context }),
    // The scopes of a frame of the current stop (404 for a frame of an older stop); children via debugVariables.
    debugScopes: (id: string, frameID: number) =>
      decoded(decoders.debugScopes, "GET", `${debug(id)}/scopes?frameID=${frameID}`),
    // `column` is the 1-based cursor position in `text`.
    debugCompletions: (id: string, text: string, column: number, frameID?: number) =>
      decoded(
        decoders.debugCompletions,
        "GET",
        `${debug(id)}/completions?${new URLSearchParams({
          text,
          column: String(column),
          ...(frameID === undefined ? {} : { frameID: String(frameID) }),
        })}`,
      ),
    debugOutput: (id: string, after = 0) => decoded(decoders.debugRows, "GET", `${debug(id)}/output?after=${after}`),
    debugOwner: (id: string, owner: "idle" | "agent" | "human") =>
      decoded(decoders.debugSession, "POST", `${debug(id)}/owner`, { owner }),
    debugStop: (id: string) => decoded(decoders.debugSession, "DELETE", debug(id)),
    // Answers a permission ask: the Debug Console's debug.lldbCommand, whose session is synthetic.
    replyPermission: (id: string, reply: "once" | "always" | "reject") =>
      call("POST", `/permission/${encodeURIComponent(id)}/reply`, { reply }),
    // Review (spicy-review, docs/spicy/notes-review.md). Every decision returns the updated changeset.
    changesets: () => decoded(decoders.changesets, "GET", "/review/changesets"),
    content: (id: string, path: string) =>
      decoded(decoders.content, "GET", `${changeset(id)}/content?path=${encodeURIComponent(path)}`),
    decideHunk: (id: string, hunkID: string, action: Review.Action) =>
      decoded(decoders.changeset, "POST", `${changeset(id)}/hunks/${encodeURIComponent(hunkID)}`, { action }),
    decideFile: (id: string, path: string, action: Review.Action) =>
      decoded(decoders.changeset, "POST", `${changeset(id)}/files`, { path, action }),
    decideAll: (id: string, action: Review.Action) =>
      decoded(decoders.changeset, "POST", `${changeset(id)}/all`, { action }),
    undo: (id: string, path: string) => decoded(decoders.changeset, "POST", `${changeset(id)}/undo`, { path }),
    tasks: () => decoded(decoders.tasks, "GET", "/agenthq/tasks"),
    createTask: (draft: TaskDraft) => decoded(decoders.task, "POST", "/agenthq/tasks", draft),
    updateTask: (id: string, draft: Partial<TaskDraft>) => decoded(decoders.task, "PATCH", task(id), draft),
    removeTask: (id: string) => call("DELETE", task(id)),
    startTask: (id: string) => decoded(decoders.task, "POST", `${task(id)}/start`),
    cancelTask: (id: string) => decoded(decoders.task, "POST", `${task(id)}/cancel`),
    // Dry run of approving: what merging the task's branch would bring in, as of the branch commit `head`. Touches
    // nothing outside the task's own branch.
    taskReview: (id: string) => decoded(decoders.taskReview, "GET", `${task(id)}/review`),
    // Merges exactly the reviewed `head`; the server refuses when the task changed since that review.
    approveTask: (id: string, head?: string) => decoded(decoders.task, "POST", `${task(id)}/approve`, { head }),
    messages: (filter: { taskID?: string; agentID?: string }) =>
      decoded(
        decoders.messages,
        "GET",
        `/agenthq/messages?${new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => !!entry[1]))}`,
      ),
    sendMessage: (draft: MessageDraft) => decoded(decoders.message, "POST", "/agenthq/messages", draft),
    investigations: () => decoded(decoders.investigations, "GET", "/workbench/investigations"),
    investigation: (id: string) => decoded(decoders.investigation, "GET", investigation(id)),
    resumeInvestigation: (id: string) => decoded(decoders.investigationSummary, "POST", `${investigation(id)}/resume`),
    cancelInvestigation: (id: string) => decoded(decoders.investigationSummary, "POST", `${investigation(id)}/cancel`),
    // A 400 carries ripgrep's message for a pattern or glob it refuses.
    search: (query: SearchQuery) =>
      decoded(
        decoders.searchResult,
        "GET",
        `/workbench/search?${new URLSearchParams({
          query: query.pattern,
          ...(query.regex ? { regex: "true" } : {}),
          ...(query.caseSensitive ? { case: "true" } : {}),
          ...(query.word ? { word: "true" } : {}),
          ...(query.include.trim() ? { include: query.include } : {}),
          ...(query.exclude.trim() ? { exclude: query.exclude } : {}),
        })}`,
      ),
  }
}

function serverMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const record = value as { message?: unknown; error?: unknown; data?: { message?: unknown } }
  if (typeof record.message === "string") return record.message
  if (typeof record.error === "string") return record.error
  if (typeof record.data?.message === "string") return record.data.message
}
