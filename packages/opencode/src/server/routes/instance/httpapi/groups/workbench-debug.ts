// spicy: Workbench debug routes (owner: dap). Sessions are per project; events
// workbench.debug.updated / workbench.debug.output carry the same shapes.
import { Workbench } from "@opencode-ai/schema/workbench"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Parameters as DebugToolParameters } from "@/workbench/tool/debug"
import {
  ApiNotFoundError,
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  TimeoutError,
  UpstreamError,
} from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workbench/debug/sessions"
export const WorkbenchDebugPaths = {
  list: root,
  start: root,
  control: `${root}/:debugSessionID/control`,
  breakpoints: `${root}/:debugSessionID/breakpoints`,
  variables: `${root}/:debugSessionID/variables`,
  scopes: `${root}/:debugSessionID/scopes`,
  evaluate: `${root}/:debugSessionID/evaluate`,
  completions: `${root}/:debugSessionID/completions`,
  output: `${root}/:debugSessionID/output`,
  owner: `${root}/:debugSessionID/owner`,
  stop: `${root}/:debugSessionID`,
  investigations: "/workbench/investigations",
  investigation: "/workbench/investigations/:investigationID",
  resume: "/workbench/investigations/:investigationID/resume",
  cancel: "/workbench/investigations/:investigationID/cancel",
  agent: "/workbench/debug/agent",
} as const

const params = { debugSessionID: Workbench.DebugSessionID }
const errors = [
  ApiNotFoundError,
  InvalidRequestError,
  ConflictError,
  ServiceUnavailableError,
  UpstreamError,
  TimeoutError,
]
const Count = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

// One action of the agent's debug tool, for agents outside opencode (the Workbench MCP bridge). Same fields as the
// in-process tool; the session is where permission asks appear and what owns the debug session and investigation.
export const AgentPayload = Schema.Struct({
  sessionID: SessionID.annotate({
    description: "opencode session the outside agent works in: debug.* permission asks appear there",
  }),
  ...DebugToolParameters.fields,
})

export const AgentResult = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "WorkbenchDebugAgentResult" })

export const BreakpointsPayload = Schema.Struct({
  file: Schema.optional(Schema.String).annotate({ description: "Replace every breakpoint in this file" }),
  breakpoints: Schema.optional(
    Schema.Array(
      Schema.Struct({
        line: Schema.Int.check(Schema.isGreaterThan(0)),
        condition: Schema.optional(Schema.String),
        hitCondition: Schema.optional(Schema.String),
        logMessage: Schema.optional(Schema.String),
      }),
    ),
  ),
  functions: Schema.optional(Schema.Array(Schema.String)),
  exceptions: Schema.optional(Schema.Array(Schema.String)),
})

const Verified = Schema.Struct({ verified: Schema.Boolean, message: Schema.optional(Schema.String) })
export const BreakpointsResult = Schema.Struct({
  file: Schema.optional(Schema.String),
  breakpoints: Schema.Array(Schema.Struct({ line: Schema.Int, ...Verified.fields })),
  functions: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, ...Verified.fields }))),
  exceptions: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "WorkbenchDebugBreakpoints" })

export const Completion = Schema.Struct({
  label: Schema.String,
  text: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  start: Schema.optional(Schema.Int),
  length: Schema.optional(Schema.Int),
}).annotate({ identifier: "WorkbenchDebugCompletion" })

