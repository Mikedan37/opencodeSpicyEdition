# spicy-problems notes

Branch `spicy-problems`. Scope: P1 (problem store, LSP hook, events, `GET /workbench/problems`) and P2
(verification engine, `check` tool, turn-end gate, test runs). Contract: `packages/schema/src/workbench.ts`,
unchanged (no additive changes were needed).

## P1: problem store, LSP hook, events, route

Implemented:

- `packages/opencode/src/workbench/problems/store.ts` (`WorkbenchProblems.Service`, per-instance `InstanceState`).
  Slices keyed by producer, each holding file → `Problem[]`. `begin(producer)` starts a new generation and aborts the
  previous run's `AbortSignal`; `finish(producer, generation, result)` replaces the slice atomically and returns
  `false` (results dropped) when a newer generation exists. Problem ids are `sha1(producer, file, code, message,
  start line)`; duplicates within one result are dropped. `snapshot({ severity, source, file })` computes counts,
  producer states and `stale` (one `stat` per file: stale when mtime is newer than `observedAt`, or the file is gone).
- `workbench.problems.updated` is coalesced to at most one event per 100 ms by a scoped fiber reading a change
  queue, and published through `EventV2Bridge`, so it carries `location.directory` and reaches GlobalBus with the
  project directory.
- LSP hook: `LSPClient.create` takes `onDiagnostics` and calls it with the merged (push + pull, deduplicated) list
  whenever a push or a pull replaces a file's diagnostics. `LSP.Service.diagnosticEvents()` is a `Stream` that
  replays the latest event per server, root and file, then follows new ones (replay and listener registration
  happen in one synchronous step, so nothing is lost). The store subscribes when its instance state is created.
- `packages/opencode/src/workbench/problems/lsp-source.ts`: LSP `Diagnostic` → problem draft (kind `lsp`, tool =
  server id, producer `lsp:<serverID>:<root>`, code, `codeDescription.href` → `codeHref`, `relatedInformation` →
  `related`, ranges kept 0-based).
- Route group `WorkbenchApi` (`groups/workbench.ts`, `handlers/workbench.ts`): `GET /workbench/problems` with query
  `severity`, `source`, `file` (absolute or relative to the directory) → `ProblemsSnapshot`.

Design choices:

- DIAG-01 "both sources listed": the contract has one `source` per problem, so push and pull of the same error
  become one problem from the server's producer. The LSP client already merges both channels; the store never sees
  two copies.
- Stale uses mtime, not a content hash: one `stat` per file at read time, no reads.
- Runs that time out or have no tool keep the previous slice (it turns stale when the file changes) and set the
  producer state and reason instead.

## P2: verification engine, `check` tool, turn-end gate, test runs

Implemented (`packages/opencode/src/workbench/verify/`, `packages/opencode/src/workbench/tool/`):

- `checkers.ts`: checker definitions in the formatter pattern (`unit()` maps a changed file to its unit, `plan()`
  resolves the binary and returns one command plus its exec class, `parse()`):
  - `tsc`: nearest `tsconfig.json`; local `node_modules/.bin/tsc`, else `tsc` on PATH; `tsc --noEmit -p <tsconfig>
    --pretty false`.
  - `clang`: a `compile_commands.json` entry (its flags, `-fsyntax-only`, SARIF) or the file's folder. A folder with no
    build system whose sources define `main()` is compiled and linked to `/dev/null`, so a program that type-checks
    but does not link fails (VER-02); otherwise `-fsyntax-only`. `clang++` for C++ sources.
  - `swift`: `Package.swift` → `swift build` (exec when the manifest has plugins, macros or package dependencies);
    loose files → `swiftc -typecheck` over the folder's `.swift` files.
  - `cargo`: crate = nearest `Cargo.toml` with `[package]`, run from the workspace root with `-p <name>`; exec when
    the crate has `build.rs`, `build =`, `proc-macro = true` or any dependency (dependencies can carry build scripts
    and proc macros).
  - `go` (`go build -json -o /dev/null .`) then `go-vet` (`go vet .`, only after a clean build), per package folder
    inside a module.
  - `ruff` (`ruff check --no-cache --output-format=json <files>`; F821/F822/F823/E999 and syntax errors are errors,
    other rules warnings) and `mypy` (`mypy -O json <files>`, optional: left out when not installed; exec when a
    config sets `plugins`). Python unit = nearest `pyproject.toml`/`setup.cfg`/`ruff.toml`/`mypy.ini`, else folder.
  - Test runners (only with `tests: true`, always exec): `go-test` (`go test -json .`, after a clean build),
    `cargo-test` (`cargo test --message-format=json -p <name>`, after a clean check), `bun-test` (bun projects,
    JUnit to stdout) and `node-test` (packages whose test script uses `node --test`, JUnit to stdout). Changed test
    files narrow bun and node runs.
