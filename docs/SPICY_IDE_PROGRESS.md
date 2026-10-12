# Spicy IDE progress

Status levels, in order: **planned → implemented → unit-tested → integration-tested → e2e-verified**, or
**blocked** (with the reason). A level is only claimed with evidence (test file and command, or a recorded run).
Skipped tests never count. Update this file in the same commit as the work it describes.

Plan: [SPICY_IDE_MASTER_PLAN.md](SPICY_IDE_MASTER_PLAN.md). Upstream edits: [../SPICY.md](../SPICY.md).

## Foundation

| Item | Status | Evidence |
|---|---|---|
| Shared contracts (`schema/src/workbench.ts`, `schema/src/agent-hq.ts`) registered in the event manifest | implemented | schema + opencode typecheck clean; `bun test test/lsp test/server` 358 pass |
| Permission defaults (`verify.exec`, `debug.*` ask, `debug.memory` deny) | implemented | `opencode/src/agent/agent.ts` |

## Debug Workbench

| Item | Owner branch | Status | Evidence |
|---|---|---|---|
| P0 LSP repairs + doctor | `spicy-lsp` | planned | |
| P1 Problem store, LSP hook, events, routes | `spicy-problems` | planned | |
| P2 Verification engine, `check` tool, turn-end gate | `spicy-problems` | planned | |
| P3 Problems + Output tabs | `spicy-ui` | planned | |
| P4 DAP core, adapters, console backend, `debug` tool | `spicy-dap` | planned | |
| P5 Investigations, supervisor, control ownership | `spicy-dap` | planned | |
| P6 Debug UI, Debug Console, Run tabs | `spicy-ui` | planned | |
| P7 Activity and evidence view | `spicy-ui` | planned | |
| Workbench MCP bridge | wave 2 | planned | |

## Agent HQ

| Item | Owner branch | Status | Evidence |
|---|---|---|---|
| Registry + identities + persistence | `spicy-agenthq` | planned | |
| OpenCode provider adapter | `spicy-agenthq` | planned | |
| Session manager, events, recovery | `spicy-agenthq` | planned | |
| `AgentHQApi` routes | `spicy-agenthq` | planned | |
| Agents tab: roster, create/edit, workspace, permissions, cancel | `spicy-ui` | planned | |
| Cursor adapter (ACP) | wave 2 | blocked for real Cursor: installed `cursor-agent` 2025.09.12 has no ACP mode; testable against `opencode acp` | |
| Claude Code adapter | wave 2 | planned (needs `@anthropic-ai/claude-agent-sdk`) | |
| Codex adapter | wave 2 | blocked: `codex` not installed | |

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
- pytest, gopls, Delve, pyright not installed.
