# Spicy IDE progress

Status levels, in order: **planned → implemented → unit-tested → integration-tested → e2e-verified**, or
**blocked** (with the reason). A level is only claimed with evidence (test file and command, or a recorded run).
Skipped tests never count. Update this file in the same commit as the work it describes.

Plan: [SPICY_IDE_MASTER_PLAN.md](SPICY_IDE_MASTER_PLAN.md). Upstream edits: [../SPICY.md](../SPICY.md).

## Foundation

| Item | Status | Evidence |
|---|---|---|
| Shared contracts (`schema/src/{workbench,agent-hq,review}.ts`) registered in the event manifest | integration-tested | schema + opencode typecheck clean; `bun test test/lsp test/server` 358 pass |
| Permission defaults (`verify.exec`, `debug.*` ask, `debug.memory` deny) | implemented | `opencode/src/agent/agent.ts` |

## Debug Workbench

| Item | Owner branch | Status | Evidence |
|---|---|---|---|
| P0 LSP repairs + doctor | `spicy-lsp` | integration-tested (merged `fbef6f2ed`) | REG-01..10 + DIAG-10 fixed; Swift returns its error via `opencode debug lsp diagnostics` (was `[]`); dead servers fail in ~1 s (was 45.7 s); `opencode debug workbench doctor`; `bun test test/lsp test/workbench test/tool test/agent` 475 pass; real sourcekit test passes. Notes: `docs/spicy/notes-lsp.md` |
| P1 Problem store, LSP hook, events, routes | `spicy-problems` | integration-tested (merged `f8c5092c5`) | `GET /workbench/problems`; `workbench.problems.updated` via EventV2Bridge; DIAG-01..04 pass. Notes: `docs/spicy/notes-problems.md` |
| P2 Verification engine, `check` tool, turn-end gate | `spicy-problems` | integration-tested (merged `f8c5092c5`) | Checkers tsc/clang/swift/cargo/go/ruff/mypy with golden captures; test runners go/cargo/bun/node; gate (max 2 repairs, env `OPENCODE_VERIFY_GATE`); VER-01..06, 08..13 pass. Wave 2 (merged `a59ae5c26`): `POST /workbench/check`, `GET /workbench/runs`, `/runs/:id`, `/doctor`; pytest JUnit + swift test xUnit runners with real goldens (VER-14). Wave 3: VER-07 repo-defined check commands (`workbench.checks` in config; always `verify.exec`; IDE-triggered runs only on the user's click; never on config load), `test/workbench/repo-checks.test.ts` 8 pass |
| P3 Problems + Output tabs | `spicy-ui` | integration-tested against a real server with a stub model (merged `5079914f0`) | Problems: grouped, filtered, stale badge, click → file line. Output: runs from events + `GET /workbench/runs`, ANSI colors, clickable `path:line`, "Run checks". Agents: Markdown messages, cross-project events, persisted unviewed state. E2E 22/22 |
| P4 DAP core, adapters, console backend, `debug` tool | `spicy-dap` | integration-tested (merged `f1a10267c`); lldb-dap launch blocked (Developer Mode off) | debugpy full loop; capability gating; limits; process-tree cleanup; runInTerminal → PTY; debug routes; DAP-01..16, CON-02/04/06/08, CTL-01..05, SEC-02/03/07 pass; DAP-18 skipped with reason. Notes: `docs/spicy/notes-dap.md` |
| P5 Investigations, supervisor, control ownership | `spicy-dap` | integration-tested (merged `f1a10267c`) | JSON-store records, transition table, supervisor S1–S8 (pure), recovery kills only pid+start-time matches; INV-01/02/04–14 pass. Verification runs (check tool, gate) recorded on investigations; S1/S2/S4 fire on real runs and stop the gate (merged `0cbfb1838`). Rust lldb-dap preset + formatters ready (launch blocked: Developer Mode). Boot-time recovery at server start (wave 3): orphaned active investigations → `interrupted`, processes killed only on pid + start-time match; `investigation/boot.test.ts` |
| P6 Debug UI, Debug Console, Run tabs | `spicy-ui` | integration-tested (merged `f26a3c090`; real debugpy session through Playwright Chromium against an isolated server) | Debug side tab (toolbar, owner chip + Take over, stack, lazy variables, watches, breakpoints with conditions/hit counts/log points, launch.json start), Debug Console (backlog + live merge, filters, evaluate, completions, history), Run tab (program PTY, exit code), gutter marks + F5/F9/F10/F11 keys; e2e `debug-panel.spec.ts` 4/4, app unit 107 pass with the JSX override. Gaps: variables for the top frame only, no gutter click-to-toggle (line click opens upstream comments), legacy side panel has no Debug tab |
| P7 Activity and evidence view | `spicy-ui` | planned | |
| Workbench MCP bridge | `spicy-problems` | integration-tested (merged `a59ae5c26`) | `opencode workbench mcp`: stdio MCP server proxying to a running opencode server; tools `workbench_problems`, `workbench_check` (agent trigger runs exec units only when `verify.exec` allows), `workbench_doctor`; credentials only from `OPENCODE_SERVER_USERNAME/PASSWORD`. Wave 3 (merged `8e3710b48`): 12 `debug_<action>` tools with the in-process `debug` tool's schemas, via `POST /workbench/debug/agent` (runs the real `DebugTool` as that session's agent: same ownership, investigations, `debug.*` asks, `debug.memory` deny; a rejected ask → 403 + S7 `needs_human`); `test/workbench/mcp-debug.test.ts` 3 pass against real debugpy |