const op = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const WorkbenchDebugApi = HttpApi.make("workbench-debug")
  .add(
    HttpApiGroup.make("workbench-debug")
      .add(
        HttpApiEndpoint.get("list", WorkbenchDebugPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workbench.DebugSessionInfo), "Debug sessions of this project"),
        }).annotateMerge(op("workbench.debug.list", "List debug sessions", "Live and recently ended debug sessions.")),
        HttpApiEndpoint.post("start", WorkbenchDebugPaths.start, {
          query: WorkspaceRoutingQuery,
          payload: Workbench.DebugStartInput,
          success: described(Workbench.DebugSessionInfo, "Started session"),
          error: errors,
        }).annotateMerge(
          op(
            "workbench.debug.start",
            "Start a debug session",
            "Launch a program for the user and run to the first stop.",
          ),
        ),
        HttpApiEndpoint.post("control", WorkbenchDebugPaths.control, {
          params,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ action: Schema.Literals(["continue", "pause", "next", "stepIn", "stepOut"]) }),
          success: described(Workbench.DebugSessionInfo, "Session after the command was accepted"),
          error: errors,
        }).annotateMerge(
          op("workbench.debug.control", "Run or step", "Continue, pause or step; the stop arrives as an event."),
        ),
        HttpApiEndpoint.post("breakpoints", WorkbenchDebugPaths.breakpoints, {
          params,
          query: WorkspaceRoutingQuery,
          payload: BreakpointsPayload,
          success: described(BreakpointsResult, "Breakpoints as the adapter verified them"),
          error: errors,
        }).annotateMerge(
          op("workbench.debug.breakpoints", "Set breakpoints", "Replace a file's breakpoints or set filters."),
        ),
        HttpApiEndpoint.get("variables", WorkbenchDebugPaths.variables, {
          params,
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, ref: Count, start: Schema.optional(Count) }),
          success: described(Schema.Array(Workbench.VariableView), "One page (50) of children"),
          error: errors,
        }).annotateMerge(
          op("workbench.debug.variables", "Read variables", "Children of a variable reference while stopped."),
        ),
        HttpApiEndpoint.get("scopes", WorkbenchDebugPaths.scopes, {
          params,
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            frameID: Schema.NumberFromString.check(Schema.isInt()),
          }),
          success: described(Schema.Array(Workbench.DebugScope), "Scopes of the frame"),
          error: errors,
        }).annotateMerge(
          op(
            "workbench.debug.scopes",
            "Read frame scopes",
            "Scopes (Locals, Globals, ...) of a frame of the current stop; their children come from the variables route.",
          ),
        ),
        HttpApiEndpoint.post("evaluate", WorkbenchDebugPaths.evaluate, {
          params,
          query: WorkspaceRoutingQuery,
          payload: Workbench.DebugEvaluateInput,
          success: described(Workbench.ConsoleRow, "Result row (seq 0 for watch and hover: not a console row)"),
          error: [...errors, ForbiddenError], // a raw LLDB command the user did not allow (debug.lldbCommand)
        }).annotateMerge(
          op("workbench.debug.evaluate", "Evaluate", "Run an expression in a stack frame (runs program code)."),
        ),
        HttpApiEndpoint.get("completions", WorkbenchDebugPaths.completions, {
          params,
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            text: Schema.String,
            column: Schema.optional(Count),
            frameID: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
          }),
          success: described(Schema.Array(Completion), "Completion items"),
          error: errors,
        }).annotateMerge(op("workbench.debug.completions", "Complete", "Console completions from the adapter.")),
        HttpApiEndpoint.get("output", WorkbenchDebugPaths.output, {
          params,
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, after: Schema.optional(Count) }),
          success: described(Schema.Array(Workbench.ConsoleRow), "Console rows after the given row"),
          error: errors,
        }).annotateMerge(
          op("workbench.debug.output", "Console rows", "Program output, evaluations and stops (256 KB cap)."),
        ),
        HttpApiEndpoint.post("owner", WorkbenchDebugPaths.owner, {
          params,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ owner: Schema.Literals(["idle", "agent", "human"]) }),
          success: described(Workbench.DebugSessionInfo, "Session with its new owner"),
          error: errors,
        }).annotateMerge(op("workbench.debug.owner", "Change owner", "Take over, hand to the agent, or release.")),
        HttpApiEndpoint.delete("stop", WorkbenchDebugPaths.stop, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(Workbench.DebugSessionInfo, "Ended session"),
          error: errors,
        }).annotateMerge(op("workbench.debug.stop", "Stop", "End the session and kill the program's process tree.")),
        HttpApiEndpoint.post("agent", WorkbenchDebugPaths.agent, {
          query: WorkspaceRoutingQuery,
          payload: AgentPayload,
          success: described(AgentResult, "What the debug tool returned"),
          error: [...errors, ForbiddenError],
        }).annotateMerge(
          op(
            "workbench.debug.agent",
            "Debug as an agent",
            "Run one action of the agent's debug tool for an agent outside opencode. debug.* permissions apply and are asked in the given session; nothing is approved here.",
          ),
        ),
        HttpApiEndpoint.get("investigations", WorkbenchDebugPaths.investigations, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workbench.InvestigationSummary), "Investigations of this project"),
        }).annotateMerge(
          op("workbench.investigation.list", "List investigations", "Persisted investigations, newest first."),
        ),
        HttpApiEndpoint.get("investigation", WorkbenchDebugPaths.investigation, {
          params: { investigationID: Workbench.InvestigationID },
          query: WorkspaceRoutingQuery,
          success: described(Workbench.InvestigationDetail, "Record, evidence and report"),
          error: errors,
        }).annotateMerge(
          op("workbench.investigation.get", "Get investigation", "The full record with its evidence and report."),
        ),
        HttpApiEndpoint.post("resume", WorkbenchDebugPaths.resume, {
          params: { investigationID: Workbench.InvestigationID },
          query: WorkspaceRoutingQuery,
          success: described(Workbench.InvestigationSummary, "Resumed investigation"),
          error: errors,
        }).annotateMerge(
          op("workbench.investigation.resume", "Resume", "Relaunch the stored target of an interrupted investigation."),
        ),
        HttpApiEndpoint.post("cancel", WorkbenchDebugPaths.cancel, {
          params: { investigationID: Workbench.InvestigationID },
          query: WorkspaceRoutingQuery,
          success: described(Workbench.InvestigationSummary, "Cancelled investigation"),
          error: errors,
        }).annotateMerge(op("workbench.investigation.cancel", "Cancel", "Cancel and stop its debug sessions.")),
      )
      .annotateMerge(OpenApi.annotations({ title: "workbench-debug", description: "Workbench debug routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "opencode HttpApi", version: "0.0.1", description: "Workbench debug routes." }),
  )
