# SPICY.md: edits to upstream-owned files

OpenCode Spicy Edition keeps new code in new folders. Every change to a file that upstream (`anomalyco/opencode`)
also owns is listed here so upstream merges stay predictable. Each edit in the code carries a `spicy:` comment.

| File | Change | Why |
|---|---|---|
| `packages/schema/src/event-manifest.ts` | Import `Workbench`, `AgentHQ` and `Review`; add their `Event.Definitions` to `featureDefinitions` | Workbench, Agent HQ and review events reach the server and client manifests |
| `packages/core/src/v1/config/config.ts` | Optional `workbench` key (`ConfigWorkbenchV1`, new file `config/workbench.ts`) | Repository-defined check commands (VER-07); always exec-class, never run on load |
| `packages/opencode/src/agent/agent.ts` | Default permissions `verify.exec` ask, `debug.*` ask, `debug.memory` deny | The built-in `"*": "allow"` would otherwise allow these silently |
| `packages/opencode/src/lsp/client.ts` | Honor `workspace/diagnostic/refresh`, bounded warm-up for runtime-registered pull servers, process-exit detection, `processId` = opencode pid, diagnostics hook (`emitDiagnostics`) | REG-01/02/09/10; Workbench problem store |
| `packages/opencode/src/lsp/lsp.ts` | `broken` keeps reason + retry backoff, crash watcher, `status()` reports `"error"`, `diagnosticEvents()` subscription | REG-02/09; problem store |
| `packages/opencode/src/lsp/server.ts` | Strict gopls root, `*`-prefixed markers match by suffix, sourcekit `.m`/`.mm` only inside Swift/Xcode projects, TS/biome respect `OPENCODE_DISABLE_LSP_DOWNLOAD` | REG-03..06 |
| `packages/opencode/src/lsp/diagnostic.ts` | Report lines include source and code, plus a warnings count | DIAG-10 |
| `packages/opencode/src/tool/{edit,write,apply_patch}.ts` | Metadata keeps touched files' diagnostics plus counts, not the workspace map | REG-08 |
| `packages/opencode/src/tool/registry.ts` | Register the `check` tool | Verification engine |
| `packages/opencode/src/session/prompt.ts` | Turn-end verification gate at the loop exit | P2 gate (`OPENCODE_VERIFY_GATE=off\|report-only\|fix`) |
| `packages/opencode/src/cli/cmd/debug/index.ts` | `debug workbench` subcommand | Doctor |
| `packages/opencode/src/server/routes/instance/httpapi/{api,server}.ts` | Compose `AgentHQApi`, `WorkbenchApi`, `WorkbenchDebugApi`, `ReviewApi`; provide their handlers and services (Agent HQ orchestrator, verification runs, review store) | New route groups |
| `packages/opencode/src/index.ts` | Register `WorkbenchCommand` (`opencode workbench mcp`) | Workbench MCP bridge for agents outside opencode |
| `packages/opencode/package.json`, `bun.lock` | Add `@anthropic-ai/claude-agent-sdk` pinned to `0.3.293` | Claude Code provider adapter (approved by the owner 2026-10-11) |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | Register Agent HQ, Workbench, debug and review route scenarios | `test:httpapi --fail-on-missing` covers every route |
| `packages/opencode/test/event-manifest.test.ts` | Expected size is upstream 88 + the fork's event definitions | Fork events sit on top of upstream's count |
| `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap` | `opencode debug workbench` line in the `debug --help` snapshot | Doctor subcommand |
| `packages/opencode/test/lsp/{client,index}.test.ts`, `test/fixture/lsp/fake-lsp-server.js` | `refreshSupport` now true; fake server variants for the sourcekit pattern and dying servers | REG tests |
| `packages/opencode/test/session/{prompt,snapshot-tool-race}.test.ts`, `test/tool/lsp.test.ts` | LSP stubs gain `diagnosticEvents: () => Stream.empty` | Interface grew a method |
| `packages/app/src/app.tsx` | `FileComponentProvider` gets the fork's `DebugFile` (session-ui `File` plus debugger gutter marks) | Breakpoints, paused line and values in the file viewer |
| `packages/app/src/context/command.tsx` | `EDITABLE_KEYBIND_IDS` also spreads `SPICY_EDITABLE_KEYBIND_IDS` from `workbench/keys.ts` | Fork keys (F5, F9, F10, …) fire while typing; new fork keys only edit `keys.ts` |
| `packages/app/src/pages/session/session-side-panel.tsx` | Debug tab trigger and content in the side panel tabs | Debugger side panel (v2 layout) |
| `packages/app/src/context/language.tsx` | Merge the fork's English `workbench/en` dictionary into the base dictionary | Workbench strings; other locales fall back to English |
| `packages/app/src/pages/session.tsx` | Wrap the session children in `WorkbenchProviders` | Workbench and Agent HQ state for the bottom panel |
| `packages/app/src/pages/session/terminal-panel-v2.tsx` | Workbench tab triggers and content share the terminal tab bar; a selected Workbench tab replaces the terminal view | Agents, Problems, Output, Debug Console, Run tabs |
| `packages/desktop/src/main/index.ts` | Keep a `--remote-debugging-port` given on the command line; skip `setAsDefaultProtocolClient` when `CFFIXED_USER_HOME` is set | Isolated launches (`scripts/spicy-launch.ts`) must not take over the system opencode:// handler |
| `packages/desktop/src/main/windows.ts` | Log whether the Dock icon loaded | Smoke verifies the dev Dock icon |
| `packages/desktop/electron-builder.config.ts` | `mac.icon` → `resources/icons/AppIcon.icon` | Native Liquid Glass app icon (Icon Composer); needs Xcode 26+ `actool` at build time |
| `packages/desktop/icons/{dev,beta,prod}/*` | Replaced `icon.icns`, `icon.ico`, `icon.png`, `dock.png`, sized PNGs; added `AppIcon.icon` | Spicy app icon, generated by `scripts/spicy-icons.ts` from `icons/AppIcon.icon` |
| `packages/desktop/icons/README.md` | Prepended the Spicy icon workflow | Documents the generator |

New files owned by the fork (no upstream conflict): `packages/schema/src/{workbench,agent-hq,review}.ts`, `packages/opencode/src/workbench/**`, `packages/opencode/src/agenthq/**`,
`packages/opencode/src/review/**`, `packages/opencode/src/cli/cmd/workbench.ts`, `packages/app/src/workbench/**`,
`packages/app/src/agenthq/**`, `packages/desktop/scripts/spicy-*.ts`, `docs/SPICY_IDE_*.md`, `docs/spicy/**`, `SPICY.md`.
