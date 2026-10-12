# Spicy IDE progress

Status levels, in order: **planned → implemented → unit-tested → integration-tested → e2e-verified**, or
**blocked** (with the reason). A level is only claimed with evidence (test file and command, or a recorded run).
Skipped tests never count. Update this file in the same commit as the work it describes.

Plan: [SPICY_IDE_MASTER_PLAN.md](SPICY_IDE_MASTER_PLAN.md). Upstream edits: [../SPICY.md](../SPICY.md).

## Foundation

| Item | Status | Evidence |
|---|---|---|
| Shared contracts (`schema/src/workbench.ts`, `schema/src/agent-hq.ts`) registered in the event manifest | integration-tested | schema + opencode typecheck clean; `bun test test/lsp test/server` 358 pass |
| Permission defaults (`verify.exec`, `debug.*` ask, `debug.memory` deny) | implemented | `opencode/src/agent/agent.ts` |

## Debug Workbench

| Item | Owner branch | Status | Evidence |
|---|---|---|---|
| P0 LSP repairs + doctor | `spicy-lsp` | integration-tested (merged `fbef6f2ed`) | REG-01..10 + DIAG-10 fixed; Swift returns its error via `opencode debug lsp diagnostics` (was `[]`); dead servers fail in ~1 s (was 45.7 s); `opencode debug workbench doctor`; `bun test test/lsp test/workbench test/tool test/agent` 475 pass; real sourcekit test passes. Notes: `docs/spicy/notes-lsp.md` |
| P1 Problem store, LSP hook, events, routes | `spicy-problems` | integration-tested (merged `f8c5092c5`) | `GET /workbench/problems`; `workbench.problems.updated` via EventV2Bridge; DIAG-01..04 pass. Notes: `docs/spicy/notes-problems.md` |
| P2 Verification engine, `check` tool, turn-end gate | `spicy-problems` | integration-tested (merged `f8c5092c5`) | Checkers tsc/clang/swift/cargo/go/ruff/mypy with golden captures; test runners go/cargo/bun/node; gate (max 2 repairs, env `OPENCODE_VERIFY_GATE`); VER-01..06, 08..13 pass. Missing: `POST /workbench/check`, `GET /workbench/runs/:id`, pytest/swift test (VER-14), VER-07 |
| P3 Problems + Output tabs | `spicy-ui` | planned | |
| P4 DAP core, adapters, console backend, `debug` tool | `spicy-dap` | planned | |
| P5 Investigations, supervisor, control ownership | `spicy-dap` | planned | |
| P6 Debug UI, Debug Console, Run tabs | `spicy-ui` | planned | |
| P7 Activity and evidence view | `spicy-ui` | planned | |
| Workbench MCP bridge | wave 2 | planned | |

## Agent HQ

| Item | Owner branch | Status | Evidence |
|---|---|---|---|
| Registry + identities + persistence | `spicy-agenthq` | integration-tested (merged `2867de790`) | JSON store, schema-validated, events; AHQ-01/02 pass |
| OpenCode provider adapter | `spicy-agenthq` | integration-tested (fake model) | Runs in the identity's project instance; allow→ask for non-read-only tools; AHQ-03/04/05 pass |
| Session manager, events, recovery | `spicy-agenthq` | integration-tested | Gap-free seq, compacted capped history, interrupted on restart; AHQ-06/07/10 pass |
| `AgentHQApi` routes | `spicy-agenthq` | integration-tested | 11 routes; `test:httpapi` 220/220 after merge |
| Agents tab: roster, create/edit, workspace, permissions, cancel | `spicy-ui` | planned | |
| Cursor adapter (ACP) | wave 2 | blocked for real Cursor: installed `cursor-agent` 2025.09.12 has no ACP mode; testable against `opencode acp` | |
| Claude Code adapter | wave 2 | planned (needs `@anthropic-ai/claude-agent-sdk`) | |
| Codex adapter | wave 2 | blocked: `codex` not installed | |

Merged tree (`f8c5092c5`): `bun test test/lsp test/workbench test/agenthq test/tool test/session test/server test/agent` 1244 pass, 9 skip (pre-existing), 1 todo, 0 fail; `test:httpapi` 220/220; typecheck clean.

## Orchestration and IDE polish

| Item | Status | Evidence |
|---|---|---|
| Tasks, dependency graph, worktrees, messaging | planned | |
| Team view | planned | |
| Editable editor (CodeMirror 6 vs Monaco evaluation) | planned | |

## Environment blockers (owner action)

- macOS Developer Mode off: lldb-dap cannot launch (Swift/C/C++/Rust debugging, E2E-02/03, DAP-18).
- `rust-analyzer` component missing (`rustup component add rust-analyzer`).
- `codex` not installed; `cursor-agent` needs an update for ACP.
- gopls, Delve, pyright, typescript-language-server (global) not installed. pytest exists as a CLI (8.3.4 on PATH, 9.0.2 in /opt/homebrew/bin) but is not importable by Homebrew python3.
