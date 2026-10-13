# SPICY.md: edits to upstream-owned files

OpenCode Spicy Edition keeps new code in new folders. Every change to a file that upstream (`anomalyco/opencode`)
also owns is listed here so upstream merges stay predictable. Each edit in the code carries a `spicy:` comment.

| File | Change | Why |
|---|---|---|
| `packages/schema/src/event-manifest.ts` | Import `Workbench`, `AgentHQ` and `Review`; add their `Event.Definitions` to `featureDefinitions` | Workbench, Agent HQ and review events reach the server and client manifests |
| `packages/core/src/v1/config/config.ts` | Optional `workbench` key (`ConfigWorkbenchV1`, new file `config/workbench.ts`) | Repository-defined check commands (VER-07); always exec-class, never run on load |
| `packages/core/src/pty.ts` | `Pty.create` accepts an optional `omit` list of environment variables | Debugged programs in a terminal don't inherit the server's credentials (PTY env can't unset with `undefined`) |
| `packages/opencode/src/agent/agent.ts` | Default permissions `verify.exec` ask, `debug.*` ask, `debug.memory` deny, `custom_*` ask (after `"*": "allow"`) | The built-in `"*": "allow"` would otherwise allow these silently |
| `packages/opencode/src/lsp/client.ts` | Honor `workspace/diagnostic/refresh`, bounded warm-up for runtime-registered pull servers, process-exit detection, `processId` = opencode pid, diagnostics hook (`emitDiagnostics`: the push and pull lists, plus the exit reason once the server died) | REG-01/02/09/10; Workbench problem store (DIAG-01 both channels listed, DIAG-07 stale after a crash) |
| `packages/opencode/src/lsp/lsp.ts` | `broken` keeps reason + retry backoff, crash watcher, `status()` reports `"error"`, `diagnosticEvents()` subscription (a crashed server's replayed entry keeps its last report) | REG-02/09; problem store |
| `packages/opencode/src/lsp/server.ts` | Strict gopls root, `*`-prefixed markers match by suffix, sourcekit `.m`/`.mm` only inside Swift/Xcode projects, TS/biome respect `OPENCODE_DISABLE_LSP_DOWNLOAD` | REG-03..06 |
| `packages/opencode/src/lsp/diagnostic.ts` | Report lines include source and code, plus a warnings count | DIAG-10 |
| `packages/opencode/src/tool/{edit,write,apply_patch}.ts` | Metadata keeps touched files' diagnostics plus counts, not the workspace map | REG-08 |
| `packages/opencode/src/tool/registry.ts` | Register the `check`, `debug` and `tool_create` tools; `ToolRegistry.refresh()`; created `custom_*` tools imported fresh (`?v=<mtime>`), asked before every call, and skipped with a warning if they fail to load | Verification engine, debugger, tool creator |
| `packages/opencode/src/session/prompt.ts` | Turn-end verification gate at the loop exit | P2 gate (`OPENCODE_VERIFY_GATE=off\|report-only\|fix`) |
| `packages/opencode/src/cli/cmd/debug/index.ts` | `debug workbench` subcommand | Doctor |
| `packages/opencode/src/server/routes/instance/httpapi/{api,server}.ts` | Compose `AgentHQApi`, `WorkbenchApi`, `WorkbenchDebugApi`, `WorkbenchToolsApi`, `WorkbenchGitApi`, `ReviewApi`; provide their handlers and services (Agent HQ orchestrator, verification runs, git panel, review store) | New route groups |
| `packages/opencode/src/index.ts` | Register `WorkbenchCommand` (`opencode workbench mcp`) | Workbench MCP bridge for agents outside opencode |
| `packages/opencode/package.json`, `bun.lock` | Add `@anthropic-ai/claude-agent-sdk` pinned to `0.3.293` | Claude Code provider adapter (approved by the owner 2026-10-11) |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | Register Agent HQ, Workbench, debug, git panel and review route scenarios | `test:httpapi --fail-on-missing` covers every route |
| `packages/opencode/test/session/tools.test.ts` | Expectations include the fork's built-in tools | Tool creator / workbench tools registered |
| `packages/opencode/test/event-manifest.test.ts` | Expected size is upstream 88 + the fork's event definitions | Fork events sit on top of upstream's count |
| `packages/schema/test/event-manifest.test.ts` | Expected sizes are upstream's actual 58 server / 88 total / 35 durable plus the fork's events; every fork event must be the latest definition of its type; the `PartDelta, Diff, Error` slice moves from 40 to 43 | Upstream's expectations were already stale at the fork base (the three `session.next.revert.*` events), so both tests failed and checked none of the fork's events |
| `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap` | `opencode debug workbench` line in the `debug --help` snapshot | Doctor subcommand |
| `packages/opencode/test/lsp/{client,index}.test.ts`, `test/fixture/lsp/fake-lsp-server.js` | `refreshSupport` now true; fake server variants for the sourcekit pattern and dying servers | REG tests |
| `packages/opencode/test/session/{prompt,snapshot-tool-race}.test.ts`, `test/tool/lsp.test.ts` | LSP stubs gain `diagnosticEvents: () => Stream.empty` | Interface grew a method |
| `packages/app/src/app.tsx` | `FileComponentProvider` gets the fork's `DebugFile` (session-ui `File` plus debugger gutter marks) | Breakpoints, paused line and values in the file viewer |
| `packages/app/src/context/command.tsx` | `EDITABLE_KEYBIND_IDS` also spreads `SPICY_EDITABLE_KEYBIND_IDS` from `workbench/keys.ts` | Fork keys (F5, F9, F10, …) fire while typing; new fork keys only edit `keys.ts` |
| `packages/app/src/pages/session/session-side-panel.tsx` | Debug tab trigger and content in the side panel tabs | Debugger side panel (v2 layout) |
| `packages/app/src/context/language.tsx` | Merge the fork's English `workbench/en` dictionary into the base dictionary; `PluralKey` gains `workbench.git.unreviewed` | Workbench strings; other locales fall back to English; the git panel's count goes through `language.plural` |
| `packages/app/vite.config.ts` | `optimizeDeps.include` pre-bundles the Markdown renderer's packages | A cold dev server reloaded the page mid-test (Agent HQ e2e flake) |
| `packages/app/e2e/regression/{cross-server-tab-close,remote-tab-busy,remote-session-settings,tab-navigate-mousedown}.spec.ts` | Server A (the app's default server) from `PLAYWRIGHT_SERVER_HOST`/`PLAYWRIGHT_SERVER_PORT`, server B on that port + 1 (still 4096/4097 by default) | With any other `PLAYWRIGHT_SERVER_PORT` the app's default server sat on that port, every request to it was refused and the page crashed (6 of the e2e "baseline" failures) |
| `packages/ui/src/v2/components/menu-v2.tsx` | `MenuV2.Context.Trigger` wraps Kobalte's trigger: Shift+F10 prevents its default and dispatches `contextmenu` at the trigger | Kobalte opens context menus only on `contextmenu`; macOS browsers send none for Shift+F10 and Mac keyboards lack the menu key, so tab and terminal-tab menus had no keyboard access on Mac (`session-rename.spec.ts:98`) |
| `packages/app/src/i18n/desktop-native.{ts,test.ts}` | Locale matching treats the `Aran` script (Nastaliq) as `Arab`; test asserts `pa-Aran-PK` → `pa` | Apple's ICU (Safari, WebKit, bun on macOS) maximizes `pa-PK` to `pa-Aran-PK` where Chromium and Node say `pa-Arab-PK`, so Shahmukhi Punjabi fell back to English (the ICU "likely subtags" unit test) |
| `packages/app/happydom.ts` | The test preload registers a Bun plugin that prepends `/** @jsxImportSource solid-js/h */` to every `.tsx` and `.jsx` file it loads | `solid-js/jsx(-dev)-runtime` is a types-only entry with no `jsx`/`jsxDEV`; bun 1.4 refuses to link a module importing a missing export, so 22 app unit tests needed `--tsconfig-override` (builds compile JSX with babel-preset-solid and are unaffected) |
| `packages/app/src/pages/layout.tsx` | No "Go to session" toast for `debug.lldbCommand` asks | Their session id is synthetic, so the link would 404; the Debug Console shows the ask inline |
| `packages/app/src/pages/session.tsx` | Wrap the session children in `WorkbenchProviders`, `ReviewProvider` and `GitProvider`; an `agent` review mode (new layout only) that renders `ReviewChangesPanel`; `GitCommitArea` below the review panel (both layouts) | Workbench and Agent HQ state for the bottom panel; agent changes review; git panel commit area |
| `packages/app/src/context/layout.tsx` | `ReviewChangeMode` gains `agent` and persists it; `tabCloseGuards` hook in `close()` | Agent changes review mode; the editor asks Save / Don't save / Cancel before closing a dirty tab |
| `packages/app/src/pages/session/file-tabs.tsx` | `ReviewFileGate` wraps the loaded file render | Pending agent changes show inline with Accept / Reject |
| `packages/app/src/pages/session/terminal-panel-v2.tsx` | Workbench tab triggers and content share the terminal tab bar; a selected Workbench tab replaces the terminal view | Agents, Problems, Output, Debug Console, Run tabs |
| `packages/app/src/pages/session/session-sortable-tab-v2.tsx` | Unsaved-changes dot on the tab | Editor dirty state |
| `package.json` (root) | `overrides` pin `@lezer/lr` 1.4.10, `@lezer/css` 1.3.8, `@lezer/javascript` 1.5.5, `@lezer/markdown` 1.7.2 | CodeMirror's parsers had resolved to releases under two weeks old |
| `packages/app/package.json`, `bun.lock` | CodeMirror 6 packages (exact versions) | Editable editor |
| `packages/desktop/src/main/index.ts` | Keep a `--remote-debugging-port` given on the command line; skip `setAsDefaultProtocolClient` when `CFFIXED_USER_HOME` is set; the quit waits for the sidecar to stop in `will-quit` (bounded by the existing 6 s timeout), after windows had their chance to cancel | Isolated launches (`scripts/spicy-launch.ts`) must not take over the system opencode:// handler; quitting used to kill the sidecar before its shutdown ran, leaving Agent HQ sessions `working` and losing a history being written |
| `packages/desktop/src/main/windows.ts` | Log whether the Dock icon loaded; `will-prevent-unload` asks before a window with unsaved editor edits unloads (decision in the fork's `unsaved.ts`, test hook `OPENCODE_SPICY_UNSAVED_ANSWER`) | Smoke verifies the dev Dock icon; unsaved editor edits are never dropped silently |
| `packages/desktop/src/main/server.ts` | `createSidecarEnv()` adds `OPENCODE_BIN_PATH` (bundled CLI) via `bundledCliEnv` | The v1 sidecar runs under Node and needs a CLI to start the Workbench MCP bridge for Agent HQ agents |
| `packages/desktop/src/main/background-cli.ts` | Bundled CLI lookup moved to the fork's electron-free `bundled-cli.ts` and imported back | One lookup shared with the sidecar env (unit-testable without mocking electron) |
| `packages/desktop/electron-builder.config.ts` | `mac.icon` → `resources/icons/AppIcon.icon` | Native Liquid Glass app icon (Icon Composer); needs Xcode 26+ `actool` at build time |
| `packages/desktop/icons/{dev,beta,prod}/*` | Replaced `icon.icns`, `icon.ico`, `icon.png`, `dock.png`, sized PNGs; added `AppIcon.icon` | Spicy app icon, generated by `scripts/spicy-icons.ts` from `icons/AppIcon.icon` |
| `packages/desktop/icons/README.md` | Prepended the Spicy icon workflow | Documents the generator |

New files owned by the fork (no upstream conflict): `packages/schema/src/{workbench,workbench-git,agent-hq,review}.ts`, `packages/opencode/src/workbench/**`, `packages/opencode/src/agenthq/**`,
`packages/opencode/src/review/**`, `packages/opencode/src/cli/cmd/workbench.ts`, `packages/app/src/workbench/**`, `packages/app/src/review/**`,
`packages/app/src/agenthq/**`, `packages/desktop/scripts/spicy-*.ts`, `packages/desktop/src/main/bundled-cli.ts`,
`packages/ui/{bunfig.toml,test-preload.ts}` (ui test preload: JSX against solid's hyperscript runtime, as in `packages/app/happydom.ts`),
`docs/SPICY_IDE_*.md`, `docs/spicy/**`, `SPICY.md`.
