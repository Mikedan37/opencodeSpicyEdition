export * as Workbench from "./workbench"

// Spicy Workbench shared contract: diagnostics, verification, debugging and
// investigations. Server modules (packages/opencode/src/workbench) and the app
// (packages/app/src/workbench) both build against these shapes. Positions are
// 0-based like LSP; the UI adds 1 when it displays them.

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, statics } from "./schema"

const RunIDSchema = Schema.String.check(Schema.isStartsWith("run")).pipe(Schema.brand("WorkbenchRunID"))
export const RunID = RunIDSchema.pipe(
  statics((schema: typeof RunIDSchema) => ({ create: () => schema.make("run_" + ascending()) })),
)
export type RunID = typeof RunID.Type

const EvidenceIDSchema = Schema.String.check(Schema.isStartsWith("ev")).pipe(Schema.brand("WorkbenchEvidenceID"))
export const EvidenceID = EvidenceIDSchema.pipe(
  statics((schema: typeof EvidenceIDSchema) => ({ create: () => schema.make("ev_" + ascending()) })),
)
export type EvidenceID = typeof EvidenceID.Type

const InvestigationIDSchema = Schema.String.check(Schema.isStartsWith("inv")).pipe(
  Schema.brand("WorkbenchInvestigationID"),
)
export const InvestigationID = InvestigationIDSchema.pipe(
  statics((schema: typeof InvestigationIDSchema) => ({ create: () => schema.make("inv_" + ascending()) })),
)
export type InvestigationID = typeof InvestigationID.Type

const DebugSessionIDSchema = Schema.String.check(Schema.isStartsWith("dbg")).pipe(
  Schema.brand("WorkbenchDebugSessionID"),
)
export const DebugSessionID = DebugSessionIDSchema.pipe(
  statics((schema: typeof DebugSessionIDSchema) => ({ create: () => schema.make("dbg_" + ascending()) })),
)
export type DebugSessionID = typeof DebugSessionID.Type

// ---------------------------------------------------------------- problems

export const Position = Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt })
export const Range = Schema.Struct({ start: Position, end: Position })
export interface Range extends Schema.Schema.Type<typeof Range> {}

export const Severity = Schema.Literals(["error", "warning", "info", "hint"])
export type Severity = typeof Severity.Type

// Origins stay distinct: a failed test assertion is not a compiler error.
export const SourceKind = Schema.Literals(["lsp", "compiler", "typecheck", "linter", "build", "test", "runtime"])
export type SourceKind = typeof SourceKind.Type

export const Related = Schema.Struct({ file: Schema.String, range: optional(Range), message: Schema.String })

export const Problem = Schema.Struct({
  id: Schema.String, // stable: hash(producer, file, code, message, start line)
  file: optional(Schema.String), // absolute path
  range: optional(Range),
  severity: Severity,
  message: Schema.String,
  code: optional(Schema.Union([Schema.String, Schema.Finite])),
  codeHref: optional(Schema.String),
  related: optional(Schema.Array(Related)),
  source: Schema.Struct({
    kind: SourceKind,
    tool: Schema.String, // "clangd", "tsc", "cargo", "pytest", "debugpy"
    producer: Schema.String, // store slice key, e.g. "lsp:clangd:/repo" or "check:tsc:/repo/app/tsconfig.json"
    runID: optional(RunID),
  }),
  observedAt: Schema.Finite,
  stale: Schema.Boolean, // file content changed since this was observed
}).annotate({ identifier: "WorkbenchProblem" })
export interface Problem extends Schema.Schema.Type<typeof Problem> {}

export const ProblemCounts = Schema.Struct({
  error: NonNegativeInt,
  warning: NonNegativeInt,
  info: NonNegativeInt,
  hint: NonNegativeInt,
})
export interface ProblemCounts extends Schema.Schema.Type<typeof ProblemCounts> {}

