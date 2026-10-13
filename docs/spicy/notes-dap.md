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

- Recovery is lazy per project directory (first investigation access), not at server boot. (Wave 3 adds a boot pass.)
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

| Method | Path                                                    | Body / query                                                                                                                                                                                               | Returns                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/workbench/debug/sessions`                             |                                                                                                                                                                                                            | `Workbench.DebugSessionInfo[]` (live ones and the last 10 ended)                                                                                                                                                                                                                                             |
| POST   | `/workbench/debug/sessions`                             | `Workbench.DebugStartInput`                                                                                                                                                                                | `DebugSessionInfo`. Returns once the adapter is configured (usually `running`); the first stop arrives as an event.                                                                                                                                                                                          |
| POST   | `/workbench/debug/sessions/:debugSessionID/control`     | `{ action: "continue" \| "pause" \| "next" \| "stepIn" \| "stepOut" }`                                                                                                                                     | `DebugSessionInfo` right after the adapter accepted the command; the stop arrives as an event. 409 when the agent owns the session (take over first).                                                                                                                                                        |
| POST   | `/workbench/debug/sessions/:debugSessionID/breakpoints` | `{ file?, breakpoints?: { line, condition?, hitCondition?, logMessage? }[], functions?: string[], exceptions?: string[] }`. `file` + `breakpoints` replace every breakpoint in that file (`[]` clears it). | `{ file?, breakpoints: { line, verified, message? }[], functions?: { name, verified, message? }[], exceptions?: string[] }`                                                                                                                                                                                  |
| GET    | `/workbench/debug/sessions/:debugSessionID/variables`   | `?ref=<variablesReference>&start=<n>`                                                                                                                                                                      | `Workbench.VariableView[]`, 50 per page (`start` pages). Only while stopped; refs from older stops are invalid.                                                                                                                                                                                              |
| GET    | `/workbench/debug/sessions/:debugSessionID/scopes`      | `?frameID=<id from stop.frames>`                                                                                                                                                                           | `Workbench.DebugScope[]` = `{ name, variablesReference, expensive? }[]` (e.g. Locals, Globals); their children come from `variables?ref=`. Only while stopped; a frame id that is not in the current stop is 404 "frame N is not in the current stop". Runs no program code.                                 |
| POST   | `/workbench/debug/sessions/:debugSessionID/evaluate`    | `Workbench.DebugEvaluateInput` = `{ expression, frameID?, context?: "watch" \| "repl" \| "hover" }` (frame default: the top frame; context default: `repl`)                                                | `Workbench.ConsoleRow` (`kind: "result"`, or `"exception"` when the expression failed; `variablesReference` > 0 means expandable). The human may evaluate whoever owns the session. `watch`/`hover`: the row is only returned (`seq: 0`), never added to the console or published. A stale `frameID` is 404. |
| GET    | `/workbench/debug/sessions/:debugSessionID/completions` | `?text=<input>&column=<1-based cursor>&frameID=<id>`                                                                                                                                                       | `{ label, text?, type?, start?, length? }[]` (max 50)                                                                                                                                                                                                                                                        |
| GET    | `/workbench/debug/sessions/:debugSessionID/output`      | `?after=<seq>`                                                                                                                                                                                             | `Workbench.ConsoleRow[]` after `seq`; led by a `system` truncation row when the 256 KB cap dropped older rows                                                                                                                                                                                                |
| POST   | `/workbench/debug/sessions/:debugSessionID/owner`       | `{ owner: "idle" \| "agent" \| "human" }`                                                                                                                                                                  | `DebugSessionInfo`                                                                                                                                                                                                                                                                                           |
| DELETE | `/workbench/debug/sessions/:debugSessionID`             |                                                                                                                                                                                                            | `DebugSessionInfo` (`terminated`); the program's whole process tree is gone                                                                                                                                                                                                                                  |
| GET    | `/workbench/investigations`                             |                                                                                                                                                                                                            | `Workbench.InvestigationSummary[]`, newest first                                                                                                                                                                                                                                                             |
| GET    | `/workbench/investigations/:investigationID`            |                                                                                                                                                                                                            | `Workbench.InvestigationDetail` = `{ investigation: Investigation, evidence: Evidence[], report: string }`                                                                                                                                                                                                   |
| POST   | `/workbench/investigations/:investigationID/resume`     |                                                                                                                                                                                                            | `InvestigationSummary`. Only from `interrupted`, `needs_human` or `blocked`; relaunches the stored `target` with its breakpoints.                                                                                                                                                                            |
| POST   | `/workbench/investigations/:investigationID/cancel`     |                                                                                                                                                                                                            | `InvestigationSummary` (`cancelled`); its debug sessions stop                                                                                                                                                                                                                                                |

### Events

Delivered on the instance stream `GET /event` (SSE; each item `{ id, type, properties }`) and on `GET /global/event`
(SSE; `{ directory, project, workspace, payload: { id, type, properties } }`). All three carry the project directory.

| Type                              | `properties`                              | Use                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workbench.debug.updated`         | `{ session: DebugSessionInfo }`           | Full snapshot on every state, owner or stop change: replace the session by `id`. `stop` is set only while `state === "stopped"` and the snapshot is built (it can be `stopped` without `stop` for a few ms). |
| `workbench.debug.output`          | `{ debugSessionID, rows: ConsoleRow[] }`  | New console rows, batched every ~32 ms. Append by `seq`, ignoring rows you already have (the evaluate response is also published here).                                                                      |
| `workbench.investigation.updated` | `{ investigation: InvestigationSummary }` | Replace by `id`; fetch the detail route for evidence and the report.                                                                                                                                         |

### Semantics the panels need

- **State**: `starting → running ⇄ stopped → terminated | failed` (`error` says why on `failed`). Program exit, `stop`,
  the 10-minute limit (unless a human owns the session) and project close all end in `terminated`.
- **Owner** (`idle | agent | human | terminating`): only the owner sends control commands; anyone may read while
  stopped. "Take over" = owner `human` (always allowed); "Hand to agent" = `agent`; "Release" = `idle`. Every change
  is also a console row `owner X → Y`.
