# Spicy IDE master plan

OpenCode Spicy Edition becomes one agent-native IDE with three systems that share state:

1. **Debug Workbench**: problems, native verification, Debug Adapter Protocol (DAP) debugging, console, investigations.
2. **Agent HQ**: named agent characters backed by OpenCode, Claude Code, Codex or Cursor sessions.
3. **Orchestration**: tasks, dependencies, isolated worktrees, agent messaging, supervision, recovery.

The detailed design, measurements and full test catalogue are in the plan page
(<https://claude.ai/artifact/F3YkpAQ2aCwJwRHFyuwbyN>, revision 2). This file is the in-repo source of truth for
interfaces, ownership and rules. Progress lives in [SPICY_IDE_PROGRESS.md](SPICY_IDE_PROGRESS.md). Every edit to an
upstream-owned file is listed in [../SPICY.md](../SPICY.md).

## Ground truth (measured 2026-10-11 on the owner's Mac)

- Fork base: upstream `anomalyco/opencode` v1.18.35 at `ecc4916b5`. Integration branch: `spicy-ide`.
- LSP is opt-in (`lsp/lsp.ts:151`). With `"lsp": true`: C and TypeScript return diagnostics; Swift returns an empty
  list (opencode client bug, sourcekit-lsp itself works); Rust hangs 45.7 s on a rustup stub; Python and Go have no
  server installed.
- Native checkers all work and are fast on small inputs: clang (SARIF), tsc (text), swiftc/swift build (text),
  cargo (JSON), ruff (JSON), mypy (JSON), go build `-json`, go vet. A declared-but-undefined C function passes
  `-fsyntax-only` and fails at link.
- DAP: debugpy 1.8.20 (inside VS Code's `ms-python.debugpy` extension) runs the full loop: conditional breakpoint,
  locals, evaluate, completions, stdout output events, uncaught exception with `exceptionInfo`. lldb-dap (Xcode,
  LLVM 21) answers `initialize`; launching needs macOS Developer Mode, which is off. js-debug (standalone) and Delve
  are not installed.
- C and Swift lose pre-crash stdout through a pipe and keep it under a PTY, so debuggee I/O runs in opencode's PTY
  service via DAP `runInTerminal`.
- Provider CLIs: `claude` 2.1.296 present; `cursor-agent` 2025.09.12 present but has no ACP mode (its headless mode
  runs every tool without approval, so it is not used); `codex` not installed.
- `/usr/local/bin/python3` is a dead x86_64 binary first on PATH. Interpreter lookup must run candidates.

## Architecture

```text
Producers                       Workbench (opencode server, per instance)        Consumers
LSP clients ──────────────┐     ┌──────────────────────────────┐
Check / test runner ──────┼────▶│ Problem store (slices)       │──▶ agent tools: check, debug
DAP sessions (PTY I/O) ───┘     │ Investigations + evidence    │──▶ HTTP + events ──▶ app panels
                                │ Supervisor rules (pure)      │──▶ MCP bridge ──▶ external agents
Agent HQ providers ────────────▶│ Agent registry + sessions    │
(opencode, claude, cursor, codex)└──────────────────────────────┘
```

One debugger, one verification engine, one orchestrator, many providers. External agents reach the Workbench
through an MCP bridge; nobody implements a second debugger.

## Shared contracts (do not fork these)

- `packages/schema/src/workbench.ts`: `Problem`, `ProblemsSnapshot`, `RunInfo`, `VerificationReport`,
  `StopSnapshot`, `DebugSessionInfo`, `ConsoleRow`, `Evidence`, `InvestigationSummary`, `RecoveryPolicy`, IDs
  (`run_`, `ev_`, `inv_`, `dbg_`) and events `workbench.*`.
- `packages/schema/src/agent-hq.ts`: `ProviderStatus`, `ProviderCapabilities`, `AgentIdentity`, `AgentSessionInfo`,
  normalized `AgentEvent` + `AgentEventEnvelope`, IDs (`agt_`, `ags_`) and events `agenthq.*`.
- Both event sets are registered in `featureDefinitions` (`packages/schema/src/event-manifest.ts`), so they reach
  `ServerDefinitions` and the client manifest. Publish them through the instance event bridge so they carry
  `location.directory` (the app drops directory events without it).
- Changing a contract: edit the schema file on `spicy-ide` first, then rebase feature branches. Additive changes
  only once the UI consumes a field.

### HTTP routes (instance-scoped, new route groups)

Workbench (`WorkbenchApi`, owner: problems agent; debug group owner: dap agent):

| Method | Path | Returns |
|---|---|---|
| GET | `/workbench/problems` (query: severity, source, file) | `ProblemsSnapshot` |
| GET | `/workbench/doctor` | doctor report (languages × LSP/check/test/debug) |
| POST | `/workbench/check` `{ files?, units? }` | `VerificationReport` |
| GET | `/workbench/runs/:runID` | `RunInfo` + capped output |
| GET/POST | `/workbench/debug/sessions` | list / start (`DebugSessionInfo`) |
| POST | `/workbench/debug/sessions/:id/control` `{ action }` | `DebugSessionInfo` |
| POST | `/workbench/debug/sessions/:id/breakpoints` | verified breakpoints |
| GET | `/workbench/debug/sessions/:id/variables?ref=` | `VariableView[]` |
| POST | `/workbench/debug/sessions/:id/evaluate` `{ expression, frameID? }` | `ConsoleRow` |
| GET | `/workbench/debug/sessions/:id/completions?text=&column=` | completion items |
| POST | `/workbench/debug/sessions/:id/owner` `{ owner }` | `DebugSessionInfo` |
| DELETE | `/workbench/debug/sessions/:id` | stops and kills the tree |
| GET | `/workbench/investigations`, `/workbench/investigations/:id` | summaries / full record |
| POST | `/workbench/investigations/:id/resume`, `/cancel` | summary |

Agent HQ (`AgentHQApi`, owner: agenthq agent):

| Method | Path | Returns |
|---|---|---|
| GET | `/agenthq/providers` | `ProviderStatus[]` |
| GET/POST | `/agenthq/agents` | `AgentIdentity[]` / created identity |
| PATCH/DELETE | `/agenthq/agents/:agentID` | identity / removal |
| GET/POST | `/agenthq/agents/:agentID/sessions` | `AgentSessionInfo[]` / started session |
| GET | `/agenthq/sessions/:sessionID` | info + history (`AgentEventEnvelope[]`) |
| POST | `/agenthq/sessions/:sessionID/messages` `{ text }` | accepted |
| POST | `/agenthq/sessions/:sessionID/cancel` | info |
| POST | `/agenthq/sessions/:sessionID/permissions/:requestID` `{ optionID }` | accepted |

### Internal interfaces

- **LSP diagnostics hook** (problems agent adds it): `LSP.Service` exposes a subscription that reports
  `{ serverID, root, file, diagnostics, at }` whenever a push or pull result replaces a file's list. The problem
  store's `lsp-source` consumes it.
- **AgentProvider** (agenthq agent, `packages/opencode/src/agenthq/provider.ts`): `status()`, `createSession()`,
  optional `resumeSession()`, `send()`, `cancel()`, optional `respondPermission()`, `close()`. Events are emitted as
  normalized `AgentEvent`s through a callback; the session manager assigns `seq`, persists and publishes. Adapters
  report capabilities honestly; unsupported actions return a typed error, never a silent no-op.
- **Workbench MCP bridge** (later wave): a stdio MCP server (`opencode workbench mcp`) that proxies `problems`,
  `check`, and `debug` to the running instance's routes, so Claude Code, Codex and Cursor sessions get the same
  tools. Permission asks still route to the human.

## Persistence

- Agent identities, agent session records, investigations and evidence use opencode's JSON record store
  (`opencode/src/storage/storage.ts`, keyed paths with per-key locks). No new SQLite tables: a fresh install builds
  the generated schema and marks all migrations done (`core/src/database/migration.ts:18-41`), so fork tables would
  conflict with upstream.
- Keys: `["agenthq","agent",id]`, `["agenthq","session",agentSessionID]`, `["agenthq","events",agentSessionID]`
  (capped history), `["workbench","investigation",projectID,id]`, `["workbench","evidence",id]`.
- Never store provider credentials or raw environment variables. Evidence copies bounded, redacted excerpts
  (tool-output files expire after 7 days).

## Rules for every implementer

1. Follow the root `AGENTS.md` and `packages/opencode/AGENTS.md` (Effect services, `InstanceState`, no namespaces,
   no star or aliased imports, no mocks where real code can run, run tests and typecheck from package dirs).
2. Work only in your own worktree and branch. Touch upstream-owned files only where your ownership row in
   [SPICY_IDE_PROGRESS.md](SPICY_IDE_PROGRESS.md) allows, mark each edit with a `spicy:` comment, and add it to
   `SPICY.md`.
3. No new dependencies, network installs or global tool installs without the coordinator. Pin anything added.
4. Dev runs use isolated `XDG_*_HOME` dirs. The owner's installed opencode is v2.0.24; a dev build must never
   migrate their real data directory.
5. Never auto-approve execution, file mutation or debugger access. New permission keys have explicit defaults in
   `agent/agent.ts` (`verify.exec`, `debug.*` ask; `debug.memory` deny).
6. Tests must not need a paid model: use `opencode/test/lib/llm-server.ts` or recorded cassettes. Real-provider
   tests are opt-in and skip with a stated reason.
7. A skipped, timed-out, unavailable or cancelled check is never a pass. Report blocked work as blocked.
8. Commit with conventional messages (`feat(opencode): …`). Do not push, merge into `dev`, or publish.

## Phases and ownership

| Wave | Branch / worktree | Scope | Test IDs |
|---|---|---|---|
| 1 | `spicy-lsp` | P0: LSP repairs (REG-01..10), fast-fail and restart, roots, agent report format, doctor | DIAG-05..13, REG-* |
| 1 | `spicy-problems` | P1 problem store + LSP hook + events + `WorkbenchApi`; then P2 checkers, `check` tool, turn-end gate | DIAG-01..04, VER-* |
| 1 | `spicy-dap` | P4 DAP core, debugpy + lldb-dap, console service, runInTerminal → PTY, `debug` tool, debug routes; then P5 investigations, supervisor, control | DAP-*, CON-02/06-08/10, INV-*, CTL-01..05 |
| 1 | `spicy-agenthq` | Agent HQ backend: registry, OpenCode adapter, sessions, events, `AgentHQApi`, recovery; then Cursor (ACP), Claude Code, Codex adapters | AHQ-* |
| 1 | `spicy-ui` | Bottom panel tabs (Agents, Problems, Output, Debug Console, Run), Agents roster + workspace, workbench context | UI-*, CON-01/03-05/09/11/12 |
| 2 | (continuations) | Debug UI (gutter, debug panel), MCP bridge, external providers, verification UI | DAP/CON/UI |
| 3 | (continuations) | Orchestration: tasks, dependency graph, worktrees, messaging, team view; activity/evidence view; editable editor (CodeMirror evaluation) | ORC-*, UI-06 |

Agent HQ test IDs (added to the plan's catalogue):

| ID | Scenario | Expected |
|---|---|---|
| AHQ-01 | Create, rename, change avatar, delete an identity | Persisted in the JSON store; events published |
| AHQ-02 | Two identities on the same provider | Independent sessions and histories |
| AHQ-03 | OpenCode session: send message (fake model) | Streamed deltas, tool events, completion, history persisted |
| AHQ-04 | Permission request from the provider | Surfaces as `permission.requested`; nothing proceeds until answered |
| AHQ-05 | Cancel a running turn | Status `cancelled`, provider process tree gone |
| AHQ-06 | Server restart mid-session | Session `interrupted` with history intact; resume only where the provider supports it |
| AHQ-07 | Provider binary missing or unauthenticated | `ProviderStatus.available=false` or `auth="required"` with a reason; no crash |
| AHQ-08 | ACP adapter against `opencode acp` | Real ACP session: prompt, stream, permission, cancel |
| AHQ-09 | Claude Code adapter | Real session when `claude` is authenticated (opt-in), contract test otherwise |
| AHQ-10 | Duplicate subscriptions | One event stream per session; reconnect resumes from `seq` |

## Decisions log

- Store records in the JSON store, not new tables (upstream conflict risk).
- Program I/O under the debugger runs in the existing PTY service (crash output survives).
- The console REPL is a list plus input, not a terminal.
- Turn-end gate default `fix`, capped at 2 automatic repairs by the supervisor.
- Supervisor is deterministic rules (S1–S8), not a model.
- Cursor via ACP only (no headless auto-approve mode). Codex adapter is blocked until `codex` is installed.
- Read-only viewer with a gutter first; an editable editor (CodeMirror 6 vs Monaco) is evaluated in wave 3 and only
  replaces the viewer after it passes tests.