export const ProblemsSnapshot = Schema.Struct({
  problems: Schema.Array(Problem),
  counts: ProblemCounts,
  producers: Schema.Array(
    Schema.Struct({
      producer: Schema.String,
      kind: SourceKind,
      tool: Schema.String,
      state: Schema.Literals(["idle", "running", "unavailable", "failed"]),
      reason: optional(Schema.String),
      updatedAt: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "WorkbenchProblemsSnapshot" })
export interface ProblemsSnapshot extends Schema.Schema.Type<typeof ProblemsSnapshot> {}

// ---------------------------------------------------------------- verification

// A timeout, a skip, a missing tool or a cancelled run is never a pass.
export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "passed",
  "failed",
  "timed_out",
  "skipped",
  "unavailable",
  "cancelled",
])
export type RunStatus = typeof RunStatus.Type

export const RunInfo = Schema.Struct({
  id: RunID,
  kind: Schema.Literals(["check", "test", "repro"]),
  unit: Schema.String, // tsconfig path, crate dir, go package, Package.swift dir, file
  checker: Schema.String, // "tsc", "clang", "swift", "cargo", "go", "ruff", "mypy", "pytest"...
  command: Schema.Array(Schema.String),
  execClass: Schema.Literals(["inert", "exec"]), // exec = can run project code (build scripts, plugins, tests)
  status: RunStatus,
  reason: optional(Schema.String), // "budget", "needs approval", "tsc not found"...
  startedAt: optional(Schema.Finite),
  finishedAt: optional(Schema.Finite),
  exitCode: optional(Schema.Int),
  counts: optional(ProblemCounts),
  evidenceID: optional(EvidenceID),
}).annotate({ identifier: "WorkbenchRun" })
export interface RunInfo extends Schema.Schema.Type<typeof RunInfo> {}

export const VerificationReport = Schema.Struct({
  id: Schema.String,
  sessionID: optional(Schema.String),
  trigger: Schema.Literals(["agent", "user", "turn-end"]),
  changedFiles: Schema.Array(Schema.String),
  checks: Schema.Array(
    Schema.Struct({
      run: RunInfo,
      newErrors: NonNegativeInt, // errors in files changed this turn
      otherErrors: NonNegativeInt, // errors elsewhere in the unit
    }),
  ),
  summary: Schema.Struct({
    passed: NonNegativeInt,
    failed: NonNegativeInt,
    skipped: NonNegativeInt,
    unavailable: NonNegativeInt,
    timedOut: NonNegativeInt,
  }),
  unverifiedFiles: Schema.Array(Schema.String), // changed files no passing check covers
  completedAt: Schema.Finite,
}).annotate({ identifier: "WorkbenchVerificationReport" })
export interface VerificationReport extends Schema.Schema.Type<typeof VerificationReport> {}

// ---------------------------------------------------------------- debugging

export const Owner = Schema.Literals(["idle", "agent", "human", "terminating"])
export type Owner = typeof Owner.Type

export const Frame = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  file: optional(Schema.String),
  line: optional(NonNegativeInt), // 1-based, as DAP reports it with linesStartAt1
  column: optional(NonNegativeInt),
})

export const VariableView = Schema.Struct({
  name: Schema.String,
  type: optional(Schema.String),
  value: Schema.String, // redacted and capped at 512 characters
  variablesReference: NonNegativeInt, // > 0 means expandable while stopped
})

export const StopSnapshot = Schema.Struct({
  reason: Schema.String, // "breakpoint", "exception", "step", "pause", "entry"
  description: optional(Schema.String),
  threadID: Schema.Int,
  frames: Schema.Array(Frame),
  locals: Schema.Array(VariableView),
  exception: optional(Schema.Struct({ id: optional(Schema.String), description: optional(Schema.String) })),
  evidenceID: optional(EvidenceID),
  at: Schema.Finite,
}).annotate({ identifier: "WorkbenchStopSnapshot" })
export interface StopSnapshot extends Schema.Schema.Type<typeof StopSnapshot> {}

export const DebugSessionInfo = Schema.Struct({
  id: DebugSessionID,
  adapter: Schema.String, // "debugpy", "lldb-dap", "dlv", "js-debug"
  program: optional(Schema.String),
  state: Schema.Literals(["starting", "running", "stopped", "terminated", "failed"]),
  owner: Owner,
  stop: optional(StopSnapshot),
  capabilities: Schema.Array(Schema.String), // DAP capability names reported true by the adapter
  investigationID: optional(InvestigationID),
  error: optional(Schema.String),
  startedAt: Schema.Finite,
}).annotate({ identifier: "WorkbenchDebugSession" })
export interface DebugSessionInfo extends Schema.Schema.Type<typeof DebugSessionInfo> {}