- **Debug panel**: call stack = `stop.frames` (`line` is 1-based); variables = `stop.locals` (top frame only), then
  `variables?ref=` for anything with `variablesReference > 0`. For any other frame: `scopes?frameID=`, then
  `variables?ref=` of a scope (collapse `expensive` scopes). Frame ids, like refs, are valid until the program runs
  again. Watches: `evaluate` with `context: "watch"` (and the selected frame) on each stop; hover tooltips with
  `hover`. They run program code like any evaluation but leave the console alone. `stop.reason` is `breakpoint`,
  `exception`, `step`, `pause`, `entry`, …; `stop.exception` holds `{ id, description }`. Values are redacted (`[REDACTED]`) and capped at
  512 characters. `capabilities` lists the DAP capabilities the adapter reported (e.g. hide conditional breakpoints
  without `supportsConditionalBreakpoints`).
- **Debug Console**: load `output?after=0`, then follow `workbench.debug.output`. Row `kind`: `stdout`/`stderr`
  (`by: "program"`), `console` (`by: "adapter"`), `eval` + `result`/`exception` (`by: "agent" | "human"`), `stop`,
  `exception` (`by: "adapter"`, with `location`), `system`. Telemetry never appears. Completions: send the input
  and the 1-based cursor column. An agent's `eval`/`result` rows carry `evidenceID` (its investigation's evidence);
  a human's `` ` `` LLDB command first asks `debug.lldbCommand` (wave 6).
- **Run tab**: when `ptyID` is set, the program runs in that PTY: attach with the existing PTY routes
  (`POST /pty/:ptyID/connect-token`, then the `/pty/:ptyID/connect` WebSocket) for live I/O and stdin. Its output is
  also mirrored into console rows (`stdout`, ANSI stripped). Without `ptyID` (debugpy's default internal console, and
  every lldb-dap session, which lldb runs on a pseudo-terminal of its own), the `stdout`/`stderr` rows are the
  program's output and there is no stdin.
- **Investigations**: `status` follows `created → reproducing → debugging → diagnosing → patching → verifying →
resolved`, plus `blocked`, `needs_human`, `interrupted`, `failed`, `cancelled`. The summary's `reason`, `rule`,
  `runIDs` and `evidenceID` come from the latest checkpoint with a reason: `reason` is a sentence, `rule` the
  supervisor rule (`S1` … `S8`) when one decided, `runIDs` the check runs it refers to (since UX wave 1; older
  records are read the same way). Evidence `class` is `observed` or
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

## Wave 3

### 1. Debug tools in the Workbench MCP bridge

- `opencode workbench mcp` also serves `debug_start`, `debug_attach`, `debug_control`, `debug_breakpoints`,
  `debug_inspect`, `debug_evaluate`, `debug_output`, `debug_status`, `debug_stop`, `debug_note`, `debug_escalate` and
  `debug_resume`: one tool per action of the in-process `debug` tool, each taking that action's fields with the
  in-process field schemas (`Parameters.fields`), so outside agents use the same vocabulary. `debug_inspect`,
  `debug_output` and `debug_status` carry `readOnlyHint`, `debug_stop` `destructiveHint`. Module:
  `src/workbench/mcp/debug.ts` (`WorkbenchDebugBridge.tools()`).
- Each call is `POST /workbench/debug/agent` with `{ sessionID, action, ...fields }` and returns
  `{ title, output, metadata }` (`WorkbenchDebugAgentResult`). The handler runs the in-process tool itself
  (`Tool.init(DebugTool)`) as the agent of `sessionID`, so everything it records is the same: actor `agent`, an
  investigation opened for that session (its `sessionID`), the debug session owned by `agent`, control refused while
  the human owns the session or the investigation is halted, inspection allowed whoever owns it, S7 on a denied ask.
- Permissions: asks go through the permission service with the default agent's rules merged with the session's (as
  `session/tools.ts` does), so `debug.launch`, `debug.attach` and `debug.evaluate` ask by default and `debug.memory`
  stays denied. Neither the route nor the bridge approves anything. The bridge creates one opencode session per
  bridge process on its first debug call, titled "Workbench MCP: debugging" ("Workbench MCP" since wave 5); its asks appear there in the IDE and its
  investigations list it. A rejected or denied ask fails the call with 403 "permission denied in the IDE: ..." and
  moves the investigation to `needs_human` (S7).
- The model cannot pick the session or the action: the bridge sets both after the arguments, rejects unknown
  arguments, and forwards only the tool's own fields (an empty input schema, like `debug_status`'s, lets unknown keys
  through decoding).
- Errors as the other debug routes (404 unknown session, 400 invalid arguments, 409 not the owner, halted or a limit,
  502/503/504), plus 403 for a denied ask. Cancelling the request aborts like aborting the in-process tool: the
  agent's debug sessions end.

### 2. Boot-time recovery

- When the investigation service starts (once per server), a background pass reads every project's records and
  recovers the active ones whose owner is gone: status `interrupted`, checkpoint "the app restarted; killed <pids>",
  recorded processes killed only when pid and start time still match (a reused pid is left alone). Nothing is
  relaunched. Failures are logged.
- Owner check: same process, its service token must still be live; another process, the pid must run with the
  recorded start time (an unknown recorded start time counts as running, so a live owner's debuggees are never
  killed). Records of the starting instance itself are skipped (created after the pass began).
- The per-directory recovery on instance load stays (it covers reloads within one process). Both re-check the record
  inside the storage update (still active, same owner), so they never both transition it or undo a resume.

### 3. Fix: start input field descriptions

The schema package's `optional()` drops an `.annotate({ description })` placed outside it from JSON Schema. Since
wave 2 moved `DebugStartInput`/`DebugBreakpoint` there, the in-process tool's schema (what the model sees) and the
OpenAPI had lost the descriptions of `configuration`, `program`, `preset`, `exceptions`, `file`, `condition`,
`hitCondition` and `logMessage`. They now sit inside `optional(...)`; types are unchanged.

### Files touched (wave 3)

