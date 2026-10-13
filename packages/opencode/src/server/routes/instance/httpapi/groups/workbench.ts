import { Workbench } from "@opencode-ai/schema/workbench"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Doctor } from "@/workbench/doctor"
import { WorkbenchApprovals } from "@/workbench/approvals"
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

// The main chat's per-session auto-approve switches (src/workbench/auto-approve.ts).
export const AutoApprove = Schema.Struct({
  edits: Schema.Boolean.annotate({
    description: "Edits (edit, write, apply_patch) in this session run without asking, except under .git/",
  }),
  commands: Schema.Boolean.annotate({ description: "Shell commands in this session run without asking" }),
  enabled: Schema.Boolean.annotate({
    description: "Both switches on (edits && commands): the single switch's shape, which installed apps still read",
  }),
}).annotate({ identifier: "WorkbenchAutoApprove" })

// What PUT takes: either switch, or `enabled` for both (the single switch's shape); a field left out keeps its value.
export const AutoApproveUpdate = Schema.Struct({
  edits: Schema.optional(Schema.Boolean),
  commands: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean).annotate({ description: "Sets both switches; edits/commands win over it" }),
}).annotate({ identifier: "WorkbenchAutoApproveUpdate" })

// "Always allow in this project" (src/workbench/approvals.ts): allow rules saved from permission asks.
export const Approvals = Schema.Struct({
  rules: Schema.Array(WorkbenchApprovals.Rule),
}).annotate({ identifier: "WorkbenchApprovals" })

export const FileWritePayload = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute, or relative to the directory" }),
  content: Schema.String,
  baseHash: Schema.NullOr(Schema.String).annotate({
    description: "hash of the bytes this edit started from; null when the file must not exist yet",
  }),
})

export const BridgeSession = Schema.Struct({ id: SessionID }).annotate({ identifier: "WorkbenchBridgeSession" })

// The IDE editor's code intelligence (src/workbench/editor-lsp.ts): a 0-based position, UTF-16 columns as in LSP.
const Count = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const LspQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String.annotate({ description: "A file inside the project: absolute, or relative to the directory" }),
  line: Count.annotate({ description: "0-based line" }),
  character: Count.annotate({ description: "0-based UTF-16 column" }),
})

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const LspSyncPayload = Schema.Struct({
  path: Schema.String.annotate({ description: "A file inside the project: absolute, or relative to the directory" }),
  text: Schema.optional(Schema.String).annotate({
    description: "The editor's unsaved text; without it the language servers read the file on disk again",
  }),
})

export const LspRenamePayload = Schema.Struct({
  path: Schema.String.annotate({ description: "A file inside the project: absolute, or relative to the directory" }),
  line: Position.annotate({ description: "0-based line" }),
  character: Position.annotate({ description: "0-based UTF-16 column" }),
  newName: Schema.String.check(Schema.isNonEmpty()),
  sessionID: SessionID.annotate({ description: "The session whose review changeset holds the edits" }),
})

