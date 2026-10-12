# spicy-dap notes

Branch `spicy-dap`. Scope: P4 (DAP core, `debug` tool, debug routes) and P5 (investigations, supervisor, control).

## P4: DAP core and the agent debug tool

### Implemented

New code in `packages/opencode/src/workbench/`:

| File                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redact.ts`               | Shared redaction: secret-looking names (password, secret, token, api*key, auth, cookie, private_key, credential) mask the whole value; AWS `AKIA…`, GitHub `gh?*`, Slack `xox?-`, `sk-…`, JWT `eyJ…` and PEM blocks are replaced anywhere in text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dap/transport.ts`        | Content-Length framing by bytes (split, merged and multibyte frames); stdio and TCP (always `127.0.0.1`). A malformed header or body is a protocol error that ends the stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dap/client.ts`           | Numbered requests with timeouts, events, reverse requests (always answered). `DebugError` (`kind` + `message`) is the one typed error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dap/session.ts`          | One session: spawn/connect, `initialize` → `launch` sent without waiting → `initialized` → breakpoints → exception filters → `configurationDone` → launch response (debugpy answers late; no deadlock). State machine starting/running/stopped/terminated/failed. Capability gating before anything is sent (`REQUIRES` table; `writeMemory` is always refused). Limits: 10 min wall clock (not enforced while a human owns it), 30 s wait per step then `pause`, 200 agent steps, 256 KB output ring, variables 2 levels / 50 children / 512 chars. Shutdown collects the process tree first (pgrep -P, before re-parenting), sends `disconnect {terminateDebuggee}`, then SIGTERM → SIGKILL. Records every pid with its `ps lstart` start time (for P5 recovery). |
| `dap/control.ts`          | Owner idle/agent/human/terminating with `since`; one semaphore per session. Control commands need the owner (idle is claimed); reads are allowed for anyone while stopped; a human can always take over or stop; the agent can never take control from a human. Taking over releases a waiting step. Every change is a console row.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dap/snapshot.ts`         | StopSnapshot from `threads`/`stackTrace`/`scopes`/`variables`/`exceptionInfo` only (never `evaluate`), redacted, shrunk until its JSON is ≤ 2 KB. Text rendering for the agent; variable trees for `inspect`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `dap/console.ts`          | ConsoleRow ring (256 KB, 16 KB per row, truncation row when older rows were dropped), telemetry hidden, PTY output with ANSI stripped, batched publish every 32 ms. `evaluate` (agents never get LLDB command mode: a leading `` ` `` is refused) and `completions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dap/launch.ts`           | `StartInput`/`AttachInput` schemas (shared by tool and HTTP). `.vscode/launch.json` JSONC with `${workspaceFolder}`, `${workspaceFolderBasename}`, `${file*}`, `${env:X}`, `${userHome}`; unknown variables are errors. Plain program launch (`.py` → debugpy, else lldb-dap), `python-test` preset (pytest, unittest fallback; filters uncaught + userUnhandled). `preLaunchTask` is never run; a console note says so. `debugServer` connects over TCP. debugpy attach only by port (attach-by-pid would inject through a native debugger).                                                                                                                                                                                                                       |
| `dap/adapters/debugpy.ts` | Picks the Python in this order: launch.json `python`, the project's `.venv`/`venv`, `$VIRTUAL_ENV`, Homebrew (`/opt/homebrew/bin/python3`), other `python3`/`python` on PATH, `/usr/local/bin/python3`. Every candidate is run first (dead binaries such as the x86 `/usr/local/bin/python3` are skipped). Apple's Pythons (`/usr/bin/python3`, anything under `/Applications/Xcode*.app`, `/Library/Developer/CommandLineTools`, `/System/Library`, and venvs built on them) are never run or used; when nothing else exists the error says so. debugpy: importable in the chosen Python, else VS Code's `ms-python.debugpy-*/bundled/libs` via `PYTHONPATH`. Caches successes per directory.                                                                      |
| `dap/adapters/lldb.ts`    | `xcrun -f lldb-dap`; `DevToolsSecurity -status`; every session gets `--repl-mode variable`. Launch and attach are refused with "Developer Mode off — run sudo DevToolsSecurity -enable" before anything is spawned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dap/service.ts`          | `WorkbenchDebug.Service`: per-instance registry (`InstanceState`), max 2 live sessions per project, ended sessions kept (10) for the UI, finalizer terminates everything on dispose. Publishes `workbench.debug.updated` and batched `workbench.debug.output` through `EventV2Bridge` with the captured `InstanceRef`, so events carry `location.directory`. `runInTerminal` → PTY service (`Pty.create` through `LocationServiceMap`, same map as the `/pty` routes), output attached to the console. Agent-started sessions register a `BackgroundJob` (`type: "debug"`, `metadata.sessionId`), so cancelling or deleting the agent session ends them (unless a human took over).                                                                                 |
| `tool/debug.ts` + `.txt`  | `debug` tool: start, attach, control, breakpoints, inspect, evaluate, output, status, stop. Asks `debug.launch` (pattern = program relative to the project, `always` = same, so "always" approves once per project+program; attach configs ask `debug.attach`), `debug.attach`, `debug.evaluate` (pattern = expression, `always` = `*`). Output: header + compact snapshot + new program output only inside `<program_output untrusted="true">`. Metadata: `session`, `snapshot`. `ctx.abort` listener lives for the call only and ends the agent's debug sessions.                                                                                                                                                                                                 |

Routes (group `workbench-debug`, `server/routes/instance/httpapi/groups|handlers/workbench-debug.ts`, all instance-scoped, user requests act as `human`):

| Method | Path                                                                            | Returns                                                                            |
| ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/workbench/debug/sessions`                                                     | `DebugSessionInfo[]`                                                               |
| POST   | `/workbench/debug/sessions` (`StartInput`)                                      | `DebugSessionInfo` (returns after configurationDone; the stop arrives as an event) |
| POST   | `/workbench/debug/sessions/:debugSessionID/control` `{ action }`                | `DebugSessionInfo`                                                                 |
| POST   | `/workbench/debug/sessions/:debugSessionID/breakpoints`                         | `WorkbenchDebugBreakpoints` (verified)                                             |
| GET    | `/workbench/debug/sessions/:debugSessionID/variables?ref=&start=`               | `VariableView[]`                                                                   |
| POST   | `/workbench/debug/sessions/:debugSessionID/evaluate` `{ expression, frameID? }` | `ConsoleRow`                                                                       |
| GET    | `/workbench/debug/sessions/:debugSessionID/completions?text=&column=&frameID=`  | `WorkbenchDebugCompletion[]`                                                       |
| GET    | `/workbench/debug/sessions/:debugSessionID/output?after=`                       | `ConsoleRow[]` (added: console backlog for late UI)                                |
| POST   | `/workbench/debug/sessions/:debugSessionID/owner` `{ owner }`                   | `DebugSessionInfo`                                                                 |
| DELETE | `/workbench/debug/sessions/:debugSessionID`                                     | `DebugSessionInfo` (stops, kills the tree)                                         |