- `parse.ts`: clang SARIF (multiple documents per stderr) plus linker text → a `build` problem with code `link`;
  tsc text (continuation lines); `file:line:col: [severity:] message` text (swift, swiftc, go vet, go build output)
  after stripping ANSI; cargo JSON (primary span + label, secondary spans → `related`, code); go build JSON; ruff
  JSON; mypy JSON (0-based columns); go test JSON (assertion line or first panic frame in the package); JUnit XML
  (first stack frame in the project, else the testcase file/line); cargo test text (panic location).
- `verify.ts` (`WorkbenchVerify.Service.run`): maps files to units, plans, asks once for the exec-class units
  (`approve` callback), runs units two at a time (checkers that share a unit run in order), each with the remaining
  per-call budget (default 60 s) as its timeout, through `ChildProcessSpawner` (process group killed on timeout,
  cancellation or interrupt). Output is kept in memory (4 MB per stream) and streamed as `workbench.run.output` at
  most four times a second (1 MB per run). Every run publishes `workbench.run.updated` (`running`, then final) and
  replaces its store slice `check:<checker>:<unit>` with `runID` and `observedAt = startedAt`. A non-zero exit with
  no parsed error adds an error problem with the output tail, so a crash is never a pass. The engine builds the
  `VerificationReport` (system-generated id `vr_…`, `newErrors` = errors in changed files plus file-less errors,
  `otherErrors` = the rest of the unit, `unverifiedFiles` = changed files without a covering run or with any
  covering run not passed; cancelled runs are counted under `skipped`) and keeps the last 50 per instance.
  Statuses: `passed`, `failed`, `timed_out` (reason `budget`), `skipped` (`budget`, `needs approval (verify.exec)`,
  `<checker> did not pass`), `unavailable` (`<tool> not found` or the spawn error), `cancelled` (newer run).
- `tool/check.ts` + `check.txt`: `check` tool. Args `files?`, `unit?` (folder → its source files via ripgrep,
  gitignore-aware, max 200; or one file), `tests?`. No arguments → files changed since the last user message that
  is not a gate repair. Exec-class units ask `verify.exec` once (patterns = unit roots). Unknown keys are rejected
  (`onExcessProperty: "error"`), so a call cannot pass a report or a status. Output: summary line, errors in the
  checked files and elsewhere (`path:line:col severity code [tool] message`), warning count, one line per run,
  unverified files. Metadata: `{ report }`.
- `gate.ts` (`WorkbenchGate.Service.run`), called from the loop exit branch in `session/prompt.ts` after a turn this
  loop ran (`step > 0`). No-op when the mode is `off` or no file changed since the latest user message (patch parts
  plus completed `edit`/`write` targets and `apply_patch` files; deleted files ignored). Otherwise checks the files
  changed since the last real user message, running inert checkers and exec ones only when `verify.exec` evaluates
  to `allow` for the agent + session rulesets (never asks; no tests). In `fix` mode, errors in changed files add one
  synthetic user message (text part `synthetic: true`, `metadata.verify_gate = { reportID, attempt }`, up to 30
  errors listed) and the loop continues, at most 2 times per user message; errors only in unchanged files are
  reported, not retried. Failures inside the gate are logged and the loop exits as before.

Gate configuration: `OPENCODE_VERIFY_GATE=off|report-only|fix` (default `fix`, invalid values fall back to `fix`),
read by a `ConfigService` in `gate.ts`. Chosen over a config-schema key because it needs no edit to the upstream
config schema (`packages/core/src/v1/config/config.ts`), its migration or the generated SDK, and tests can provide
the flag with `WorkbenchGate.Flags.configLayer`. Moving it to a `verify.gate` config key later is additive.

