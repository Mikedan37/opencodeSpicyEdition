import path from "path"
// The low-level Server: the tools' input schemas are Effect Schemas turned into JSON Schema, not zod shapes.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Cause, Exit, Schema } from "effect"
import { ServerAuth } from "@/server/auth"
import { ToolJsonSchema } from "@/tool/json-schema"
import { errorMessage } from "@/util/error"
import { Doctor } from "../doctor"

// Workbench MCP bridge: an MCP server for agents outside opencode (Claude Code, Codex, Cursor) that proxies the
// workbench tools to an already running opencode server over HTTP, so every agent sees the same problems, checks
// and doctor as the IDE. It holds no state and never runs a checker itself.
//
// Safety: checks start with trigger "agent", so the server runs checks that execute project code (build scripts,
// plugins, tests) only when its permission rules allow verify.exec; otherwise they come back skipped with
// "needs approval in the IDE". The request body is built here and unknown arguments are rejected, so a model
// cannot pass its own trigger.

export type Connection = {
  url: string // opencode server, e.g. http://127.0.0.1:4096
  directory: string // project directory the server routes requests to
  username?: string // basic auth; both default to OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD
  password?: string
}

export type Api = {
  get: (route: string, query?: Record<string, string | number | undefined>) => Promise<unknown>
  post: (route: string, body: unknown) => Promise<unknown>
}

export type ToolResult = { text: string; data: Record<string, unknown> }

// One bridge tool. Debug tools (spicy-dap) plug in the same way: `define` them and pass them to `create` or
// `serve` as `extra`, named `debug_*`.
export interface Tool<Input extends Schema.Decoder<unknown> = Schema.Decoder<unknown>> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: Input
  readonly annotations?: ToolAnnotations
  readonly jsonSchema?: Record<string, unknown> // spicy: listed instead of `input`'s, for tools defined by JSON Schema (dap)
  run(args: Input["Type"], api: Api, connection: Connection): Promise<ToolResult>
}

// spicy: extra tools, or a function listing them each time, for tools that change while the bridge runs (dap)
export type Extra = ReadonlyArray<Tool> | ((api: Api) => Promise<ReadonlyArray<Tool>>)

export const define = <Input extends Schema.Decoder<unknown>>(tool: Tool<Input>) => tool

const MAX_PROBLEMS = 50

export const ProblemsInput = Schema.Struct({
  severity: Schema.optional(Workbench.Severity).annotate({ description: "Only problems of this severity" }),
  source: Schema.optional(Workbench.SourceKind).annotate({ description: "Only problems from this kind of producer" }),
  file: Schema.optional(Schema.String).annotate({
    description: "Only problems in this file (absolute, or relative to the project)",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(500)),
  ).annotate({ description: `How many problems to list (default ${MAX_PROBLEMS})` }),
})

export const CheckInput = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Files to check, absolute or relative to the project",
  }),
  unit: Schema.optional(Schema.String).annotate({
    description: "A folder (its source files, at most 200) or one file",
  }),
  tests: Schema.optional(Schema.Boolean).annotate({
    description: "Also run the affected packages' tests (they run project code, so they need verify.exec)",
  }),
})

export const DoctorInput = Schema.Struct({})

export const problems = define({
  name: "workbench_problems",
  title: "Workbench problems",
  description:
    "List the problems opencode knows for this project: language server diagnostics and the results of recent checks and test runs. Stale means the file changed after the problem was seen.",
  input: ProblemsInput,
  annotations: { readOnlyHint: true },
  async run(args, api, connection) {
    const snapshot = fromJson(Workbench.ProblemsSnapshot)(
      await api.get("/workbench/problems", { severity: args.severity, source: args.source, file: args.file }),
    )
    const listed = sorted(snapshot.problems).slice(0, args.limit ?? MAX_PROBLEMS)
    const counts = snapshot.counts
    return {
      text: [
        `${counts.error} errors, ${counts.warning} warnings, ${counts.info} info, ${counts.hint} hints`,
        ...snapshot.producers
          .filter((producer) => producer.state === "unavailable" || producer.state === "failed")
          .map((producer) => `${producer.tool} ${producer.state}: ${producer.reason ?? "no reason given"}`),
        ...(listed.length ? ["", ...listed.map((item) => line(item, connection.directory))] : []),
        ...(snapshot.problems.length > listed.length
          ? [`... and ${snapshot.problems.length - listed.length} more`]
          : []),
      ].join("\n"),
      data: { ...snapshot, problems: listed },
    }
  },
})

