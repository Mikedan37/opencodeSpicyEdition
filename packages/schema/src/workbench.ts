export * as Workbench from "./workbench"

// Spicy Workbench shared contract: diagnostics, verification, debugging and
// investigations. Server modules (packages/opencode/src/workbench) and the app
// (packages/app/src/workbench) both build against these shapes. Positions are
// 0-based like LSP; the UI adds 1 when it displays them.

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema"

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
  // PTY running the program when the adapter asked for a terminal (runInTerminal); attach with /pty/:ptyID/connect.
  ptyID: optional(Schema.String),
}).annotate({ identifier: "WorkbenchDebugSession" })
export interface DebugSessionInfo extends Schema.Schema.Type<typeof DebugSessionInfo> {}

export const DebugAdapter = Schema.Literals(["debugpy", "lldb-dap"])
export type DebugAdapter = typeof DebugAdapter.Type

export const DebugBreakpoint = Schema.Struct({
  file: Schema.String.annotate({ description: "Source file, absolute or relative to the project" }),
  line: PositiveInt.annotate({ description: "1-based line" }),
  condition: optional(Schema.String.annotate({ description: "Stop only when this expression is true" })),
  hitCondition: optional(Schema.String.annotate({ description: "Stop on this hit count, e.g. >= 3" })),
  logMessage: optional(Schema.String.annotate({ description: "Log this message instead of stopping" })),
})
export interface DebugBreakpoint extends Schema.Schema.Type<typeof DebugBreakpoint> {}

// What to debug. POST /workbench/debug/sessions takes it as the body; the agent's debug tool takes the same fields.
export const DebugStartInput = Schema.Struct({
  configuration: optional(Schema.String.annotate({ description: "Name of a configuration in .vscode/launch.json" })),
  program: optional(
    Schema.String.annotate({
      description:
        "Program to debug (a .py file, a native binary), the test file for python-test, or the crate folder for rust-test",
    }),
  ),
  args: optional(Schema.Array(Schema.String)),
  cwd: optional(Schema.String),
  adapter: optional(DebugAdapter),
  preset: optional(
    Schema.Literals(["python-test", "rust-test"]).annotate({
      description:
        "python-test runs the program file under pytest (unittest when pytest is missing). rust-test builds the crate (default: the project) with cargo test --no-run and debugs its unit-test binary; args go to the test binary, a test name filter first",
    }),
  ),
  stopOnEntry: optional(Schema.Boolean),
  breakpoints: optional(Schema.Array(DebugBreakpoint)),
  exceptions: optional(
    Schema.Array(Schema.String).annotate({
      description: "Exception filters, e.g. uncaught, raised, userUnhandled (debugpy) or cpp_throw (lldb-dap)",
    }),
  ),
  file: optional(Schema.String.annotate({ description: "Value of ${file} in launch.json" })),
}).annotate({ identifier: "WorkbenchDebugStartInput" })
export interface DebugStartInput extends Schema.Schema.Type<typeof DebugStartInput> {}

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

// One scope of a stack frame (GET /workbench/debug/sessions/:id/scopes?frameID=), e.g. Locals or Globals. Its
// children come from the variables route with `variablesReference`; open `expensive` scopes only on demand.
export const DebugScope = Schema.Struct({
  name: Schema.String, // redacted and capped at 512 characters
  variablesReference: NonNegativeInt,
  expensive: optional(Schema.Boolean),
}).annotate({ identifier: "WorkbenchDebugScope" })
export interface DebugScope extends Schema.Schema.Type<typeof DebugScope> {}

// Where an evaluation comes from. watch and hover results are only returned: no console row, no
// workbench.debug.output event, and the returned row has seq 0. They still run program code.
export const DebugEvaluateContext = Schema.Literals(["watch", "repl", "hover"])
export type DebugEvaluateContext = typeof DebugEvaluateContext.Type