Upstream-owned files touched (each edit marked `spicy:`):

| File | Change | Why |
|---|---|---|
| `packages/opencode/src/lsp/client.ts` | `DiagnosticsEvent` type, `onDiagnostics` input, `emitDiagnostics` called after push, pull and the TS first-push seed | Problem store hook; no other logic changed |
| `packages/opencode/src/lsp/lsp.ts` | State keeps the latest event per file plus listeners; `onDiagnostics` passed to `LSPClient.create`; `diagnosticEvents()` on the interface | Subscription for the store |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | Import and `.addHttpApi(WorkbenchApi)` (2 lines) | Compose the route group |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Imports; `workbenchHandlers`; `WorkbenchProblems.node` in the app graph (4 lines) | Serve the group |
| `packages/opencode/src/tool/registry.ts` | Import, `const checktool = yield* WorkbenchCheckTool.CheckTool`, `yield* Tool.init(checktool)` in the built-ins, `WorkbenchCheckTool.node` in deps (4 lines) | Register `check` |
| `packages/opencode/src/session/prompt.ts` | Import, `const gate = yield* WorkbenchGate.Service`, gate call before `break` at the loop exit, `WorkbenchGate.node` in deps (5 lines) | Turn-end gate |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | One coverage line for `workbench.problems` | `test:httpapi --fail-on-missing` |
| `packages/opencode/test/{session/prompt,session/snapshot-tool-race,tool/lsp}.test.ts` | LSP stubs gain `diagnosticEvents: () => Stream.empty` | They build `LSP.Service.of` with every method |

`verify.exec: ask` already existed in `agent/agent.ts` (foundation commit); not touched. `bun run generate` in
`packages/client` produced no tracked changes (the client is generated from the protocol API, which does not include
instance route groups).

## Tests

New files under `packages/opencode/test/workbench/` (fixtures in `test/fixture/workbench/`: `zoo.ts` bug zoo as
strings so the package typecheck never sees planted errors, `golden/*.json` real captures with the capture root
written as `/ROOT`, `lsp-push-pull.js` fake language server, `marker-check.js` stand-in checker):

| ID | Test | Layer |
|---|---|---|
| DIAG-01 | push + pull through the real LSP service and a fake server → one problem with code, href, range, producer | `problems.test.ts` |
| DIAG-02 | edit after observation → stale; new result → fresh | `problems.test.ts` |
| DIAG-03 | newer generation aborts the older signal; the older `finish` is dropped | `problems.test.ts` |
| DIAG-04 | event reaches GlobalBus with the project directory and EventV2 listeners with `location.directory` | `problems.test.ts` |
| VER-01 | 12 golden captures (clang SARIF, clang link, clang -fsyntax-only, tsc, swiftc, swift build with and without color, cargo, go build, go vet, ruff, mypy) → exact problems | `parse.test.ts` |
| VER-02 | Z-LINK-C with real clang → `failed`, link problem, unverified; defined function → `passed` | `verify.test.ts` |
| VER-03 | Z-MONO: one TS project, one Go package, one workspace crate run alone (real tsc, go, cargo); unit mapping | `verify.test.ts` |
| (clang) | a `compile_commands.json` entry is its own unit and keeps its flags (`-D…`), dropping `-c`/`-o` | `verify.test.ts` |
| VER-04 | 500 ms budget: two runs `timed_out` (processes gone), third `skipped: budget`, 0 passed | `verify.test.ts` |
| VER-05 | missing tool / failing spawn → `unavailable` with reason, files unverified, producer state | `verify.test.ts` |
| VER-06 | crate with `build.rs` asks and is skipped when denied, passes when allowed; SwiftPM plugin and mypy plugins are exec; the tool asks `verify.exec` | `verify.test.ts`, `check-tool.test.ts` |
| VER-08 | fake model writes a broken file → one repair message, loop continues, fix → second report passes | `gate.test.ts` |
| VER-09 | still broken after 2 repairs → gate stops, last report failed | `gate.test.ts` |
| VER-10 | error only in an unchanged file → `otherErrors`, no repair | `gate.test.ts` |
| VER-11 | turn without file changes → no report | `gate.test.ts` |
| (mode) | `report-only` reports without a repair message | `gate.test.ts` |
| VER-12 | `check` with a forged `report` or `status` argument is rejected; reports only come from runs | `check-tool.test.ts` |
| VER-13 | go test, node --test, bun test, cargo test goldens → failing test, file, line; real `go test` run through the engine | `parse.test.ts`, `verify.test.ts` |