Errors: not found 404, invalid/unsupported 400, not owner / limit 409, adapter unavailable (incl. Developer Mode off) 503, adapter error 502, timeout 504.

Contract changes: none. `packages/schema/src/workbench.ts` is used as is.

### Upstream-owned files touched (each line marked `spicy:`)

| File                                                             | Change                                                                                                                              | Why                                                                                                                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/tool/registry.ts`                         | +4 lines: import, `const debugtool = yield* DebugTool`, `yield* Tool.init(debugtool)` in the built-in list, `DebugToolNode` in deps | Register the `debug` tool (needs its service as a layer dependency; one line was not possible because `InstanceState.make<State>` forbids extra requirements inside the closure) |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | +2 lines: import, `.addHttpApi(WorkbenchDebugApi)`                                                                                  | Compose the debug group into `InstanceHttpApi`                                                                                                                                   |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | +4 lines: two imports, `workbenchDebugHandlers`, `DebugToolNode` (debug + investigation services) in the `app` group                | Wire handlers; expose the same service instances the tool uses                                                                                                                   |
| `packages/opencode/test/server/httpapi-exercise/index.ts`        | +14 scenarios after the PTY block (10 debug, 4 investigation)                                                                       | `bun run test:httpapi` fails on any route without a scenario                                                                                                                     |

No edit to `session/run-state.ts` was needed: session cancel already cancels `BackgroundJob`s whose `metadata.sessionId` matches, and the debug job's interrupt ends the session.

`bun run generate` in `packages/client`: ran, no diff (the client covers only the V2 protocol API). The legacy JS SDK (`packages/sdk/js/script/build.ts`) was not regenerated, to keep generated files out of this branch; the UI needs that run (or raw fetch) to get typed debug routes.

### Tests

New: `test/workbench/redact.test.ts`, `test/workbench/dap/{session,debugpy,lldb,launch}.test.ts`, `test/workbench/tool/debug.test.ts`, `test/server/httpapi-workbench-debug.test.ts`; fixture `test/workbench/fixture/fake-dap.ts` (scripted adapter: capability profiles from the captured lists in `dap-profiles.ts`, crash, hang, malformed frames, stdio or TCP, command log).

| ID                                                                                                                  | Where                                       | Result                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| DAP-01 framing                                                                                                      | session.test (unit)                         | pass                                                |
| DAP-02 capabilities (fake debugpy + lldb-dap profiles; real lldb-dap initialize only)                               | session.test, lldb.test                     | pass                                                |
| DAP-03 launch after configurationDone                                                                               | session.test                                | pass                                                |
| DAP-04 setExpression on lldb-dap, data breakpoint on debugpy, refused before sending; SEC-02 writeMemory never sent | session.test                                | pass                                                |
| DAP-05 conditional breakpoint (real)                                                                                | debugpy.test                                | pass                                                |
| DAP-06 uncaught exception + exceptionInfo (real)                                                                    | debugpy.test                                | pass                                                |
| DAP-07 step over/into/out (real)                                                                                    | debugpy.test                                | pass                                                |
| DAP-08 Z-HANG pause after the step wait (real, 2 s wait; fake too)                                                  | debugpy.test, session.test                  | pass                                                |
| DAP-09 2 levels / 50 children / 512 chars / paging                                                                  | session.test                                | pass                                                |
| DAP-10 adapter killed mid-step                                                                                      | session.test                                | pass                                                |
| DAP-11 initialize never answered                                                                                    | session.test                                | pass                                                |
| DAP-12 malformed message                                                                                            | session.test                                | pass                                                |
| DAP-13 Z-FORK, no orphans (pgrep tree)                                                                              | debugpy.test                                | pass                                                |
| DAP-14 agent session cancelled / aborted mid-step → gone within 3 s                                                 | tool/debug.test                             | pass                                                |
| DAP-15 runInTerminal → PTY, output before an abrupt exit (`os._exit(1)`, no stdio flush) survives                   | debugpy.test                                | pass                                                |
| DAP-16 TCP adapter on 127.0.0.1                                                                                     | session.test                                | pass                                                |
| DAP-18 lldb-dap launch                                                                                              | lldb.test                                   | skipped: Developer Mode off                         |
| CON-02 completions x→xs, xs.ap→append, tot→total                                                                    | debugpy.test                                | pass                                                |
| CON-04 output categories, telemetry hidden                                                                          | debugpy.test, session.test                  | pass                                                |
| CON-06 agent evaluate asks; human evaluate runs and is recorded                                                     | tool/debug.test, session.test, httpapi test | pass                                                |
| CON-07 (partial) agent never gets LLDB command mode                                                                 | console.ts refusal + `--repl-mode variable` | not exercised against a launched lldb-dap (blocked) |
| CON-08 Z-SPAM 256 KB cap + truncation row                                                                           | debugpy.test                                | pass                                                |
| CTL-01..05                                                                                                          | session.test (CTL-04 with the fake adapter) | pass                                                |
| SEC-03 Z-SECRET redaction (unit + real)                                                                             | redact.test, debugpy.test                   | pass                                                |
| SEC-07 Z-INJECT labeled block                                                                                       | tool/debug.test                             | pass                                                |
| Python test preset: failing test stops with the cause in locals                                                     | debugpy.test                                | pass                                                |
| Max 2 sessions, events carry the directory                                                                          | httpapi-workbench-debug.test                | pass                                                |

Runs (P4 commit): `test/workbench` + debug HTTP test 44 pass, 1 skip (DAP-18, Developer Mode off). `bun test --timeout 30000 test/tool test/server test/session`: 1058 pass, 9 skip, 1 todo, 1 fail — `httpapi-v2-pty` "retains exited sessions" timed out while three other worktrees ran their suites on the same machine; it passes when rerun alone. `bun run test:httpapi`: 218 pass in coverage, auth and effect modes (208 before + 10 debug routes). `bun run typecheck`: clean.

### Blockers and limits

- lldb-dap launch/attach (DAP-18, E2E-02/03): blocked until Developer Mode is on. Only `initialize`/`disconnect` were ever sent to lldb-dap.
- Python for debugpy on this Mac: Homebrew `/opt/homebrew/bin/python3` (3.14) with VS Code's bundled debugpy 1.8.20; pytest is not installed there, so the python-test preset falls back to unittest.
- Crash dialogs (fixed in its own commit): between 00:07 and 00:48 every run of `debugpy.test.ts` left one `~/Library/Logs/DiagnosticReports/Python-*.ips` (11 in all) and a "Python quit unexpectedly" dialog. All 11 reports show the same stack: `abort()` called from Python bytecode, i.e. the DAP-15 fixture's deliberate `os.abort()` (attach.dylib is listed only because pydevd loads it into every debuggee). The interpreter was Xcode's Python 3.9 (via `/usr/bin/python3`, first runnable on PATH). Fix: the fixture now ends with `os._exit(1)` (same unflushed-buffer test, no crash), and Apple's Pythons are excluded from selection as the coordinator asked. Tests must never crash Python.app (abort, segfault): framework builds, Homebrew's included, raise the same dialog.
- `startDebugging` (child sessions, js-debug) is refused with a clear error and a console note.
- debugpy cannot cancel requests: a stuck evaluation shows a timeout row; stopping the session ends it.
- Debuggee PTYs live in the `/pty` route's location map (shared memo map), not the v2 `/api/pty` map.
- Redaction works per console row: a secret that the adapter splits across two output events is not caught.

## P5: investigations, supervisor and control

### Implemented

New code in `packages/opencode/src/workbench/investigation/`:

| File               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supervisor.ts`    | Pure `supervise(input, trigger, now)` → decision or nothing. S1 repair attempts used up (blocked, check IDs), S2 same error fingerprint in the last two failed attempts (blocked, both check IDs), S3 patch hash equal to an earlier attempt (blocked), S4 error count grows (blocked), S5 debug steps ≥ `maxDebugSteps` (needs_human), S6 time since creation/last resume ≥ `maxInvestigationDurationMs` (needs_human), S7 permission denied with `stopOnPermissionDenial` (needs_human), S8 second adapter crash (failed). S1–S4 only with `stopOnRepeatedFailures`. `fingerprint()` = tool, code, file, message with numbers and spaces normalized.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `investigation.ts` | `WorkbenchInvestigation.Service`. Record (`Info` schema, `WorkbenchInvestigationRecord`) in the JSON store at `["workbench","investigation",projectID,id]`, evidence at `["workbench","evidence",id]`. Explicit transition table (`allowed`): forward flow created→reproducing→debugging→diagnosing→patching→verifying→resolved (+ reproducing→patching, debugging→patching, diagnosing→debugging, verifying→patching, blocked→needs_human, interrupted→reproducing, needs_human→reproducing); any active status → blocked/needs_human/failed/cancelled/interrupted; paused → cancelled/failed; terminal never moves. Explicit moves (escalate, cancel, resume) are rejected and logged when the table forbids them. `apply()` is the single event reducer: bookkeeping, server-classified evidence (observed; verified only for a passing check or reproduction after the last patch), supervisor, then derived status. Resolved needs a passing check and a passing reproduction (a debugger run exiting 0, or a repro run) after the last patch. Notes are stored as notes (inferred), never evidence. |