// Body of POST /workbench/debug/sessions/:id/evaluate.
export const DebugEvaluateInput = Schema.Struct({
  expression: Schema.String,
  frameID: optional(Schema.Int.annotate({ description: "A frame of the current stop; default: the top frame" })),
  context: optional(
    DebugEvaluateContext.annotate({ description: "Default repl, the only one that adds console rows" }),
  ),
}).annotate({ identifier: "WorkbenchDebugEvaluateInput" })
export interface DebugEvaluateInput extends Schema.Schema.Type<typeof DebugEvaluateInput> {}

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

export const InvestigationNote = Schema.Struct({
  kind: Schema.Literals(["hypothesis", "question"]),
  text: Schema.String,
  at: Schema.Finite,
})

// One repair attempt: the edits since the previous check, closed by the next check.
export const InvestigationAttempt = Schema.Struct({
  n: NonNegativeInt,
  patchHash: Schema.String, // over the edited files and their content hashes (supervisor S3)
  changes: Schema.Array(Schema.Struct({ file: Schema.String, hash: Schema.String })),
  errorFingerprints: Schema.Array(Schema.String), // tool|code|file|message, numbers normalized (S2)
  errorCount: NonNegativeInt, // errors in changed files (S4)
  checkIDs: Schema.Array(Schema.String), // run IDs of the check that closed it
  passed: optional(Schema.Boolean), // unset while open
  at: Schema.Finite,
})

export const InvestigationCheckpoint = Schema.Struct({
  status: InvestigationStatus,
  at: Schema.Finite,
  reason: optional(Schema.String),
  evidenceID: optional(EvidenceID),
})

// The full record (GET /workbench/investigations/:id). Written by the server only.
export const Investigation = Schema.Struct({
  id: InvestigationID,
  projectID: Schema.String,
  directory: Schema.String,
  sessionID: optional(Schema.String),
  agentID: optional(Schema.String),
  title: Schema.String,
  status: InvestigationStatus,
  policy: RecoveryPolicy,
  target: optional(DebugStartInput), // how to reproduce; resume relaunches it after asking
  attempts: Schema.Array(InvestigationAttempt),
  evidence: Schema.Array(EvidenceID), // in order
  notes: Schema.Array(InvestigationNote), // model-written, inferred
  checkpoints: Schema.Array(InvestigationCheckpoint), // every status change, with the reason
  processes: Schema.Array(
    Schema.Struct({ pid: NonNegativeInt, command: Schema.String, startedAt: optional(Schema.String) }),
  ),
  debugSessions: Schema.Array(DebugSessionID),
  steps: NonNegativeInt, // debug steps in the current budget window (S5)
  crashes: NonNegativeInt, // debug adapter crashes (S8)
  since: Schema.Finite, // budget window start: creation or the last resume (S6)
  seq: NonNegativeInt, // event order
  lastPatch: optional(NonNegativeInt), // seq of the last patch
  checkPassed: optional(NonNegativeInt), // seq of the last passing check
  reproPassed: optional(NonNegativeInt), // seq of the last passing reproduction
  unverified: Schema.Array(Schema.String), // changed files no passing check covers
  // The opencode process (and service instance) that owns active work; restart recovery leaves live owners alone.
  host: Schema.Struct({ pid: NonNegativeInt, startedAt: optional(Schema.String), token: optional(Schema.String) }),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "WorkbenchInvestigationRecord" })
export interface Investigation extends Schema.Schema.Type<typeof Investigation> {}

export const InvestigationDetail = Schema.Struct({
  investigation: Investigation,
  evidence: Schema.Array(Evidence),
  report: Schema.String, // observed, inferred, verified and unverified items with IDs
}).annotate({ identifier: "WorkbenchInvestigationDetail" })
export interface InvestigationDetail extends Schema.Schema.Type<typeof InvestigationDetail> {}

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
  schema: { debugSessionID: DebugSessionID, rows: Schema.Array(ConsoleRow) },
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