Real-toolchain tests skip when the tool is missing; the test name names the tool (`[clang]`, `[tsc]`, `[go]`,
`[cargo]`, `[swift]`, `[mypy]`). All of them ran on this Mac.

Commands (from `packages/opencode`):

- `bun test --timeout 30000 test/workbench`
- `bun test --timeout 30000 test/lsp test/server test/session test/tool test/workbench`
- `bun run typecheck`
- `bun run test:httpapi`

## Not done, blockers, notes for the coordinator

- VER-07 (commands defined in repo config): done in wave 3 (`workbench.checks`).
- VER-09's "investigation blocked" belongs to the investigation work (P5); the gate stops and the report says
  failed.
- VER-14 (pytest JUnit, swift test xUnit): done in wave 2.
- Routes `POST /workbench/check`, `GET /workbench/runs`, `GET /workbench/runs/:runID`, `GET /workbench/doctor`: done
  in wave 2.
- The gate cannot see "always" approvals the user granted earlier in the session (they live in the Permission
  service state); it only honours `verify.exec: allow` in the agent or session rules.
- The problem store starts with its first use (route, check tool or gate); LSP diagnostics produced earlier are
  replayed on subscription.
- Merge notes for `spicy-lsp`: keep the `onDiagnostics` property in the `LSPClient.create({...})` call inside
  `getClients` and the three `emitDiagnostics` calls in `client.ts`. Any new `LSP.Service.of({...})` stub needs
  `diagnosticEvents: () => Stream.empty`. DIAG-07: since spicy-lsp, a dead server's files are cleared through the
  client's update functions, so its problems leave the store (tested in wave 2).
- `compile_commands.json` `command` strings are split on whitespace (quoted arguments need `arguments`). mypy needs
  1.11+ for `-O json`. go `-o /dev/null`, bun `--reporter-outfile=/dev/stdout` and the clang link output are
  Unix-only paths.
- The full regression run once hit a timing flake in `test/server/httpapi-v2-pty.test.ts` (PTY exit not seen in 20 s)
  while other heavy processes were running; it passes alone and in a quiet full run.

## Wave 2: routes, VER-14 runners, MCP bridge

Branch fast-forwarded to `spicy-ide` 6c2f6f274, then five commits (see the report).

### Routes (`WorkbenchApi`, `groups/workbench.ts` + `handlers/workbench.ts`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/workbench/problems` | `severity`, `source`, `file` | `ProblemsSnapshot` |
| POST | `/workbench/check` | `{ files?, unit?, tests?, trigger? }` | `VerificationReport` |
| GET | `/workbench/runs` | | `RunInfo[]`, newest first, last 100 runs of the instance |
| GET | `/workbench/runs/:runID` | | `{ run: RunInfo, output: string, truncated: boolean }` (first 256 KB of stdout+stderr as they arrived), 404 `NotFoundError` |
| GET | `/workbench/doctor` | | the workbench doctor report (`WorkbenchDoctorReport`) |

- `trigger` defaults to `user`: a person started the check in the IDE, so exec-class units run (the report still
  shows `execClass: "exec"` for them). `trigger: "agent"` (the MCP bridge) runs exec-class units only when
  `verify.exec` evaluates to `allow` for the default agent's ruleset (built-in defaults plus the user's
  `permission` config); otherwise they are `skipped` with reason `needs approval in the IDE`. Nobody is asked.
- `unit` is a folder (its source files, gitignore-aware via ripgrep, at most 200) or a file; the engine expands it,
  so the `check` tool and the route share the logic. `tests: true` gets a 180 s budget instead of 60 s.
- The engine keeps run records per instance (capped at 100 runs, 256 KB output each) for the Output tab; runs from
  the agent's `check` tool and the turn-end gate appear there too (one engine instance per app).