Event sources wired in this branch: every debug session launched for an investigation reports through an observer (`WorkbenchDebug.start(..., { observe })`): started, processes (pid + `ps lstart`), steps, stops/exceptions, exit code, adapter crash (a failure after the program ran). File edits (`file.edited` from the edit/write/apply_patch tools, filtered to the instance directory) are patches of the open attempt for every active investigation in that directory. Permission denials in the `debug` tool record S7. Agent evaluations become `console-eval` evidence.

Check and test runs: see wave 2 below (wired through the verification engine).

Recovery: when an instance's investigation state loads (first route or tool use per project directory; there is no bootstrap hook because `project/bootstrap.ts` is not in this branch's ownership), every active record whose owner is gone becomes `interrupted` with checkpoint "the app restarted; killed …". The owner is `{ pid, ps lstart, token }`: another live opencode process (pid and start time match) or another live service instance in this process (token) keeps its records. Recorded processes are killed only when pid and start time still match; reused pids are left alone. Nothing is relaunched.

Control (P4, used here): the tool refuses control, breakpoints and evaluate while the agent's investigation is needs_human, blocked, failed or cancelled; inspect stays allowed.

`debug` tool additions: `start`/`attach` open or continue the agent session's investigation (`title`), store the launch fields as its target, and refuse while it waits for the user; `note` (hypothesis/question), `escalate` (→ needs_human with the reason), `resume` (asks `debug.launch` again, then relaunches the stored target with its breakpoints); `status` shows the investigation.