| File                                                                               | Change                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/workbench/mcp/debug.ts` (new)                               | The `debug_*` bridge tools                                                                         |
| `packages/opencode/src/server/routes/instance/httpapi/groups/workbench-debug.ts`   | `POST /workbench/debug/agent` (`AgentPayload`, `AgentResult`, op `workbench.debug.agent`)          |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/workbench-debug.ts` | `agent` handler: runs the debug tool with the session's asks; maps tool defects to 400/403/404/409 |
| `packages/opencode/src/workbench/tool/debug.ts`                                    | `import { Tool }` instead of a star import                                                         |
| `packages/opencode/src/workbench/investigation/investigation.ts`                   | Boot recovery; the owner check moved to `owned()`                                                  |
| `packages/schema/src/workbench.ts`                                                 | Descriptions inside `optional()`                                                                   |
| `packages/opencode/src/cli/cmd/workbench.ts` (problems branch, `spicy:`)           | Passes `WorkbenchDebugBridge.tools()` to `WorkbenchBridge.serve` as `extra`; describe text         |
| `packages/opencode/test/workbench/mcp.test.ts` (problems branch, `spicy:`)         | The stdio test expects the three workbench tools plus `debug_*`                                    |
| `packages/opencode/test/server/httpapi-exercise/index.ts` (upstream)               | +1 scenario: `POST /workbench/debug/agent` with an unknown session, 404                            |

### Wave 3 runs