- Upstream-owned lines touched in wave 2: `server.ts` (+2: import and `WorkbenchVerify.node` in the app graph),
  `src/index.ts` (+2: import and `.command(WorkbenchCommand)`), the httpapi exercise `index.ts` (scenarios moved to
  `httpapi-exercise/workbench.ts`, +2 -1). The doctor handler gets `AppProcess` from a layer provided on the
  workbench handler group (stateless, so no app-graph line).
- `test:httpapi`: 224/224 in coverage, auth and effect modes (the four new endpoints included).

### Test runners (VER-14) and what this toolchain emits

- Checker plans may use `$REPORT_DIR` (`WorkbenchCheckers.REPORT_DIR`): the runner creates a scoped temp folder,
  substitutes it, reads every file in it after the run (name order) into the parser's `report`, and removes it.
- pytest: the first runnable of every `pytest` on PATH, then `python3 -m pytest` for every `python3` on PATH, each
  probed with `--version` (5 s); the dead x86 `/usr/local/bin/python3` fails to spawn and is skipped. Resolved once
  per process. Here: `/usr/local/bin/pytest` (8.3.4, CommandLineTools Python 3.9). Command:
  `pytest --junitxml=$REPORT_DIR/junit.xml -q -p no:cacheprovider [changed test files]`. Exit 5 (no tests collected)
  is `skipped`, never `passed`. pytest's JUnit has no file/line attributes; the parser takes the innermost
  in-project `file.py:line:` traceback line.
- swift test: `swift test --parallel --xunit-output $REPORT_DIR/xunit.xml`, after `swift build` passed. On Swift 6.4
  (Xcode): without `--parallel` the XCTest results never reach xUnit (only `xunit-swift-testing.xml` appears); with
  it, `xunit.xml` has `<failure message="failure">` without location; swift-testing's file has the expectation text
  but no location either. The parser takes the failing test names from both files and the locations from the
  console: XCTest prints `File.swift:line: error: -[Module.Class test] : message`, swift-testing prints
  `✘ Test name() recorded an issue at File.swift:line:col: message` with a bare file name, looked up under the
  package's `Sources` and `Tests`. If no test ran (a test target failed to build) it reports the compiler output.
- Test runners run after all checkers, one at a time (`03d866f83`): two pytest processes starting together hit a
  race in a plugin installed here (xonsh creates its data folder without `exist_ok`, pytest exits 3).
- Goldens: `golden/pytest.json`, `golden/swift-test.json` (real captures, home paths written as `/HOME`).

### Fixture rule (no crashing processes)

Every fixture that a test executes fails through ordinary assertions: go test (`t.Errorf`/`t.Fatalf`), cargo test
(`assert_eq!`), swift test (`XCTAssertEqual`, `#expect`), bun/node (`expect`/`assert`), pytest (`assert`, plus one
test whose code raises `ZeroDivisionError`, a Python exception that pytest reports; the interpreter does not
crash). Before this rule the go test fixture divided by zero (a Go runtime panic, exit 2) and the cargo test fixture
divided by zero (a Rust panic caught by the harness); neither is an OS crash, but both now use assertions
(`f30ad43a3`). The old go capture is kept as `golden/go-test-panic.json`, parser input only. Compile-only fixtures
(type errors, the link error) are never executed. Abrupt exits in fake servers use `process.exit(1)`. None of
today's crash reports in `~/Library/Logs/DiagnosticReports` match these runs: the Python ones are Xcode's
Python.app calling `abort()` from Python code with no pytest modules loaded, and none appeared while the VER-14
pytest runs were repeated.

### Workbench MCP bridge

`opencode workbench mcp` (`src/cli/cmd/workbench.ts`, `src/workbench/mcp/bridge.ts`): a stdio MCP server that
proxies to an already running opencode server. It keeps no state and runs nothing itself.

- Connection: `--url` or `OPENCODE_SERVER_URL` (required); `--directory` or `OPENCODE_DIRECTORY` (default: the
  current directory); basic auth from `OPENCODE_SERVER_USERNAME` (default `opencode`) and
  `OPENCODE_SERVER_PASSWORD`, the same variables the server reads. Requests carry `x-opencode-directory`.
