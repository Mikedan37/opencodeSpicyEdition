import { Workbench } from "@opencode-ai/schema/workbench"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Doctor } from "@/workbench/doctor"
import { ApiNotFoundError, ConflictError, ForbiddenError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workbench"

export const ProblemsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  severity: Schema.optional(Workbench.Severity),
  source: Schema.optional(Workbench.SourceKind),
  file: Schema.optional(Schema.String).annotate({ description: "Absolute path, or relative to the directory" }),
})

export const CheckPayload = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Files to check, absolute or relative to the directory",
  }),
  unit: Schema.optional(Schema.String).annotate({
    description: "A folder (its source files, gitignore-aware, at most 200) or one file",
  }),
  tests: Schema.optional(Schema.Boolean).annotate({ description: "Also run the affected packages' tests" }),
  trigger: Schema.optional(Schema.Literals(["user", "agent"])).annotate({
    description:
      "user (default): started by a person in the IDE, so checks that run project code run. agent: started by an agent outside opencode (the MCP bridge); those checks run only when the permission rules allow verify.exec, otherwise they are skipped with the reason.",
  }),
})

export const RunRecord = Schema.Struct({
  run: Workbench.RunInfo,
  output: Schema.String.annotate({ description: "stdout and stderr as they arrived, capped at 256 KB" }),
  truncated: Schema.Boolean,
}).annotate({ identifier: "WorkbenchRunRecord" })

// The IDE editor's file access (src/workbench/editor-file.ts).
export const FileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String.annotate({ description: "Absolute, or relative to the directory" }),
})

export const FileText = Schema.Struct({
  content: Schema.String.annotate({ description: "The file's text exactly as on disk (UTF-8, BOM kept)" }),
  hash: Schema.String.annotate({ description: "sha256 of the file's bytes: the baseHash of the next write" }),
}).annotate({ identifier: "WorkbenchFileText" })

export const FileWritePayload = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute, or relative to the directory" }),
  content: Schema.String,
  baseHash: Schema.NullOr(Schema.String).annotate({
    description: "hash of the bytes this edit started from; null when the file must not exist yet",
  }),
})

export const BridgeSession = Schema.Struct({ id: SessionID }).annotate({ identifier: "WorkbenchBridgeSession" })

export const FileWritten = Schema.Struct({
  hash: Schema.String.annotate({ description: "sha256 of the bytes written" }),
}).annotate({ identifier: "WorkbenchFileWritten" })

export const WorkbenchApi = HttpApi.make("workbench")
  .add(
    HttpApiGroup.make("workbench")
      .add(
        HttpApiEndpoint.get("problems", `${root}/problems`, {
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
        HttpApiEndpoint.post("check", `${root}/check`, {
          query: WorkspaceRoutingQuery,
          payload: CheckPayload,
          success: described(Workbench.VerificationReport, "Verification report"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.check",
            summary: "Run checks",
            description:
              "Run the native checkers (and optionally tests) on files or a folder and return the verification report.",
          }),
        ),
        HttpApiEndpoint.get("runs", `${root}/runs`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workbench.RunInfo), "Recent runs, newest first"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.runs",
            summary: "List runs",
            description: "The 100 most recent check and test runs of this instance, newest first.",
          }),
        ),
        HttpApiEndpoint.get("run", `${root}/runs/:runID`, {
          params: { runID: Workbench.RunID },
          query: WorkspaceRoutingQuery,
          success: described(RunRecord, "The run and its output"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.run",
            summary: "Get run",
            description: "One recent run with the output it printed.",
          }),
        ),
        HttpApiEndpoint.get("file", `${root}/file`, {
          query: FileQuery,
          success: described(FileText, "The file's text and the hash of its bytes"),
          error: [ApiNotFoundError, InvalidRequestError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.file.read",
            summary: "Read a file to edit",
            description:
              "A text file inside the project, exactly as on disk, with the sha256 of its bytes. Binary files, files over 8 MB and paths outside the project (symlinks resolved) are refused.",
          }),
        ),
        HttpApiEndpoint.put("writeFile", `${root}/file`, {
          query: WorkspaceRoutingQuery,
          payload: FileWritePayload,
          success: described(FileWritten, "The hash of the bytes written"),
          error: [ApiNotFoundError, InvalidRequestError, ForbiddenError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.file.write",
            summary: "Save a file from the editor",
            description:
              "Replaces a file inside the project (symlinks resolved) through a temporary file and a rename, only when its bytes still hash to baseHash; otherwise answers 409 and writes nothing. Language servers are told about the change, so its problems refresh.",
          }),
        ),
        HttpApiEndpoint.post("session", `${root}/session`, {
          query: WorkspaceRoutingQuery,
          success: described(BridgeSession, "The session the bridge's agent tools act in"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.session",
            summary: "Workbench MCP session",
            description:
              "A session titled Workbench MCP for the Workbench MCP bridge's agent tools (debug_*, tool_create, custom_*); their permission asks appear there. A bridge token always gets its one session, made on its first call.",
          }),
        ),
        HttpApiEndpoint.get("doctor", `${root}/doctor`, {
          query: WorkspaceRoutingQuery,
          success: described(Doctor.Report, "Per language: LSP, checkers, test runners and debug adapters"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.doctor",
            summary: "Workbench doctor",
            description: "Which language servers, checkers, test runners and debug adapters are present and runnable.",
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
