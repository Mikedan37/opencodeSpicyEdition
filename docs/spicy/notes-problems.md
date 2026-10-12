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

- VER-07 (commands defined in repo config) is not implemented: there are no config-defined checkers, because the
  gate's config surface is an env flag. Adding `verify.checker.<name>.command` would need the config schema and
  must default to exec-class.
- VER-09's "investigation blocked" belongs to the investigation work (P5); the gate stops and the report says
  failed.
- VER-14 (pytest JUnit, swift test xUnit) is blocked: pytest is not installed; `swift test` parsing is not written.
- Routes `POST /workbench/check` and `GET /workbench/runs/:runID` from the plan's route table are not implemented
  (only `GET /workbench/problems` was in scope). Run records and output stream as events today.
- The gate cannot see "always" approvals the user granted earlier in the session (they live in the Permission
  service state); it only honours `verify.exec: allow` in the agent or session rules.
- The problem store starts with its first use (route, check tool or gate); LSP diagnostics produced earlier are
  replayed on subscription.
- Merge notes for `spicy-lsp`: keep the `onDiagnostics` property in the `LSPClient.create({...})` call inside
  `getClients` and the three `emitDiagnostics` calls in `client.ts`. Any new `LSP.Service.of({...})` stub needs
  `diagnosticEvents: () => Stream.empty`. DIAG-07 ("old problems marked stale" after a crash) would need LSP to
  report the crash; the store has no producer-state hook for LSP yet.
- `compile_commands.json` `command` strings are split on whitespace (quoted arguments need `arguments`). mypy needs
  1.11+ for `-O json`. go `-o /dev/null`, bun `--reporter-outfile=/dev/stdout` and the clang link output are
  Unix-only paths.
- The full regression run once hit a timing flake in `test/server/httpapi-v2-pty.test.ts` (PTY exit not seen in 20 s)
  while other heavy processes were running; it passes alone and in a quiet full run.