- Tools: `workbench_problems`, `workbench_check` (always sends `trigger: "agent"`), `workbench_doctor`. Inputs are
  Effect Schemas served as JSON Schema and decoded with `onExcessProperty: "error"`, so `trigger` or any other
  extra argument is rejected. Results: a text summary plus `structuredContent` (snapshot, `{ report, problems }`
  with the problems of this check's runs, doctor report). Route JSON is decoded with each schema's canonical JSON
  codec (absent optionals arrive as `null`). Server errors and an unreachable server come back as `isError`
  results with the reason.
- Extension point for `spicy-dap`: `WorkbenchBridge.define({ name: "debug_…", title, description, input, run })`
  and pass the tools as `extra` to `WorkbenchBridge.create(connection, extra)` / `serve(connection, extra)` (and to
  the `serve` call in `src/cli/cmd/workbench.ts`). `run(args, api, connection)` gets a small HTTP client
  (`api.get`, `api.post`) bound to the server, directory and credentials.

Claude Code example (`claude --mcp-config workbench.json`; tools then appear as
`mcp__opencode-workbench__workbench_check` etc.):

```json
{
  "mcpServers": {
    "opencode-workbench": {
      "command": "opencode",
      "args": ["workbench", "mcp", "--directory", "/path/to/project"],
      "env": {
        "OPENCODE_SERVER_URL": "http://127.0.0.1:4096",
        "OPENCODE_SERVER_PASSWORD": "the server password, if the server has one"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`, `[mcp_servers.opencode-workbench]` with `command`, `args`, `env`) and Cursor
(`.cursor/mcp.json`, same shape as above) take the same command and environment.

### Wave 2 tests

| ID | Test | File |
|---|---|---|
| routes | check → runs → run output (real clang); 404; doctor; user vs agent trigger and `verify.exec: allow` (real cargo) | `test/workbench/routes.test.ts` |
| DIAG-07 | the fake server exits on a change; its problems leave the store; LSP status shows `error` | `test/workbench/problems.test.ts` |
| VER-14 | pytest and swift test goldens; real pytest run (failed + `no tests collected` skipped); real swift test run after a clean build | `test/workbench/parse.test.ts`, `test/workbench/verify.test.ts` |
| MCP | tools/list with exact schemas; check (clang) and problems; exec skipped for agents (cargo); unknown `trigger` rejected; doctor; unreachable server; directory and basic-auth headers; stdio run of `opencode workbench mcp` | `test/workbench/mcp.test.ts` |

### Wave 2 results (from `packages/opencode`)

- `bun test --timeout 60000 test/lsp test/workbench test/agenthq test/tool test/session test/server test/agent`:
  1262 pass, 9 skip, 1 todo, 0 fail (110 files, 163.6 s). Two earlier full runs, while the machine's load average
  was 20 to 32 from other sessions' builds, hit the upstream `test/server/httpapi-v2-pty.test.ts` timing flake (the
  PTY's `exit 4` not observed within 20 s); it passes alone (5 of 5), with `test/workbench` in front of it, and in
  the full run above.