- New tests: `test/workbench/mcp-debug.test.ts` (3: tool list, annotations and field schemas equal to the in-process
  tool's, forged session/action ignored; real debugpy through the bridge: `debug.launch` asked in the bridge session
  and answered through the permission routes, conditional breakpoint snapshot, inspect without an ask,
  `debug.evaluate` asked, control refused while the human owns the session while inspect works, exception, output,
  status naming the investigation, stop; a rejected launch: 403, no debug session, investigation `needs_human` with
  "S7: permission denied: debug.launch") and `test/workbench/investigation/boot.test.ts` (1: fake orphans are
  `sleep` processes; the matching one is killed, the reused pid survives, a live owner's record stays `debugging`).
- `test/workbench` + debug HTTP test: 146 pass / 2 skip (Rust and C launches, "Developer Mode off") / 0 fail.
- `test/tool test/server test/session`: 1062 pass / 9 skip / 1 todo / 1 fail: `httpapi-v2-pty` "retains exited
  sessions", the known load-flaky PTY test, 4/4 when rerun alone.
- `bun run test:httpapi`: 256 pass in all three modes (its `opencode/happy-circuit` and `opencode/neon-harbor`
  branches, at our HEAD, deleted after `git worktree prune`; stray `packages/opencode/config.json` removed).
- Typecheck clean in `packages/opencode` and `packages/schema`; `bun run generate` in `packages/client`: no diff.
- No lldb launch or attach; `~/Library/Logs/DiagnosticReports` (without intelligencetasksd) 52 files before and after.

## Wave 4

### 1. Variables of any frame

- `GET /workbench/debug/sessions/:debugSessionID/scopes?frameID=<id>` returns the DAP scopes of that frame as
  `Workbench.DebugScope[]` (`{ name, variablesReference, expensive? }`; at most 50, names redacted and capped like
  values); children come from the existing `variables?ref=` route. It is a read: allowed whoever owns the session,
  only while stopped (otherwise 400 "the program is running; this needs it stopped"), and it never runs program code
  (`scopes` requests only).
- A frame id must belong to the current stop (`stop.frames`): otherwise 404 "frame N is not in the current stop; take
  frame ids from the latest stop". The same check now guards every frame id: `evaluate`, `completions` and the agent's
  `inspect`, which used to pass a stale id to the adapter (a 502, or the wrong frame when the adapter reused the id).
- The agent tool already had `frame` on `inspect` (so `debug_inspect` has it); what it lacked was the ids. The stop
  text's frames line now shows them (`frames    #2 average (avg.py:3) <- #3 <module> (avg.py:8)`), and the tool and
  MCP descriptions say where to find them.

### 2. Watch and hover evaluations

- `POST …/evaluate` takes `Workbench.DebugEvaluateInput`: `{ expression, frameID?, context? }`, `context` one of
  `watch | repl | hover` (default `repl`), passed to DAP `evaluate`. With `watch` or `hover` the result row is only
  returned: no `eval`/`result` console rows and no `workbench.debug.output` event; the returned `ConsoleRow` is
  redacted and capped like console rows and has `seq: 0`. `repl` is unchanged.
- Permissions and ownership are unchanged: the human may evaluate whoever drives; the agent's evaluations still need
  control and the `debug.evaluate` ask. The agent tool keeps `repl`, so everything an agent evaluates stays visible in
  the console.

### Contract additions (`packages/schema/src/workbench.ts`, additive)

| Export                 | Identifier                    | Shape                                                                                   |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `DebugScope`           | `WorkbenchDebugScope`         | `{ name: string, variablesReference: NonNegativeInt, expensive?: boolean }`             |
| `DebugEvaluateContext` |                               | `"watch" \| "repl" \| "hover"` (also a type)                                            |
| `DebugEvaluateInput`   | `WorkbenchDebugEvaluateInput` | `{ expression: string, frameID?: int, context?: DebugEvaluateContext }` (evaluate body) |

### Files touched (wave 4)

- `src/workbench/dap/session.ts`: `scopes()`, the frame check (`frame()`), `evaluate` takes `DebugEvaluateInput`.
- `src/workbench/dap/console.ts`: `evaluate` takes `context`; watch and hover rows are built but not pushed.
- `src/workbench/dap/snapshot.ts`: `scopes()` (redacted, capped); frame ids in the frames line.
- Routes: `groups/workbench-debug.ts` (`scopes` endpoint; the evaluate payload is `Workbench.DebugEvaluateInput`),
  `handlers/workbench-debug.ts` (`scopes`).
- `src/workbench/tool/debug.ts` + `.txt`, `src/workbench/mcp/debug.ts`: descriptions of `frame`.
- Upstream: `test/server/httpapi-exercise/index.ts` +1 scenario (`GET …/scopes`, unknown session, 404).

### Wave 4 runs

- New test in `test/server/httpapi-workbench-debug.test.ts` (real debugpy through the routes; the program ends with
  `os._exit(1)`): stopped in `inner`, the caller `outer`'s scopes and then its locals (`count = 6`,
  `label = 'orders'`, none of `inner`'s); a watch evaluation in `outer` returns `60` with `seq 0` and adds no console
  row and no output event, while a repl evaluation adds its `eval` and `result` rows and is published; after
  continuing to the next stop, the old `outer` frame is 404 for scopes and for a watch.
  `test/workbench/mcp-debug.test.ts` now also checks the frame ids in the frames line and `debug_inspect` with
  `frame` on the caller's frame (`name: str = 'bob'`).
- `test/workbench` + debug HTTP test: 156 pass / 2 skip (Rust and C launches, "Developer Mode off") / 0 fail.
- `test/tool test/server test/session`: 1064 pass / 9 skip / 1 todo / 0 fail.
- `bun run test:httpapi`: 258 pass in all three modes (its `opencode/clever-cactus` and `opencode/playful-panda`
  branches, at our HEAD, deleted after `git worktree prune`; stray `packages/opencode/config.json` removed).
- Typecheck clean in `packages/opencode`, `packages/schema` and `packages/app`; `bun run generate` in
  `packages/client`: no diff. No lldb launch; DiagnosticReports (without intelligencetasksd) 58 before and after.

## Wave 5: tool creator

Agents or the user draft new tools; nothing in a draft runs until the user approves it; approved tools are ordinary
opencode custom tools (the `{tool,tools}/*.{js,ts}` format, `tool()` from `@opencode-ai/plugin` with zod args), live
in opencode and in every external agent through the Workbench MCP bridge.

### Lifecycle and files

All under the instance directory's `.opencode/`:

| Status     | File                             | How it gets there                                                     |
| ---------- | -------------------------------- | --------------------------------------------------------------------- |
| `draft`    | `tool-drafts/<name>.ts`          | `tool_create` (agents) or `POST /workbench/tools` (the user)          |
| `invalid`  | `tool-drafts/<name>.ts`          | a draft that fails the static checks, or failed to load when approved |
| `enabled`  | `tool/custom_<name>.ts`          | approve (moves the draft), or enable                                  |
| `disabled` | `tool/custom_<name>.ts.disabled` | disable (a rename; the registry only loads `.js`/`.ts`)               |

- The tool is called `custom_<name>`. The registry names a default-export tool after its file, so the approved file
  is `custom_<name>.ts` (not `<name>.ts`): no created tool can shadow a built-in, and `custom_*` is one permission.
- The registry never scans `tool-drafts/`. A draft is read and parsed, never imported: `validate.ts` checks the name
  (lowercase letters, digits, `_`, max 40, so no path tricks), the size (256 KB), that it transpiles
  (`typescript.transpileModule` with diagnostics; `typescript` comes in with `@opencode-ai/codemode` and is imported
  lazily) and that the default export is a call to `tool(` (AST, and no named `export const x = tool(...)`, which
  would load as an unreviewed extra tool). It also reads the description and an args summary from the source.
  `validate.ts` and `tools.ts` use only Node built-ins and npm packages: the desktop sidecar runs under Node.
- A name is free while no enabled or disabled tool has it (a new draft replaces an old draft of the same name);
  approve also refuses a `custom_<name>` that another config folder or a plugin already provides.
- Who drafted it (`createdBy`), when, and why approving failed are kept in opencode's storage
  (`workbench/tool/<projectID>/<name>`), not in the project.

### Approval and the live registry

`POST /workbench/tools/:name/approve { hash }`:

1. `hash` must be the sha256 of the draft the user reviewed (every listed tool has it): a draft an agent changed
   after the review is refused with 409.
2. The draft must pass the static checks (400 otherwise).
3. `@opencode-ai/plugin` is installed into that `.opencode` the way config does for every `.opencode` it loads (a
   no-op when present; the folder may be new).
4. The file is written to `tool/custom_<name>.ts` and imported once by the service: a tool that throws on import or
   does not default-export `tool({ description, args, execute })` is removed again and the draft becomes `invalid`
   with "it failed to load: …". So a broken tool never reaches the registry.
5. The draft is deleted and the registry is refreshed.

Refresh: `ToolRegistry.refresh()` invalidates the instance's registry `InstanceState`; the next use rebuilds it, so
the tool is live without a restart (and gone after disable or delete). Module caching: Bun keys loaded modules by path
and ignores query strings, Node keys them by URL; so the service evicts the file from `require.cache` (Bun) and both
the service and the registry import created tools from `file://…?v=<mtime>` (Node). A re-created or re-enabled tool
therefore loads its current file, and the registry gets the very module the service checked. A `custom_*` file that
still fails to load in the registry is skipped with a warning instead of breaking every tool, and is listed as
`invalid` ("it did not load").

Enable takes `{ hash }` too (the disabled file may have changed since the review) and loads the file the same way.
Reject deletes the draft. Delete removes the tool, disabled or not, and its draft.

### Permissions

- `tool_create` asks `edit` for the draft path, like the write tool (allowed by the default rules; denied in plan
  mode). Drafting never runs anything.
- Every call of a created tool asks `custom_<name>` (patterns `*`, metadata `{ args }`), in the registry's
  plugin-tool wrapper, which every caller goes through (sessions, the bridge's agent route). Agent defaults gain
  `"custom_*": "ask"` after `"*": "allow"`; the last matching rule decides, so the default allow cannot win
  (`test/workbench/tools/permission.test.ts`). "Always" in the prompt allows that tool from then on; an explicit user
  rule such as `"custom_hello": "allow"` wins too, and so does a user `"*": "allow"` (merged after the defaults, as for
  every other ask).
- Approve, reject, enable, disable, delete and the test run are routes for the IDE only: no agent tool and no MCP tool
  reaches them, and the agent route runs nothing but `tool_create` and `custom_*` tools. (An agent with unrestricted
  bash or edit could still write `.opencode/tool/*.ts` itself, as before this feature.)
- The test run (`POST …/run`) is the user's own call: it does not ask.

### External agents (Workbench MCP bridge)

- `opencode workbench mcp` adds `tool_create` (same fields as the built-in tool) and, on every `tools/list`, each
  enabled tool as `custom_<name>` with the JSON Schema of its zod args (from `GET /workbench/tools`). Clients that
  cache the list see new tools when they list again.
- Calls go to `POST /workbench/tools/agent { sessionID, tool, args }`, which runs the registry's tool as the default
  agent of the bridge's session, so the `custom_*` asks (and `tool_create`'s edit ask) appear in the IDE; arguments
  are checked against the tool's schema first (400).
- The bridge has one opencode session per process for every agent tool, now titled "Workbench MCP"
  (`src/workbench/mcp/session.ts`; it was "Workbench MCP: debugging", per debug bridge).
- `WorkbenchBridge.create`/`serve` take `extra` as a list or as a function that lists tools on each request, and a
  bridge tool may carry a ready `jsonSchema` (the problems branch's `bridge.ts`, marked `spicy:`).

### Contract (`packages/schema/src/workbench.ts`, additive)

| Export              | Identifier                  | Shape                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustomToolStatus`  |                             | `"draft" \| "enabled" \| "disabled" \| "invalid"`                                                                                                                                                                                                                                   |
| `CustomToolArg`     |                             | `{ name, type?, description?, required }`                                                                                                                                                                                                                                           |
| `CustomToolAuthor`  |                             | `{ by: "agent" \| "user", sessionID?, agent? }`                                                                                                                                                                                                                                     |
| `CustomTool`        | `WorkbenchCustomTool`       | `{ name, id (custom_<name>), description, args: CustomToolArg[], status, reason?, path (absolute file), source (the TypeScript), hash (sha256 hex of source), createdBy: CustomToolAuthor, createdAt, updatedAt (ms), inputSchema? (JSON Schema of the args, enabled tools only) }` |
| `CustomToolDraft`   | `WorkbenchCustomToolDraft`  | `{ name, description, source }`                                                                                                                                                                                                                                                     |
| `CustomToolResult`  | `WorkbenchCustomToolResult` | `{ title, output, metadata }`                                                                                                                                                                                                                                                       |
| `Event.ToolUpdated` |                             | `workbench.tool.updated` `{ tool: CustomTool }` (the file's view; the list adds the loaded `inputSchema`)                                                                                                                                                                           |
| `Event.ToolRemoved` |                             | `workbench.tool.removed` `{ name }`                                                                                                                                                                                                                                                 |

For drafts, `description` and `args` are read from the source; once enabled they come from the loaded tool.

### Routes (group `workbench-tools`, instance-scoped, same auth and errors as the debug routes)

| Method | Path                             | Body                        | Returns                                                                                         |
| ------ | -------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/workbench/tools`               |                             | `CustomTool[]` by name: drafts, enabled (with `inputSchema`) and disabled, with source          |
| POST   | `/workbench/tools`               | `CustomToolDraft`           | `CustomTool` (the user's draft; `invalid` with `reason` when the checks fail); 409 taken        |
| POST   | `/workbench/tools/:name/approve` | `{ hash }`                  | `CustomTool` (enabled); 404 no draft, 400 invalid or failed to load, 409 changed or taken       |
| POST   | `/workbench/tools/:name/reject`  |                             | `true`; 404 no draft                                                                            |
| POST   | `/workbench/tools/:name/disable` |                             | `CustomTool` (disabled); 404 not enabled                                                        |
| POST   | `/workbench/tools/:name/enable`  | `{ hash }`                  | `CustomTool` (enabled); 404 not disabled, 409 changed, 400 failed to load                       |
| DELETE | `/workbench/tools/:name`         |                             | `true`; 404 nothing by that name                                                                |
| POST   | `/workbench/tools/:name/run`     | `{ args }`                  | `CustomToolResult`; 404 not enabled, 400 bad args or "the tool failed: …"                       |
| POST   | `/workbench/tools/agent`         | `{ sessionID, tool, args }` | `CustomToolResult`; for the MCP bridge: `tool_create` or `custom_*`; 403 when an ask is refused |

### Files touched (wave 5)

- New: `src/workbench/tools/{validate,tools,create}.ts`, `create.txt`; `src/workbench/mcp/{session,tools}.ts`;
  `groups/workbench-tools.ts`, `handlers/workbench-tools.ts`, `handlers/workbench-agent.ts` (the agent context and
  defect mapping the debug and tools agent routes share; `handlers/workbench-debug.ts` uses it now).
- Upstream, marked `spicy:`: `src/tool/registry.ts` (`tool_create` built in, `refresh()`, the `custom_*` ask in the
  plugin-tool wrapper, the instance `.opencode` scanned, created tools imported by `WorkbenchTools.url` and skipped
  when they fail, `WorkbenchTools.node` dep); `src/agent/agent.ts` (`"custom_*": "ask"`);
  `server/routes/instance/httpapi/api.ts` (+2: the group), `server.ts` (+4: handlers, service);
  `test/session/tools.test.ts` (`refresh` on its fake registry); `test/server/httpapi-exercise/index.ts` (+9
  scenarios, one per route).
- Problems branch, marked `spicy:`: `src/workbench/mcp/bridge.ts` (`Extra`, `jsonSchema`), `src/cli/cmd/workbench.ts`
  (one bridge session for debug and tools, the dynamic list), `test/workbench/mcp.test.ts` (the stdio test expects
  `tool_create` too).

### Wave 5 runs

- `test/workbench/tools/validate.test.ts` (4): description and args from the source; reasons for a bad name, a path,
  a syntax error, a plain object export, a named tool export, a too-large file; no Bun APIs in `validate.ts` or
  `tools.ts`; the checks run under Node (`node --input-type=module`, Node 22) and agree with Bun.
- `test/workbench/tools/tools.test.ts` (3, real routes on a local port; `@opencode-ai/plugin` linked into the test
  project's `.opencode`, so nothing is installed): an agent drafts through the agent route; the draft's marker file
  (written at import time) is absent through listing, a broken draft (`invalid`, approve 400) and a stale-hash approve
  (409), and present right after approval; the registry has `custom_hello`; a taken name is 409; the agent's call
  asks `custom_hello` in its session with the args, and once allowed returns `hello Ada`; bad args 400; the test run
  does not ask; disable removes it from the registry (run 404), enable needs the current hash; delete removes it.
  Reject deletes a draft (then 404). The MCP bridge lists `tool_create` (and no approve/enable/reject tool), drafts
  through it in the "Workbench MCP" session, lists the approved `custom_greet` with its schema, calls it with the ask
  round trip (allowed → result, rejected → "permission denied in the IDE"), and drops it once disabled.
- `test/workbench/tools/permission.test.ts` (2): with the defaults, `"*": "allow"` comes first and `custom_*` asks
  for the build and general agents while other tools are allowed; an explicit `"custom_hello": "allow"` wins.
- `test/workbench` + debug HTTP test: 165 pass / 2 skip (Rust and C launches, "Developer Mode off") / 0 fail.
- `test/tool test/server test/session test/agent test/permission` + `permission-task` + `event-manifest`: 1261 pass /
  11 skip / 1 todo / 0 fail.
- `bun run test:httpapi`: 269 pass in all three modes (its `opencode/neon-meadow` and `opencode/quiet-pixel` branches,
  at our HEAD, deleted after `git worktree prune`; stray `packages/opencode/config.json` removed).
- Typecheck clean in `packages/opencode` and `packages/schema`. `packages/app` reports only `Cannot find module
'@codemirror/state'` (two lines in the merged editor code): this worktree's `node_modules` predates the CodeMirror
  dependencies (needs `bun install --frozen-lockfile`); no app file changed here. `bun run generate` in
  `packages/client`: no diff. DiagnosticReports (without intelligencetasksd) 60 before and after.

## Wave 6: console evidence and the LLDB command gate

### CON-05: agent evaluations are evidence, and their console rows say so

- No contract change: `ConsoleRow.evidenceID` (optional `EvidenceID`, `ev_…`) already existed and is now set. An
  agent's evaluation (the in-process `debug` tool, and so MCP `debug_evaluate`) in a session with an investigation is
  recorded as `console-eval` evidence (summary `expression → result`), and both of its console rows, `eval` and
  `result` (or `exception`), carry that evidence's id. The tool creates the id first and passes it to the session
  (rows) and to the investigation (evidence), so the link exists from the first published row.
- It resolves in `GET /workbench/investigations/:investigationID` → `evidence[].id` (the session's
  `DebugSessionInfo.investigationID` names the investigation). A human's evaluation is not evidence: its rows have no
  `evidenceID`, and the evaluate route cannot set one.

### CON-07: a human's raw LLDB command asks `debug.lldbCommand`

- lldb-dap runs input after the `` ` `` escape as an LLDB command (`platform shell`, `script`); sessions run with
  `--repl-mode variable` and our `commandEscapePrefix` (it overrides launch.json's), so only that prefix enters command
  mode. Agents stay refused before anything is sent (`DebugConsole.evaluate`, 400 "LLDB command mode is not
  available to the agent").
- For the human, `POST …/evaluate` with an expression starting with `` ` `` on an lldb-dap session (while stopped)
  first asks `debug.lldbCommand` through the permission service, under the default agent's rules: agent defaults
  gain `"debug.lldbCommand": "ask"` (next to the other debug keys, marked `spicy:`). The request waits for the answer.
  Once: the command runs. Always: no more LLDB command asks in this instance. Reject, or a `deny` rule: 403
  "debug.lldbCommand was not allowed: …" and nothing reaches the adapter. A config rule can allow it, also per command
  (`"debug.lldbCommand": { "bt*": "allow" }`).
- The ask, as `permission.asked` / `GET /permission`: `{ id, permission: "debug.lldbCommand", sessionID:
"ses_<debugSessionID>", patterns: [command], always: ["*"], metadata: { command, debugSessionID } }`, answered with
  `POST /permission/:id/reply { reply: "once" | "always" | "reject" }`. Its session is synthetic, one per debug
  session, so answering it never rejects an agent's pending asks (a reject clears the asking session's other asks).
  For the UI: show it in the Debug Console by `permission === "debug.lldbCommand"` and `metadata.debugSessionID`;
  there is no opencode session behind it (a notification link to it would 404), and the app's auto-accept for the
  directory answers it like any other ask.

### Not applicable

- DAP-16 / SEC-08 (TCP adapters bound to localhost): opencode starts no adapter on TCP. debugpy and lldb-dap run on
  stdio; the only TCP connections go out to `127.0.0.1` (`DapTransport`), to a launch.json `debugServer` or a
  `python -m debugpy --listen 127.0.0.1:PORT` program the user started.
- SEC-06 (adapter checksums): nothing is downloaded. debugpy comes from the user's Python or the VS Code extension,
  lldb-dap from Xcode (`xcrun -f lldb-dap`).

### Files touched (wave 6)

- `src/workbench/dap/console.ts`, `dap/session.ts` (evaluate takes the evidence id for its rows),
  `investigation/investigation.ts` (`console.eval` may name its evidence id), `tool/debug.ts` (creates it).
- `handlers/workbench-debug.ts` (the human LLDB gate), `groups/workbench-debug.ts` (evaluate may answer 403).
- Upstream: `src/agent/agent.ts` (`"debug.lldbCommand": "ask"`, marked `spicy:`).

### Wave 6 runs

- `test/workbench/tool/debug.test.ts` CON-05 (fake adapter): the agent's `eval` and `result` rows share an `ev_` id
  that is the investigation's `console-eval` evidence (`len(xs) → <len(xs)>`); the human's evaluation and rows
  have none. `test/workbench/mcp-debug.test.ts` (real debugpy): after `debug_evaluate`, the agent's result row's
  `evidenceID` resolves through `GET /workbench/investigations/:id`.
- `test/server/httpapi-workbench-debug.test.ts` CON-07 (fake adapter speaking for lldb-dap over TCP; no lldb):
  a plain expression is not asked; `` `platform shell echo hi `` asks `debug.lldbCommand` (synthetic session,
  command and debug session in the metadata), runs once allowed; `` `script import os `` rejected → 403, and only
  the allowed input reached the adapter. The agent refusal stays covered by `test/workbench/dap/session.test.ts`.
- `test/workbench` + debug HTTP test: 173 pass / 2 skip (Rust and C launches, "Developer Mode off") / 0 fail.
- `test/tool test/server test/session test/agent test/permission` + `permission-task` + `event-manifest`: 1272 pass /
  13 skip / 1 todo / 0 fail.
- `bun run test:httpapi`: 269 pass in all three modes (`opencode/crisp-sailor`, `opencode/misty-harbor` at our HEAD
  deleted after `git worktree prune`; stray `packages/opencode/config.json` removed).
- Typecheck clean in `packages/opencode`, `packages/schema` and `packages/app` (after the cache-only
  `bun install --frozen-lockfile --offline --ignore-scripts`); `bun run generate` in `packages/client`: no diff.
  No lldb launch; DiagnosticReports (without intelligencetasksd) 35 before and after.

## Security fixes (review findings 3 and 4)

### Finding 3: launch.json `${env:NAME}` passed secrets to the program

- `DebugLaunch.substitute` expanded any `${env:NAME}` from the server's environment into the configuration (args,
  env, …), so a program that prints its arguments handed the opencode server password or a provider key to the model
  as program output, which value-shape redaction cannot recognize. Approving a configuration never meant "send my
  environment".
- Now a name that `Redact.secretEnv` flags is not substituted, and the start fails with
  `${env:NAME} names a secret and is not passed to the program` (one per refused variable). `secretEnv` is the shared
  `Redact.secretName` list (password, secret, token, apikey, auth, credential, …) plus, for environment names only,
  anything containing KEY (API*KEY, ACCESS_KEY_ID, STRIPE_KEY) and `OPENCODE_SERVER*\*`. KEY stays out of the list
  used for program values, where key, keys and monkey are everyday variable names. Ordinary variables (HOME, PATH,
  USER, …) still expand, and an unset one is still empty.
- Test: `test/workbench/dap/launch.test.ts` inverts the review's repro (spicy-security 2a8d2d441, which now fails as
  intended): the probe secret is refused with that error and never appears; the server's credentials and provider
  keys are refused by name whether set or not; `${env:HOME}`, `${env:PATH}`, `${env:USER}` expand; a launch.json
  configuration using `${env:OPENCODE_SERVER_PASSWORD}` fails to start with the error.
- The follow-up: the server's own credentials are no longer inherited either (next section).

### Finding 4: enable could load a file swapped after the review

- `enable` hashed the `.ts.disabled` file, compared the hash with the reviewed one, then renamed whatever the file held
  by then. Now it keeps the bytes it hashed and installs exactly those as `custom_<name>.ts` (a temp file next to it,
  then a rename; the registry ignores `*.tmp`), loads it, and only then deletes the disabled file (on a failed load the
  enabled file is removed and the disabled one stays). `approve` installs its in-memory reviewed source the same way.
- Test: `test/workbench/tools/enable.test.ts` swaps the disabled file right after the service reads it (a file
  system wrapper); the enabled file and the loaded module are the reviewed ones and the swapped code never ran. The
  test fails on the previous rename.

### Runs

- `test/workbench` + debug HTTP test: 177 pass / 2 skip (Rust and C launches, "Developer Mode off") / 0 fail.
- `test/tool test/server test/session test/agent test/permission`: 1270 pass / 13 skip / 1 todo / 0 fail.
- Typecheck clean in `packages/opencode`. No route changed, so no `test:httpapi` run. DiagnosticReports (without
  intelligencetasksd) 35 before and after.

### The server's credentials stay out of adapters and debugged programs

- Every process the debugger starts used to inherit the server's whole environment, so a program under debug could
  read and print `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`. Now those two are left out, exactly as Agent
  HQ leaves them out of agent processes: `src/workbench/dap/env.ts` takes the variables that
  `AgentProvider.agentEnv()` drops (reused, not copied) and keeps them from the adapter (`Process.spawn`, where an
  undefined value unsets a variable), from the program in its terminal (`Pty.create` gains an `omit` option, a
  marked upstream edit in `packages/core/src/pty.ts`, since it adds `process.env` itself), and from the project's own
  Python (the debugpy probe) and build (`cargo test --no-run`), which run project code too.
- The tradeoff, deliberately: nothing else is removed. Provider keys and other user variables still reach the
  program, because a program under debug can legitimately need its own API keys and the human launched it. The model
  can therefore still see such a variable if the program prints it; launch.json `${env:NAME}` refuses secret names
  (finding 3), but the inherited environment is the user's.
- Test: `test/workbench/dap/debugpy.test.ts` (real debugpy) runs a program that prints
  `os.environ.get("OPENCODE_SERVER_PASSWORD")`, the username and an ordinary variable, both spawned by the adapter
  (internal console) and in a PTY (integrated terminal): the credentials print `None`, the ordinary variable its
  value. Without the change it printed the probe password.
- Runs: `test/workbench` + debug HTTP test 178 pass / 2 skip / 0 fail; `test/tool test/server test/session
test/agenthq` 1115 pass / 13 skip / 1 todo / 0 fail; `packages/core` PTY tests 18 pass; typecheck clean in
  `packages/opencode` and `packages/core`.

## UX wave 1 (audit #9 and #15)

### Review: a file decided both ways is `partial`

- `Review.FileState` already had `partial`, for a file with hunks left and some decided. A file with nothing left
  whose hunks were decided both ways used to say `accepted` (`review/changes.ts`); it is now `partial` too. The
  counts were already there: `File.accepted` (kept hunks) and `File.rejected` (reverted hunks); `hunks` is empty
  once everything is decided, so "Partly kept (1 kept · 1 reverted)" is `state: "partial"`, `hunks: []`,
  `accepted: 1`, `rejected: 1`. No new literal or field; the contract comment says so.
- Test: REV-01 in `test/review/review.test.ts` (accept one hunk, reject the other) now expects `partial` with
  `accepted: 1`, `rejected: 1`.

### Investigations: rule, sentence and runs apart

- Contract (`packages/schema/src/workbench.ts`, additive): `SupervisorRule` = `"S1" | … | "S8"`;
  `InvestigationCheckpoint` gains `rule?: SupervisorRule` and `runIDs?: RunID[]`; `InvestigationSummary` gains
  `rule?`, `runIDs?` and `evidenceID?` (from the same checkpoint as `reason`). `reason` is now the sentence alone:
  "no progress: same error after 2 patches", not "S2: … (checks run_1, run_2)". S1 and S2 name their runs in
  `runIDs`; other rules have none.
- Old records keep the prefix in storage; `WorkbenchInvestigation.checkpoint()` reads "S#: sentence (checks run\_…)"
  apart whenever records are read (`get`, `full`, `list`) and in every summary, events included.
- Text for agents and the report is unchanged (`WorkbenchInvestigation.explain`: "S2: no progress: … (checks
  run_1, run_2)"), so the gate's and the debug tool's messages still name the rule and runs.
- Tests: `rules.test.ts` checks the rule, sentence and runs of S1–S8 apart, the summary fields with the evidence
  id, the agent text, and old-format checkpoints; `investigation.test.ts` stores an old-format record and reads it
  through `full` (checkpoint and report) and `list`; the S2/S5/S7 assertions in `verification.test.ts`,
  `tool/debug.test.ts` and `mcp-debug.test.ts` now check the fields.

## Terminal.app session files (embedded shells)

- Bug: a process started from Terminal.app carries `TERM_PROGRAM=Apple_Terminal` and that window's `TERM_SESSION_ID`.
  Every interactive shell the server started in a PTY (the IDE terminal, debug Run terminals, tests) inherited both,
  so macOS's `/etc/zshrc_Apple_Terminal` and `/etc/bashrc_Apple_Terminal` saved "session restore" history into
  `~/.zsh_sessions/<id>.*` and `~/.bash_sessions/<id>.*`, overwriting the window's own files.
- Fix, `packages/core/src/pty.ts` (marked `spicy:`): `Pty.ownTerminal(env)` drops `TERM_SESSION_ID` and
  `TERM_PROGRAM_VERSION`, sets `TERM_PROGRAM=opencode` (as VS Code sets `vscode`, so the per-Terminal rc files are
  not read) and `SHELL_SESSIONS_DISABLE=1`; every PTY gets it. Agent HQ's `agentEnv()` applies it too, keeping its
  credential stripping, since agents' bash tools start shells (and the debugger's `DebugEnv` follows `agentEnv`).