Routes (same `workbench-debug` group):

| Method | Path                                                | Returns                                                                                           |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/workbench/investigations`                         | `InvestigationSummary[]` (project, newest first)                                                  |
| GET    | `/workbench/investigations/:investigationID`        | `WorkbenchInvestigationFull` = `{ investigation: record, evidence: Evidence[], report }`          |
| POST   | `/workbench/investigations/:investigationID/resume` | `InvestigationSummary` (interrupted, needs_human or blocked → reproducing; relaunches the target) |
| POST   | `/workbench/investigations/:investigationID/cancel` | `InvestigationSummary` (cancelled; its debug sessions stop)                                       |

`workbench.investigation.updated` is published on every change through `EventV2Bridge` (carries the directory).

Contract notes: no change to `packages/schema/src/workbench.ts`. The full record schema (`WorkbenchInvestigationRecord`, `WorkbenchInvestigationFull`) lives in `investigation.ts`; it is a candidate for the shared contract once the UI consumes it. `WorkbenchDebug.start` gained an options object (`limits`, `investigationID`, `observe`).

### Tests

| ID                                                                                                                                                   | Where                            | Result |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| INV-01 transition table, every pair                                                                                                                  | investigation/rules.test (unit)  | pass   |
| INV-02 concurrent updates, no lost writes                                                                                                            | investigation/investigation.test | pass   |
| INV-04 restart while debugging: interrupted, nothing relaunched, owned process killed, reused pid and another live owner left alone (real processes) | investigation/investigation.test | pass   |
| INV-05 resume asks debug.launch and relaunches with breakpoints                                                                                      | tool/debug.test (fake adapter)   | pass   |
| INV-06 S2, INV-07 S3, INV-08 S4, S1                                                                                                                  | rules.test                       | pass   |
| INV-09 S5 (unit; tool with fake adapter: agent refused, program stays paused)                                                                        | rules.test, tool/debug.test      | pass   |
| INV-10 S6                                                                                                                                            | rules.test                       | pass   |
| INV-11 S7                                                                                                                                            | rules.test, tool/debug.test      | pass   |
| INV-12 model notes never become evidence or a resolution                                                                                             | rules.test, tool/debug.test      | pass   |
| INV-13 resolve only after passing check + reproduction after the last patch (edit event → patch)                                                     | rules.test, investigation.test   | pass   |
| INV-14 final report golden file                                                                                                                      | rules.test + `report.golden.txt` | pass   |
| S8 two adapter crashes → failed                                                                                                                      | rules.test                       | pass   |
| Investigation routes + `workbench.investigation.updated` with directory                                                                              | httpapi-workbench-debug.test     | pass   |

Runs (P5 commit): `test/workbench` + debug HTTP test 66 pass, 1 skip (DAP-18, Developer Mode off). `bun test --timeout 30000 test/tool test/server test/session`: 1059 pass, 9 skip, 1 todo, 1 fail — `httpapi-session` "returns v2 public request errors for cursor and workspace query failures" got an HTML body once under load (other worktrees were running suites); the file passes when rerun alone (21/21, twice). The P4 run's `httpapi-v2-pty` timeout did not recur. `bun run test:httpapi`: 222 pass in all three modes. `bun run typecheck`: clean.

### Blockers and limits (P5)

- Recovery is lazy per project directory (first investigation access), not at server boot.
- Patch attribution is by directory: an edit counts for every active investigation in that directory, whichever agent session made it.
- `current()`/edit handling list the project's records from the JSON store on each call (fine for tens of records).

## Wave 2

### 1. Verification runs feed investigations

Every `WorkbenchVerify.run` with a `sessionID` (the `check` tool and the turn-end gate; there is no
`POST /workbench/check` route) ends with `WorkbenchInvestigation.Service.verified(sessionID, report, problems)`:

- No open (non-terminal) investigation for that agent session: nothing happens.
- Otherwise one `check` event: `passed` only when the report has runs and every run passed (skipped, timed out,
  unavailable and cancelled are never a pass); `problems` are the errors in changed files (or without a file), the
  ones the gate repairs; `runIDs` and `unverifiedFiles` as reported. The check closes the open attempt, so S1, S2 and
  S4 fire on real runs. Evidence class: `verified` for a passing check after the last patch, else `observed`.
- When the report includes test runs (`run.kind === "test"`, e.g. `check` with `tests: true`), also one `repro` event
  (passed when every test run passed): a failing test is the reproduction, so a passing test run after the last patch
  plus passing checks resolves the investigation.
- Failures are logged, never fail the verification run.

Turn-end gate: after its run, `WorkbenchInvestigation.Service.halted(sessionID)` returns a reason while the session's
investigation is `blocked` or `needs_human`; the gate then breaks instead of adding a repair message. Example
(`test/workbench/investigation/verification.test.ts`): the same error after two patches → S2 blocks the investigation
on the second failed gate check, and the gate stops with one repair message instead of two (stand-in checker and real
`go build`).

Edits are recorded inside the edit tool's `file.edited` publish (EventV2 listeners run inline), so a patch is always
recorded before the turn-end check that follows it.

Fork files touched (verification engine, owned by the problems branch; each edit marked `spicy:`):

| File                                               | Change                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/workbench/verify/verify.ts` | Import; yield `WorkbenchInvestigation.Service`; `verified(...)` after the report is built (problems list computed once); `WorkbenchInvestigation.node` in deps |
| `packages/opencode/src/workbench/verify/gate.ts`   | Import; yield the service; `halted(sessionID)` check after the report-only check; `WorkbenchInvestigation.node` in deps                                        |

