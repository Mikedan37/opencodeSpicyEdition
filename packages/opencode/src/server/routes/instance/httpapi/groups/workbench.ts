import { Workbench } from "@opencode-ai/schema/workbench"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ProblemsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  severity: Schema.optional(Workbench.Severity),
  source: Schema.optional(Workbench.SourceKind),
  file: Schema.optional(Schema.String).annotate({ description: "Absolute path, or relative to the directory" }),
})

export const WorkbenchApi = HttpApi.make("workbench")
  .add(
    HttpApiGroup.make("workbench")
      .add(
        HttpApiEndpoint.get("problems", "/workbench/problems", {
          query: ProblemsQuery,
          success: described(Workbench.ProblemsSnapshot, "Problems with counts and producer states"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.problems",
            summary: "List problems",
            description:
              "Problems reported by language servers and verification runs, with stale flags for files changed since.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "workbench", description: "Workbench problem and verification routes." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