- Also fixed, `packages/core/src/pty/pty.bun.ts` (marked `spicy:`): bun-pty starts the child with the server's own
  environment plus the given one, so leaving a variable out (this `TERM_SESSION_ID`, and the debugger's `omit` of the
  server credentials) did not unset it under Bun when the server process itself had it. The Bun backend now starts
  the command through `/usr/bin/env -u NAME …` for the variables left out (names only on the command line). node-pty
  (the Node sidecar) already takes the environment as given.
- Tests (never the real home: every shell runs with `HOME` and `ZDOTDIR` in a temp folder and a fake session id):
  `packages/core/test/pty/terminal-session.test.ts` — zsh and bash in an opencode PTY under a Terminal.app parent
  environment print `sid=unset tp=opencode ssd=1` and leave no `.zsh_sessions`/`.bash_sessions` in the temp home; a
  control (the same shells with Terminal's environment) does create them there; a child Bun process holding a secret
  and a session id in its real environment gets neither into its PTY; `ownTerminal` itself.
  `packages/opencode/test/agenthq/terminal-env.test.ts` — `agentEnv()` (terminal and credentials), an interactive
  shell started with it leaves no session files, and the control does.
- Runs: `packages/core` PTY tests 22 pass; `test/workbench test/agenthq` + debug HTTP test 266 pass / 8 skip / 0 fail;
  `test/tool test/server test/session` 1067 pass / 9 skip / 1 todo / 1 fail (`httpapi-v2-pty` "retains exited
  sessions", the known load timeout; 4/4 twice alone). All runs used `env -u TERM_SESSION_ID TERM_PROGRAM=opencode
SHELL_SESSIONS_DISABLE=1`, and the real `~/.zsh_sessions`/`~/.bash_sessions` were compared (read only) before and
  after: unchanged.

## lldb-dap with Developer Mode on (DAP-18, E2E-02/03/04)

- Root cause of the first real runs failing ("Failed to attach to the target process. Timed out trying to get messages
  from the runInTerminal launcher", about 1.6 s in): lldb-dap's runInTerminal launcher is lldb-dap itself
  (`lldb-dap --comm-file <fifo> --debugger-pid <pid> --launch-target <program>`). It sends lldb-dap its pid, and
  lldb-dap must attach to it before it execs the program. macOS refuses that attach for Xcode's Apple-signed lldb-dap.
  Evidence:
  - the lldb-dap protocol log shows the launch failing right after our runInTerminal reply;
  - a stand-alone replay (no opencode; the launcher in a bun-pty PTY, then as a plain child process) fails the same
    way, the launcher printing nothing;
  - `lldb -p <pid>` against an idle Xcode lldb-dap started for the check answers "Not allowed to attach to process",
    while attaching to a program compiled here works.
    Not the PTY service, its environment or the `env -u` wrapper.
- Fix (`dap/launch.ts`): lldb-dap launches use lldb's own launch (`runInTerminal: false`,
  `console: "internalConsole"`, still `commandEscapePrefix`). lldb runs the program on a pseudo-terminal and forwards
  its output as DAP output events, so stdout stays line-buffered and output written right before a crash survives
  (the reason runInTerminal was chosen). The cost: lldb-dap sessions have no `ptyID`, so no Run-tab terminal and no
  stdin. debugpy is unchanged.
- Snapshots (`dap/snapshot.ts`): a language runtime's own failure report is shown as the exception, from the code
  that failed.
  - A Rust panic stops at the `rust_panic` breakpoint under std/core's panic frames. The snapshot drops those frames,
    so frames, locals and the default frame are the program's, and reports `exception panic`.
  - A Swift runtime failure stops in `_swift_runtime_on_report` (lldb reports a breakpoint, "Fatal error: Index out of
    range"). The snapshot starts below libswiftCore's frames and reports `exception Swift runtime failure: …`.
  - Rust symbol hashes (`::h…`) are dropped from frame names. Long std frames were what pushed the test's frame out of
    the 2 KB snapshot.
- Tests (all real lldb-dap; Developer Mode on):
  - `lldb.test.ts`: DAP-02 initialize against the captured profile; C breakpoint stop with locals; a C program that
    prints a line and then dereferences NULL stops on EXC_BAD_ACCESS at line 5, its line arrives, and stopping the
    session kills it.
  - `rust.test.ts:163`: the rust-test preset stops on the panic at `avg::tests::empty`, and `orders` shows `20`
    through rustc's formatters.
  - E2E chains in `investigation/verification.test.ts`, each with a scripted model:
    - E2E-02 (C, clang) and E2E-03 (Swift, swiftc): debug start → crash stop (EXC_BAD_ACCESS / "Index out of range")
      in `average` with the output before it → stop → patch → rebuild with the shell → native check → debug start
      again, which runs to exit 0 as the reproduction → resolved, evidence exception (observed), check-run and
      repro-run (verified).
    - E2E-04 (Rust, cargo): panic stop shown from `avg::average` with `xs: &[i32] = size=0` → patch → check with
      cargo check and cargo test → resolved.
  - Every chain checks that nothing the debugger started is left running.
- Runs (`env -u TERM_SESSION_ID -u TERM_PROGRAM SHELL_SESSIONS_DISABLE=1`):
  - `test/workbench` + debug HTTP test: 224 pass, 0 skip, 0 fail.
  - Whole opencode suite: 3944 pass, 28 skip, 1 todo, 0 fail (3973 tests, 309 files, 376 s).
  - `packages/core`: 1104 pass.
  - DiagnosticReports: no new `.ips`. Only macOS's own diagnostics came and went: the crashes were stops under the
    debugger.
  - No lldb-dap or debugserver left running.