export const ConsoleRow = Schema.Struct({
  seq: NonNegativeInt,
  at: Schema.Finite,
  kind: Schema.Literals(["stdout", "stderr", "console", "eval", "result", "stop", "exception", "system"]),
  by: Schema.Literals(["program", "adapter", "agent", "human", "system"]),
  text: Schema.String,
  variablesReference: optional(NonNegativeInt),
  evidenceID: optional(EvidenceID),
  location: optional(Schema.Struct({ file: Schema.String, line: NonNegativeInt })),
}).annotate({ identifier: "WorkbenchConsoleRow" })
export interface ConsoleRow extends Schema.Schema.Type<typeof ConsoleRow> {}

// ---------------------------------------------------------------- investigations

export const InvestigationStatus = Schema.Literals([
  "created",
  "reproducing",
  "debugging",
  "diagnosing",
  "patching",
  "verifying",
  "resolved",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
  "needs_human",
])
export type InvestigationStatus = typeof InvestigationStatus.Type

export const EvidenceKind = Schema.Literals([
  "repro-run",
  "check-run",
  "test-run",
  "debug-stop",
  "exception",
  "console-eval",
  "patch",
  "verification",
])

// observed and verified are set by the server only. Model-written notes are
// "inferred" and live in Investigation.notes, never in Evidence.
export const Evidence = Schema.Struct({
  id: EvidenceID,
  investigationID: optional(InvestigationID),
  kind: EvidenceKind,
  class: Schema.Literals(["observed", "verified"]),
  summary: Schema.String, // <= 300 characters
  data: optional(Schema.Unknown), // <= 16 KB, redacted
  refs: optional(
    Schema.Struct({
      sessionID: optional(Schema.String),
      partID: optional(Schema.String),
      runID: optional(RunID),
      debugSessionID: optional(DebugSessionID),
    }),
  ),
  at: Schema.Finite,
}).annotate({ identifier: "WorkbenchEvidence" })
export interface Evidence extends Schema.Schema.Type<typeof Evidence> {}

export const RecoveryPolicy = Schema.Struct({
  maxRepairAttempts: NonNegativeInt, // 2
  maxDebugSteps: NonNegativeInt, // 200
  maxInvestigationDurationMs: NonNegativeInt, // 1_800_000
  requireApprovalForExecution: Schema.Boolean, // true
  requireApprovalForAttach: Schema.Boolean, // true
  stopOnRepeatedFailures: Schema.Boolean, // true
  stopOnPermissionDenial: Schema.Boolean, // true
})
export interface RecoveryPolicy extends Schema.Schema.Type<typeof RecoveryPolicy> {}

export const InvestigationSummary = Schema.Struct({
  id: InvestigationID,
  title: Schema.String,
  status: InvestigationStatus,
  sessionID: optional(Schema.String), // agent session that owns it
  agentID: optional(Schema.String), // Agent HQ identity, when started by one
  attempts: NonNegativeInt,
  evidenceCount: NonNegativeInt,
  reason: optional(Schema.String), // latest checkpoint reason, e.g. supervisor rule S2
  updatedAt: Schema.Finite,
}).annotate({ identifier: "WorkbenchInvestigation" })
export interface InvestigationSummary extends Schema.Schema.Type<typeof InvestigationSummary> {}

// ---------------------------------------------------------------- events

const ProblemsUpdated = define({
  type: "workbench.problems.updated",
  schema: {
    producers: Schema.Array(Schema.Struct({ producer: Schema.String, files: Schema.Array(Schema.String) })),
    counts: ProblemCounts,
  },
})
const RunUpdated = define({ type: "workbench.run.updated", schema: { run: RunInfo } })
const RunOutput = define({
  type: "workbench.run.output",
  schema: { runID: RunID, seq: NonNegativeInt, chunk: Schema.String },
})
const DebugUpdated = define({ type: "workbench.debug.updated", schema: { session: DebugSessionInfo } })
const DebugOutput = define({
  type: "workbench.debug.output",
  schema: { sessionID: DebugSessionID, rows: Schema.Array(ConsoleRow) },
})
const InvestigationUpdated = define({
  type: "workbench.investigation.updated",
  schema: { investigation: InvestigationSummary },
})

export const Event = {
  ProblemsUpdated,
  RunUpdated,
  RunOutput,
  DebugUpdated,
  DebugOutput,
  InvestigationUpdated,
  Definitions: inventory(ProblemsUpdated, RunUpdated, RunOutput, DebugUpdated, DebugOutput, InvestigationUpdated),
}