### 2. Rust under lldb-dap

- `preset: "rust-test"` (`StartInput`, so the tool and `POST /workbench/debug/sessions` both take it): `program` is
  the crate folder or its `Cargo.toml` (default: the project), `args` go to the test binary (a test name filter
  first). The spec carries `build: cargo test --no-run --message-format=json` (cwd = crate); the service runs it in
  `connect()`, after the Developer Mode check and after the agent's `debug.launch` approval (whose metadata names the
  build command), never in `prepare()`: building runs build scripts and proc macros. `Lldb.testBinaries()` picks
  the compiler artifacts with `profile.test` and an executable, the library's unit tests first (others are listed in
  a console note); compile errors (`compiler-message` rendered text) become the error.
- Rust programs (the preset, or any lldb-dap program or launch.json program with a `Cargo.toml` between it and the
  project root) get rustc's formatters through `initCommands`: `command script import
"<sysroot>/lib/rustlib/etc/lldb_lookup.py"` and `command source -s 0 "<sysroot>/lib/rustlib/etc/lldb_commands"`
  (what `rust-lldb` does), with the sysroot from `rustc --print sysroot` run in the crate so rust-toolchain files
  apply, and a function breakpoint on `rust_panic`, so failed asserts and unwraps stop with the test's frames. Missing
  formatters leave a console note.
- While Developer Mode is off the session is refused before anything is built or spawned (tested: no `target/`).
  The launch test (DAP-18 Rust: stop on the panic, `orders` formatted) is written and skipped with
  "[skipped: Developer Mode off]". CodeLLDB's launch.json `cargo` key is not supported yet.

Tests: `test/workbench/dap/rust.test.ts` — cargo JSON parsing (captured), preset/spec shape and Rust detection,
formatter files from the real toolchain, a real `cargo test --no-run` locating the binary and reporting a compile
error, the refusal before building; 5 pass, 1 skipped (Developer Mode off).

### 3. Shared contract and the UI reference

Contract additions in `packages/schema/src/workbench.ts` (additive; no existing field changed):

| Export                                                                 | Identifier                     | What                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `DebugSessionInfo.ptyID`                                               | (field)                        | PTY the program runs in when the adapter asked for a terminal                                                                  |
| `DebugAdapter`                                                         |                                | `"debugpy" \| "lldb-dap"`                                                                                                      |
| `DebugBreakpoint`                                                      |                                | `{ file, line, condition?, hitCondition?, logMessage? }`                                                                       |
| `DebugStartInput`                                                      | `WorkbenchDebugStartInput`     | body of `POST /workbench/debug/sessions` and the `debug` tool's start fields (moved from `dap/launch.ts`, which re-exports it) |
| `InvestigationNote`, `InvestigationAttempt`, `InvestigationCheckpoint` |                                | parts of the record                                                                                                            |
| `Investigation`                                                        | `WorkbenchInvestigationRecord` | the full investigation record (moved from `investigation.ts`, which re-exports it as `Info`)                                   |
| `InvestigationDetail`                                                  | `WorkbenchInvestigationDetail` | `{ investigation, evidence, report }` (was `WorkbenchInvestigationFull`)                                                       |

## UI reference: debug and investigation routes

For the Debug panel, Debug Console and Run tab (the app now; a SwiftUI client can use the same JSON later).
Shapes named `Workbench.*` are in `packages/schema/src/workbench.ts`.

**Conventions.** Every route is instance-scoped: pass the project folder as `?directory=<abs path>` or the
`x-opencode-directory` header, with the same auth as other instance routes. Requests from these routes act as the
**human**. Errors are JSON with a `message`: 400 invalid or unsupported (unknown filter, capability missing, wrong
state), 404 unknown session or investigation, 409 not the owner or a limit (2 live sessions per project), 502 the
adapter failed, 503 adapter unavailable (no Python/debugpy, or "Developer Mode off — run sudo DevToolsSecurity
-enable"), 504 timeout.

### Routes

| Method | Path                                                    | Body / query                                                                                                                                                                                               | Returns                                                                                                                                                                             |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/workbench/debug/sessions`                             |                                                                                                                                                                                                            | `Workbench.DebugSessionInfo[]` (live ones and the last 10 ended)                                                                                                                    |
| POST   | `/workbench/debug/sessions`                             | `Workbench.DebugStartInput`                                                                                                                                                                                | `DebugSessionInfo`. Returns once the adapter is configured (usually `running`); the first stop arrives as an event.                                                                 |
| POST   | `/workbench/debug/sessions/:debugSessionID/control`     | `{ action: "continue" \| "pause" \| "next" \| "stepIn" \| "stepOut" }`                                                                                                                                     | `DebugSessionInfo` right after the adapter accepted the command; the stop arrives as an event. 409 when the agent owns the session (take over first).                               |
| POST   | `/workbench/debug/sessions/:debugSessionID/breakpoints` | `{ file?, breakpoints?: { line, condition?, hitCondition?, logMessage? }[], functions?: string[], exceptions?: string[] }`. `file` + `breakpoints` replace every breakpoint in that file (`[]` clears it). | `{ file?, breakpoints: { line, verified, message? }[], functions?: { name, verified, message? }[], exceptions?: string[] }`                                                         |
| GET    | `/workbench/debug/sessions/:debugSessionID/variables`   | `?ref=<variablesReference>&start=<n>`                                                                                                                                                                      | `Workbench.VariableView[]`, 50 per page (`start` pages). Only while stopped; refs from older stops are invalid.                                                                     |
| POST   | `/workbench/debug/sessions/:debugSessionID/evaluate`    | `{ expression, frameID? }` (default: top frame)                                                                                                                                                            | `Workbench.ConsoleRow` (`kind: "result"`, or `"exception"` when the expression failed; `variablesReference` > 0 means expandable). The human may evaluate whoever owns the session. |
| GET    | `/workbench/debug/sessions/:debugSessionID/completions` | `?text=<input>&column=<1-based cursor>&frameID=<id>`                                                                                                                                                       | `{ label, text?, type?, start?, length? }[]` (max 50)                                                                                                                               |
| GET    | `/workbench/debug/sessions/:debugSessionID/output`      | `?after=<seq>`                                                                                                                                                                                             | `Workbench.ConsoleRow[]` after `seq`; led by a `system` truncation row when the 256 KB cap dropped older rows                                                                       |
| POST   | `/workbench/debug/sessions/:debugSessionID/owner`       | `{ owner: "idle" \| "agent" \| "human" }`                                                                                                                                                                  | `DebugSessionInfo`                                                                                                                                                                  |
| DELETE | `/workbench/debug/sessions/:debugSessionID`             |                                                                                                                                                                                                            | `DebugSessionInfo` (`terminated`); the program's whole process tree is gone                                                                                                         |
| GET    | `/workbench/investigations`                             |                                                                                                                                                                                                            | `Workbench.InvestigationSummary[]`, newest first                                                                                                                                    |
| GET    | `/workbench/investigations/:investigationID`            |                                                                                                                                                                                                            | `Workbench.InvestigationDetail` = `{ investigation: Investigation, evidence: Evidence[], report: string }`                                                                          |
| POST   | `/workbench/investigations/:investigationID/resume`     |                                                                                                                                                                                                            | `InvestigationSummary`. Only from `interrupted`, `needs_human` or `blocked`; relaunches the stored `target` with its breakpoints.                                                   |
| POST   | `/workbench/investigations/:investigationID/cancel`     |                                                                                                                                                                                                            | `InvestigationSummary` (`cancelled`); its debug sessions stop                                                                                                                       |