export const check = define({
  name: "workbench_check",
  title: "Workbench check",
  description:
    "Run the project's native checkers (tsc, clang, swift, cargo, go, ruff, mypy) on files or a folder through opencode and report the result. Checks that would run project code (build scripts, plugins, macros, tests) are skipped unless opencode's permission rules allow verify.exec; ask the user to approve them in the IDE. A skipped, timed out or unavailable check is not a pass.",
  input: CheckInput,
  async run(args, api, connection) {
    const report = fromJson(Workbench.VerificationReport)(
      await api.post("/workbench/check", { files: args.files, unit: args.unit, tests: args.tests, trigger: "agent" }),
    )
    const runs = new Set(report.checks.map((item) => item.run.id))
    const snapshot = fromJson(Workbench.ProblemsSnapshot)(await api.get("/workbench/problems"))
    const found = sorted(snapshot.problems.filter((item) => item.source.runID && runs.has(item.source.runID)))
    const summary = report.summary
    const relative = (file: string) => path.relative(connection.directory, file) || "."
    return {
      text: [
        report.checks.length
          ? `${summary.passed} passed, ${summary.failed} failed, ${summary.timedOut} timed out, ${summary.skipped} skipped, ${summary.unavailable} unavailable (report ${report.id})`
          : report.changedFiles.length
            ? "No checker covers these files."
            : "Nothing to check: pass files or a unit.",
        ...(found.length
          ? ["", "Problems:", ...found.slice(0, MAX_PROBLEMS).map((item) => line(item, connection.directory))]
          : []),
        ...(found.length > MAX_PROBLEMS ? [`... and ${found.length - MAX_PROBLEMS} more`] : []),
        ...(report.checks.length
          ? [
              "",
              "Runs:",
              ...report.checks.map((item) =>
                [
                  item.run.status,
                  item.run.checker,
                  relative(item.run.unit),
                  item.run.reason ?? "",
                  item.run.exitCode === undefined ? "" : `exit ${item.run.exitCode}`,
                ]
                  .filter(Boolean)
                  .join("  "),
              ),
            ]
          : []),
        ...(report.unverifiedFiles.length
          ? ["", `Unverified: ${report.unverifiedFiles.map(relative).join(", ")}`]
          : []),
      ].join("\n"),
      data: { report, problems: found },
    }
  },
})

export const doctor = define({
  name: "workbench_doctor",
  title: "Workbench doctor",
  description:
    "Show which language servers, checkers, test runners and debug adapters opencode found for each language, and why the missing or broken ones do not work.",
  input: DoctorInput,
  annotations: { readOnlyHint: true },
  async run(_args, api) {
    const report = fromJson(Doctor.Report)(await api.get("/workbench/doctor"))
    return { text: Doctor.table(report), data: report }
  },
})

export const tools: ReadonlyArray<Tool> = [problems, check, doctor]

/** The MCP `inputSchema` of a tool: its Effect Schema as JSON Schema. */
export function inputSchema(tool: Tool) {
  const { $schema: _, ...schema } = ToolJsonSchema.fromSchema(tool.input as Schema.Top)
  return { ...schema, type: "object" as const }
}

/** An MCP server with the workbench tools (plus `extra`), talking to the opencode server in `connection`. */
export function create(connection: Connection, extra: Extra = []) {
  const api = client(connection)
  const all = async () => [...tools, ...(typeof extra === "function" ? await extra(api) : extra)] // spicy: Extra
  const server = new Server(
    { name: "opencode-workbench", version: InstallationVersion },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await all()).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.jsonSchema ? { ...tool.jsonSchema, type: "object" as const } : inputSchema(tool), // spicy
      annotations: tool.annotations,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = (await all()).find((item) => item.name === request.params.name) // spicy: Extra
    if (!tool) return failure(`Unknown tool: ${request.params.name}`)
    const args = Schema.decodeUnknownExit(tool.input, { onExcessProperty: "error" })(request.params.arguments ?? {})
    if (Exit.isFailure(args))
      return failure(`Invalid arguments for ${tool.name}: ${errorMessage(Cause.squash(args.cause))}`)
    return tool.run(args.value, api, connection).then(
      (result) => ({ content: [{ type: "text", text: result.text }], structuredContent: result.data }),
      (error) => failure(errorMessage(error)),
    )
  })
  return server
}

/** Serves the bridge on stdin/stdout until stdin closes. */
export async function serve(connection: Connection, extra: Extra = []) {
  const transport = new StdioServerTransport()
  // the host ends the session by closing our stdin; the transport itself does not report that
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
  })
  await create(connection, extra).connect(transport)
  await closed
}

function client(connection: Connection): Api {
  const headers = {
    "x-opencode-directory": connection.directory,
    ...ServerAuth.headers({ username: connection.username, password: connection.password }),
  }
  const request = async (route: string, init: RequestInit) => {
    const response = await fetch(new URL(route, connection.url), {
      ...init,
      headers: { ...headers, ...init.headers },
    }).catch((error) => {
      throw new Error(`The opencode server at ${connection.url} is not reachable: ${errorMessage(error)}`)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`The opencode server answered ${response.status}: ${text.slice(0, 500)}`)
    return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text)
  }
  return {
    get: (route, query = {}) => {
      const params = new URLSearchParams(
        Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
      )
      return request(params.size ? `${route}?${params}` : route, {})
    },
    post: (route, body) =>
      request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }
}

// Route responses use the schemas' canonical JSON codec (an absent optional field may arrive as null).
function fromJson<T, E>(schema: Schema.Codec<T, E>) {
  return Schema.decodeUnknownSync(Schema.toCodecJson(schema))
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

// Errors first, then by file and line.
function sorted(problems: ReadonlyArray<Workbench.Problem>) {
  const rank = { error: 0, warning: 1, info: 2, hint: 3 }
  return problems.toSorted(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0),
  )
}

function line(item: Workbench.Problem, directory: string) {
  const where = item.file
    ? `${path.relative(directory, item.file)}${item.range ? `:${item.range.start.line + 1}:${item.range.start.character + 1}` : ""}`
    : "(no file)"
  const code = item.code === undefined ? "" : ` ${item.code}`
  const message = item.message.split("\n").slice(0, 6).join("\n  ")
  return `${where} ${item.severity}${code} [${item.source.tool}]${item.stale ? " (stale)" : ""} ${message}`
}

export * as WorkbenchBridge from "./bridge"
