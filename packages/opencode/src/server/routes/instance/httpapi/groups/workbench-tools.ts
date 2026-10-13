// spicy: tool creator routes (owner: dap). Drafts wait for the user: approve, reject, enable and the test run are
// the user's (the IDE), never an agent's. `agent` is how agents outside opencode (the Workbench MCP bridge) draft
// tools and call enabled ones, as the agent of an opencode session whose asks the IDE shows.
import { Workbench } from "@opencode-ai/schema/workbench"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError, ConflictError, ForbiddenError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workbench/tools"
export const WorkbenchToolsPaths = {
  list: root,
  draft: root,
  agent: `${root}/agent`,
  approve: `${root}/:name/approve`,
  reject: `${root}/:name/reject`,
  disable: `${root}/:name/disable`,
  enable: `${root}/:name/enable`,
  run: `${root}/:name/run`,
  remove: `${root}/:name`,
} as const

const params = { name: Schema.String }
const errors = [ApiNotFoundError, InvalidRequestError, ConflictError]
const Reviewed = Schema.Struct({
  hash: Schema.String.annotate({ description: "The hash of the source the user reviewed (from the list)" }),
})
const Args = Schema.Record(Schema.String, Schema.Unknown)

export const AgentPayload = Schema.Struct({
  sessionID: SessionID.annotate({ description: "opencode session the outside agent works in: asks appear there" }),
  tool: Schema.String.annotate({ description: "tool_create, or an enabled custom_<name>" }),
  args: Args,
})

const op = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const WorkbenchToolsApi = HttpApi.make("workbench-tools")
  .add(
    HttpApiGroup.make("workbench-tools")
      .add(
        HttpApiEndpoint.get("list", WorkbenchToolsPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workbench.CustomTool), "Drafts and created tools with their source"),
        }).annotateMerge(op("workbench.tools.list", "List created tools", "Drafts, enabled and disabled tools.")),
        HttpApiEndpoint.post("draft", WorkbenchToolsPaths.draft, {
          query: WorkspaceRoutingQuery,
          payload: Workbench.CustomToolDraft,
          success: described(Workbench.CustomTool, "The draft (invalid, with a reason, when its checks fail)"),
          error: errors,
        }).annotateMerge(op("workbench.tools.draft", "Draft a tool", "The user's own draft; it still needs approval.")),
        HttpApiEndpoint.post("agent", WorkbenchToolsPaths.agent, {
          query: WorkspaceRoutingQuery,
          payload: AgentPayload,
          success: described(Workbench.CustomToolResult, "What the tool returned"),
          error: [...errors, ForbiddenError],
        }).annotateMerge(
          op(
            "workbench.tools.agent",
            "Use tools as an agent",
            "tool_create or an enabled created tool, for an agent outside opencode; custom_* calls ask in the session.",
          ),
        ),
        HttpApiEndpoint.post("approve", WorkbenchToolsPaths.approve, {
          params,
          query: WorkspaceRoutingQuery,
          payload: Reviewed,
          success: described(Workbench.CustomTool, "The enabled tool"),
          error: errors,
        }).annotateMerge(
          op("workbench.tools.approve", "Approve a draft", "Make the reviewed draft a live custom_<name> tool."),
        ),
        HttpApiEndpoint.post("reject", WorkbenchToolsPaths.reject, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Draft deleted"),
          error: errors,
        }).annotateMerge(op("workbench.tools.reject", "Reject a draft", "Delete the draft.")),
        HttpApiEndpoint.post("disable", WorkbenchToolsPaths.disable, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(Workbench.CustomTool, "The disabled tool"),
          error: errors,
        }).annotateMerge(op("workbench.tools.disable", "Disable a tool", "Take it out of every agent's tools.")),
        HttpApiEndpoint.post("enable", WorkbenchToolsPaths.enable, {
          params,
          query: WorkspaceRoutingQuery,
          payload: Reviewed,
          success: described(Workbench.CustomTool, "The enabled tool"),
          error: errors,
        }).annotateMerge(op("workbench.tools.enable", "Enable a tool", "Bring a disabled tool back.")),
        HttpApiEndpoint.post("run", WorkbenchToolsPaths.run, {
          params,
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ args: Args }),
          success: described(Workbench.CustomToolResult, "What the tool returned"),
          error: errors,
        }).annotateMerge(op("workbench.tools.run", "Test run", "Run an enabled tool for the user.")),
        HttpApiEndpoint.delete("remove", WorkbenchToolsPaths.remove, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Tool and draft deleted"),
          error: errors,
        }).annotateMerge(
          op("workbench.tools.remove", "Delete a tool", "Delete the tool, disabled or not, and its draft."),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "workbench-tools", description: "Tool creator routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "opencode HttpApi", version: "0.0.1", description: "Tool creator routes." }),
  )