### Events

Delivered on the instance stream `GET /event` (SSE; each item `{ id, type, properties }`) and on `GET /global/event`
(SSE; `{ directory, project, workspace, payload: { id, type, properties } }`). All three carry the project directory.

| Type                              | `properties`                              | Use                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workbench.debug.updated`         | `{ session: DebugSessionInfo }`           | Full snapshot on every state, owner or stop change: replace the session by `id`. `stop` is set only while `state === "stopped"` and the snapshot is built (it can be `stopped` without `stop` for a few ms). |
| `workbench.debug.output`          | `{ sessionID, rows: ConsoleRow[] }`       | New console rows, batched every ~32 ms. Append by `seq`, ignoring rows you already have (the evaluate response is also published here).                                                                      |
| `workbench.investigation.updated` | `{ investigation: InvestigationSummary }` | Replace by `id`; fetch the detail route for evidence and the report.                                                                                                                                         |

### Semantics the panels need

- **State**: `starting → running ⇄ stopped → terminated | failed` (`error` says why on `failed`). Program exit, `stop`,
  the 10-minute limit (unless a human owns the session) and project close all end in `terminated`.
- **Owner** (`idle | agent | human | terminating`): only the owner sends control commands; anyone may read while
  stopped. "Take over" = owner `human` (always allowed); "Hand to agent" = `agent`; "Release" = `idle`. Every change
  is also a console row `owner X → Y`.
- **Debug panel**: call stack = `stop.frames` (`line` is 1-based); variables = `stop.locals`, then
  `variables?ref=` for anything with `variablesReference > 0`. `stop.reason` is `breakpoint`, `exception`, `step`,
  `pause`, `entry`, …; `stop.exception` holds `{ id, description }`. Values are redacted (`[REDACTED]`) and capped at
  512 characters. `capabilities` lists the DAP capabilities the adapter reported (e.g. hide conditional breakpoints
  without `supportsConditionalBreakpoints`).
- **Debug Console**: load `output?after=0`, then follow `workbench.debug.output`. Row `kind`: `stdout`/`stderr`
  (`by: "program"`), `console` (`by: "adapter"`), `eval` + `result`/`exception` (`by: "agent" | "human"`), `stop`,
  `exception` (`by: "adapter"`, with `location`), `system`. Telemetry never appears. Completions: send the input
  and the 1-based cursor column.
- **Run tab**: when `ptyID` is set, the program runs in that PTY: attach with the existing PTY routes
  (`POST /pty/:ptyID/connect-token`, then the `/pty/:ptyID/connect` WebSocket) for live I/O and stdin. Its output is
  also mirrored into console rows (`stdout`, ANSI stripped). Without `ptyID` (debugpy's default internal console),
  the `stdout`/`stderr` rows are the program's output.
- **Investigations**: `status` follows `created → reproducing → debugging → diagnosing → patching → verifying →
resolved`, plus `blocked`, `needs_human`, `interrupted`, `failed`, `cancelled`. `reason` on the summary is the
  latest checkpoint reason; supervisor stops start with the rule (`S1:` … `S8:`). Evidence `class` is `observed` or
  `verified` (set by the server); notes in the record are the agent's inferences. Offer "Resume" on
  `interrupted`/`needs_human`/`blocked` and "Cancel" on anything not ended.

### Wave 2 runs

- Goal 1 commit: `test/workbench` + debug HTTP test 119 pass / 1 skip; `test/tool test/server test/session` 1063 pass /
  9 skip / 1 todo / 0 fail.
- Goal 2 commit: workbench 124 pass / 2 skip (DAP-18 C and Rust launches, "Developer Mode off"); full suites
  1063 pass / 9 skip / 1 todo / 0 fail.
- Goal 3 commit: workbench 124 pass / 2 skip (the real debugpy tests included, now with the `ptyID` check); full
  suites 1062 pass / 9 skip / 1 todo / 1 fail — `httpapi-v2-pty` "retains exited sessions", the known load-flaky PTY
  test, 4/4 when rerun alone; `bun run test:httpapi` 234 pass in all three modes (its `opencode/eager-eagle` and
  `opencode/nimble-orchid` branches deleted, `git worktree prune` run); typecheck clean in `packages/opencode`,
  `packages/schema` and `packages/app`; `bun run generate` in `packages/client`: no diff.
- No new `~/Library/Logs/DiagnosticReports/Python-*.ips` after any of these runs (11 before the fix, 11 now).