- `bun test --timeout 60000 test/workbench`: 66 pass, 0 fail (8 files, including spicy-lsp's doctor tests).
- `bun run typecheck`: clean. `bun run test:httpapi`: 224/224 in coverage, auth and effect modes.
- `bun run generate` in `packages/client`: no tracked changes.

## Wave 3: repository check commands (VER-07)

Branch fast-forwarded to `spicy-ide` fe1c8528b. `bun install --frozen-lockfile --offline --ignore-scripts` linked the
owner-approved `@anthropic-ai/claude-agent-sdk` 0.3.293 from the local cache; `bun.lock` and `package.json` did not
change.

Config (one optional fork key):

```jsonc
{
  "workbench": {
    "checks": {
      "lint": {
        "command": ["bun", "scripts/lint.ts"], // program + arguments, no shell
        "cwd": "packages/web", // optional, relative to the project directory
        "files": ["packages/web/**/*.ts"], // optional globs (project-relative) that trigger it; default: every file
        "format": "plain" // plain | tsc | sarif | cargo | go-build | ruff | mypy | junit | go-test
      }
    }
  }
}
```

- `plain` reads `file:line(:col): [error|warning|note: ]message` lines from stdout and stderr (the file needs an
  extension). The other formats reuse the existing parsers; `sarif` takes one SARIF document on stdout, else
  clang-style documents mixed with text. `junit` and `go-test` checks are test runs: they run only when tests are
  requested. `$REPORT_DIR` in the command is replaced by a temporary folder whose files are handed to the parser
  (for JUnit written to a file).
- A repository check is arbitrary repository code, so it is always exec-class: the `check` tool asks
  `verify.exec`, the turn-end gate and agent-triggered routes run it only when the rules already allow
  `verify.exec`, otherwise it is `skipped` ("needs approval (verify.exec)" in the gate, "needs approval in the IDE"
  for `trigger: "agent"`, which the MCP bridge always sends). `POST /workbench/check` from the IDE (`trigger:
  "user"`) runs it.
- It is read from the configuration when a check runs and never runs on load. It runs only through the engine
  (check tool, turn-end gate, `POST /workbench/check`, MCP `workbench_check`), with the same budget, timeout,
  process-group kill, run record, output streaming and store slice (`check:<name>:<cwd>`) as built-in checks. One
  unit per check (its cwd). A non-zero exit with nothing parsed is `failed` with the output tail. A check named like
  a built-in checker (for example `tsc`) replaces it.
- `/workbench/doctor` (and MCP `workbench_doctor`) lists them as a "Repository checks" section: the program is
  located (a name on PATH, or a path relative to its cwd), never run. The CLI `opencode debug workbench doctor`
  does not show them yet.

Upstream-owned edit: `packages/core/src/v1/config/config.ts` (+2 lines: import and the `workbench` key, marked
`spicy:`). New fork file: `packages/core/src/v1/config/workbench.ts` (`ConfigWorkbenchV1`). Fork files changed:
`workbench/verify/{checkers,parse,verify}.ts`, `handlers/workbench.ts`.

Generated outputs: upstream regenerates the legacy SDK (`packages/sdk/js/src/**/gen`) and `packages/sdk/openapi.json`
in CI on `dev` (`.github/workflows/generate.yml` runs `./script/generate.ts` and commits "chore: generate"), not in
feature branches; the fork's generated SDK has not been regenerated for any fork route group yet. Running
`./script/generate.ts` on `spicy-ide` (with isolated XDG directories) picks up `Config.workbench` together with every
fork route group. The config JSON schema (`config.json`) is built from `ConfigV1.Info` by `script/schema.ts` at
publish time and needs nothing else. `bun run generate` in `packages/client` produced no tracked changes.

Wave 3 tests (`test/workbench/repo-checks.test.ts`, one in `mcp.test.ts`), fixture config written per test, the
command a small script that records each run and fails through ordinary exits:

| Case | Expected |
|---|---|
| default rules (gate semantics) | `skipped`, "needs approval (verify.exec)", never ran, file unverified |
| approved | asks once for the unit, runs once, `plain` output parsed into an error and a warning, store slice and run list |
| failing command, nothing parseable | `failed`, exit 3, problem "broken exited with code 3" + output tail |
| budget | `timed_out` (budget), and the command's own child process is killed with it |
| globs and test formats | other files do not trigger it; a `junit` check runs only with tests |
| doctor | listed with `ok` / `missing` and the reason, never run |
| HTTP, agent trigger | skipped "needs approval in the IDE"; loading problems and doctor never runs it |
| HTTP, `verify.exec: allow` | runs; run list and run output; problems filterable by `source=build` |
| MCP | `workbench_check` reports it skipped "needs approval in the IDE" |

Wave 3 results (from `packages/opencode`):

- `bun test --timeout 60000 test/lsp test/workbench test/agenthq test/tool test/session test/server test/agent`:
  1362 pass, 12 skip, 1 todo, 0 fail (125 files, 212 s).
- `bun test --timeout 60000 test/config test/workbench`: 378 pass, 5 skip, 0 fail.
- `bun run typecheck` (opencode and core): clean. `bun run test:httpapi`: 255/255 in coverage, auth and effect modes.
- After `test:httpapi`: its leftover branches `opencode/hidden-island` and `opencode/playful-nebula` (tips
  fe1c8528b, ours) were deleted after `git worktree prune` released their stale temp worktrees; the stray
  `packages/opencode/config.json` was removed.
- `~/Library/Logs/DiagnosticReports` without `intelligencetasksd`: 52 before the runs, 52 after.