## Agent HQ

| Item | Owner branch | Status | Evidence |
|---|---|---|---|
| Registry + identities + persistence | `spicy-agenthq` | integration-tested (merged `2867de790`) | JSON store, schema-validated, events; AHQ-01/02 pass |
| OpenCode provider adapter | `spicy-agenthq` | integration-tested (fake model) | Runs in the identity's project instance; allow→ask for non-read-only tools; AHQ-03/04/05 pass |
| Session manager, events, recovery | `spicy-agenthq` | integration-tested | Gap-free seq, compacted capped history, interrupted on restart; AHQ-06/07/10 pass |
| `AgentHQApi` routes | `spicy-agenthq` | integration-tested | 11 routes; `test:httpapi` 220/220 after merge |
| Agents tab: roster, create/edit, workspace, permissions, cancel | `spicy-ui` | unit-tested + mock e2e (8/8); contract fixed to real routes `3a601fc50`; real-app e2e pending (desktop harness) | app `test:unit` 487 pass / 23 fail, the same 23 fail on the base (bun 1.4.3 vs pinned 1.3.14 `jsxDEV`) |
| Generic ACP adapter (Cursor, AgentKit, any ACP agent) | `spicy-agenthq` | integration-tested (merged `7ba49ff50`) | AHQ-08: real `opencode acp` from this tree driven over HTTP (stream, `bash` permission allow/reject, cancel, process gone on delete); AHQ-08b scripted agent (plan, reasoning, diff → `file.changed`, crash → `disconnected`, reattach via `session/load`). Real Cursor blocked: installed `cursor-agent` 2025.09.12 has no ACP mode |
| Claude Code adapter | `spicy-agenthq` | e2e-verified once (merged `7ba49ff50`) | `@anthropic-ai/claude-agent-sdk` 0.3.293 (owner-approved); AHQ-09 scripted SDK: isolation (`settingSources: []`, `strictMcpConfig`, `permissionMode: "default"`, no bypass flag), prompts park until answered, cancel, crash, resume. One real opt-in session (`SPICY_REAL_CLAUDE=1`): reply `pong`, 3.07 s, $0.0032092 |
| Codex adapter | wave 2 | blocked: `codex` not installed | |

Merged tree (`a8a04a2b7`, all wave 2 branches): `bun test` in packages/opencode 3819 pass, 25 skip, 1 todo, 0 fail (285 files, 336 s); `test:httpapi` 255/255; desktop 75 pass; app typecheck clean, app `test:unit` 498 pass / 23 fail (the same pre-existing `jsxDEV` failures); schema 13 pass / 2 fail (pre-existing on `dev`); no new crash reports. Merged tree (`0cbfb1838`): 1320 pass, 11 skip (9 pre-existing + DAP-18 C/Rust), 1 todo, 0 fail; no new crash reports. Earlier merged tree (`f1a10267c`, after P4/P5): 1309 pass, 10 skip (9 pre-existing + DAP-18), 1 todo; one PTY test flaky under parallel load (passes alone, also on `dev`); `test:httpapi` 234/234. Earlier merged tree (`f8c5092c5`): `bun test test/lsp test/workbench test/agenthq test/tool test/session test/server test/agent` 1244 pass, 9 skip (pre-existing), 1 todo, 0 fail; `test:httpapi` 220/220; typecheck clean.

## Orchestration and IDE polish

| Item | Status | Evidence |
|---|---|---|
| Tasks, dependency graph, worktrees, messaging | integration-tested (`spicy-agenthq`, merged `7ba49ff50`). Owner decision 2026-10-12: the IDE owns orchestration; AgentKit is a provider, never the task engine (avoids a circular dependency) | `test/agenthq/orchestrator.test.ts` (fake model): dependency ordering, cycle rejection, isolated worktrees per task, review gate (approve merges, conflicts refused and aborted), hop limit, cancellation. UI (tasks/team view): planned |
| AgentKit provider | planned: preferably through the generic ACP adapter once AgentKit exposes ACP | |
| Change review (Cursor-style accept/reject per hunk/file) | backend integration-tested (`spicy-review`, merged `a8cb5f748`); UI planned | REV-01..07: real sessions + fake model through the routes: hunk/file/all accept/reject, undo, 409 when the human edited the lines or the agent is still editing, restart keeps changesets, external-provider turns (`file.changed`), forks not re-baselined |
| Desktop launch harness + packaged build + CDP smoke | e2e-verified (`spicy-desktop`, merged `a8a04a2b7`) | Packaged `--mac dir` build in 36 s with `Assets.car` from the Icon Composer icon; isolated launch (fake HOME + throwaway keychain, real keychain unchanged); smoke with a scripted model: Agents tab create → stream → cancel → reopen → quit mid-turn → restart recovers `interrupted`; built 31/31, dev 33/33. Notes: `docs/spicy/notes-desktop.md` |
| Team view | planned | |
| Editable editor (CodeMirror 6 vs Monaco evaluation) | planned | |

## Environment blockers (owner action)

- macOS Developer Mode off: lldb-dap cannot launch (Swift/C/C++/Rust debugging, E2E-02/03, DAP-18).
- `rust-analyzer` component missing (`rustup component add rust-analyzer`).
- `codex` not installed; `cursor-agent` needs an update for ACP.
- gopls, Delve, pyright, typescript-language-server (global) not installed. pytest exists as a CLI (8.3.4 on PATH, 9.0.2 in /opt/homebrew/bin) but is not importable by Homebrew python3.