export const LspFormatPayload = Schema.Struct({
  path: Schema.String.annotate({ description: "A file inside the project: absolute, or relative to the directory" }),
  text: Schema.String.annotate({ description: "The editor's text to format" }),
  tabSize: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  insertSpaces: Schema.optional(Schema.Boolean),
})

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
        HttpApiEndpoint.get("lspHover", `${root}/lsp/hover`, {
          query: LspQuery,
          success: described(Schema.NullOr(Workbench.LspHover), "The hover text as markdown, or null"),
          error: [ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.hover",
            summary: "Hover",
            description:
              "What the file's language servers say about the symbol at a position, as markdown. Null when no server answers, there is none for the file, or language servers are off.",
          }),
        ),
        HttpApiEndpoint.get("lspDefinition", `${root}/lsp/definition`, {
          query: LspQuery,
          success: described(Schema.Array(Workbench.LspLocation), "Where the symbol is defined"),
          error: [ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.definition",
            summary: "Go to definition",
            description:
              "The definitions of the symbol at a position. Files outside the project directory are marked outside; empty when no server answers.",
          }),
        ),
        HttpApiEndpoint.get("lspReferences", `${root}/lsp/references`, {
          query: LspQuery,
          success: described(Schema.Array(Workbench.LspLocation), "Every reference, the declaration included"),
          error: [ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.references",
            summary: "Find references",
            description:
              "The references to the symbol at a position, sorted by file and line, each with its line's text. Empty when no server answers.",
          }),
        ),
        HttpApiEndpoint.post("lspSync", `${root}/lsp/sync`, {
          query: WorkspaceRoutingQuery,
          payload: LspSyncPayload,
          success: described(Schema.Boolean, "The language servers have the text"),
          error: [ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.sync",
            summary: "Send the editor's text",
            description:
              "Gives the file's language servers the editor's unsaved text (a full didChange), or without text the file on disk again, so completion, hover and diagnostics follow what the editor shows.",
          }),
        ),
        HttpApiEndpoint.get("lspCompletion", `${root}/lsp/completion`, {
          query: LspQuery,
          success: described(Workbench.LspCompletionList, "Completion items, at most 1000"),
          error: [ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.completion",
            summary: "Completion",
            description:
              "What the file's language servers offer at a position, as plain text (snippets flattened). Empty when no server answers.",
          }),
        ),
        HttpApiEndpoint.post("lspRename", `${root}/lsp/rename`, {
          query: WorkspaceRoutingQuery,
          payload: LspRenamePayload,
          success: described(Workbench.LspRename, "The files written and their review changeset"),
          error: [ApiNotFoundError, ForbiddenError, InvalidRequestError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.rename",
            summary: "Rename a symbol",
            description:
              "Renames the symbol at a position through the file's language servers: writes the edited files and records them as pending hunks of the session's review changeset, where they are accepted or rejected. Refused when it would change files outside the project or create, rename or delete files, and when the project keeps no snapshots.",
          }),
        ),
        HttpApiEndpoint.post("lspFormat", `${root}/lsp/format`, {
          query: WorkspaceRoutingQuery,
          payload: LspFormatPayload,
          success: described(Workbench.LspFormat, "Edits, the formatted text, or neither"),
          error: [ApiNotFoundError, ForbiddenError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.lsp.format",
            summary: "Format the editor's text",
            description:
              "Formats the editor's text with the file's language servers (edits against that text), else with opencode's formatter for the file (the whole text). Nothing is written.",
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
        HttpApiEndpoint.get("autoApprove", `${root}/sessions/:sessionID/auto-approve`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(AutoApprove, "Whether the session auto-approves edits and shell commands"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.autoApprove.get",
            summary: "Session auto-approve",
            description:
              "Whether edits (edit, write, apply_patch) and shell commands run without asking in this session.",
          }),
        ),
        HttpApiEndpoint.put("setAutoApprove", `${root}/sessions/:sessionID/auto-approve`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AutoApproveUpdate,
          success: described(AutoApprove, "The session's switches after the change"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.autoApprove.set",
            summary: "Set session auto-approve",
            description:
              "Sets this session's two switches. With edits on, edits (edit, write, apply_patch) run without asking except under .git/; with commands on, shell commands do. Other sessions, subagents, MCP tools, edits outside the project and a user's rules for specific files or commands keep applying, and every deny still applies (plan mode stays read-only). Not available to Workbench bridge tokens.",
          }),
        ),
        HttpApiEndpoint.post("saveApproval", `${root}/permissions/:requestID/save`, {
          params: { requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Approvals, "The project's saved rules, the new ones included"),
          error: [ApiNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.approvals.save",
            summary: "Always allow in this project",
            description:
              'Answers a pending permission request with "always" and saves its always-patterns, under its permission, for this project: every session of the project, subagents included, then skips that ask. Saved rules never lift a deny, and never approve edits under .git/. 404 when the request is not pending; 400 when it has no always-patterns. Not available to Workbench bridge tokens.',
          }),
        ),
        HttpApiEndpoint.get("approvals", `${root}/approvals`, {
          query: WorkspaceRoutingQuery,
          success: described(Approvals, "The project's saved rules"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.approvals.list",
            summary: "Saved approvals",
            description: 'The allow rules saved for this project with "Always allow in this project".',
          }),
        ),
        HttpApiEndpoint.delete("removeApproval", `${root}/approvals`, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchApprovals.Rule,
          success: described(Approvals, "The project's remaining saved rules"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.approvals.remove",
            summary: "Remove a saved approval",
            description:
              "Removes one saved rule; the next matching request asks again. Not available to Workbench bridge tokens.",
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
