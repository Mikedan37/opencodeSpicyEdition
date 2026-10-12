# spicy-desktop notes (wave 2: desktop launch harness)

Branch `spicy-desktop`, based on `spicy-ide` 6c2f6f274. I merged `spicy-ide` twice: first at 3a601fc50 (fast-forward), then at a8cb5f748, which includes the b547f81a8 debugpy fix, wave-2 UI/DAP and review. Both merges were clean and the lockfile did not change.

## What exists

All scripts are in `packages/desktop/scripts/`. They are run from `packages/desktop`.

| File                            | Purpose                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spicy-package-check.ts`        | Builds the macOS app offline as an unsigned, un-notarized `--dir` bundle. Then checks Assets.car, the Info.plist icon keys and the actool compile.                                                                              |
| `spicy-launch.ts`               | Launches the app with all of its state isolated, plus a DevTools (CDP) port. Modes: `built` (out/ with node_modules Electron) and `dev` (`electron-vite dev`). Exports `launch`, `cleanup`, `provisionKeychain`, `processTree`. |
| `spicy-cdp.ts`                  | Minimal CDP client: evaluate/waitFor, real mouse clicks, `Input.insertText`, key presses, `Page.captureScreenshot`.                                                                                                             |
| `spicy-model.ts` (+ `.test.ts`) | Scripted OpenAI-compatible streaming chat endpoint, plus `demoConfig()` for the isolated `opencode.json`. Nothing reaches a real provider.                                                                                      |
| `spicy-smoke.ts`                | End-to-end smoke of the owner's milestone over CDP (checks listed below).                                                                                                                                                       |

App edits:

- `packages/desktop/src/main/index.ts` (upstream, `spicy:` marked):
  - keeps a `--remote-debugging-port` already given on the command line instead of forcing 9222;
  - skips `setAsDefaultProtocolClient("opencode")` when `CFFIXED_USER_HOME` is set.
- `packages/desktop/src/main/windows.ts` (upstream, `spicy:` marked): `setDockIcon` logs `dock icon { path, loaded, size }`.
- `packages/app/src/agenthq/agents-panel.tsx` (fork-owned, `spicy:` comments): adds `data-action="agenthq-new|agenthq-start-session|agenthq-cancel|agenthq-send"` and `data-component="agenthq-composer"`.

## 1. Packaged build check

`bun scripts/spicy-package-check.ts` (`--skip-build` only re-checks an existing bundle). The steps:

```sh
bun ./scripts/copy-icons.ts dev && bun ./scripts/copy-metainfo.ts dev
(cd ../opencode && MODELS_DEV_API_JSON=$PWD/test/tool/fixtures/models-api.json bun script/build-node.ts)
OPENCODE_CHANNEL=dev node_modules/.bin/electron-vite build
CSC_IDENTITY_AUTO_DISCOVERY=false OPENCODE_CHANNEL=dev node_modules/.bin/electron-builder --mac dir --arm64 \
  --config electron-builder.config.ts -c.mac.identity=null -c.mac.notarize=false -c.npmRebuild=false
```

| Step                        | Merged tree (a8cb5f748) | First run (3a601fc50) |
| --------------------------- | ----------------------- | --------------------- |
| icons + metainfo            | 0.0 s                   | 0.1 s                 |
| opencode node server bundle | 0.8 s                   | 0.9 s                 |
| electron-vite build         | 25.8 s                  | 37.7 s                |
| electron-builder --mac dir  | 9.2 s                   | 12.8 s                |
| total                       | 36 s                    | 52 s                  |

Result for `dist/mac-arm64/OpenCode Dev.app`:

- `Contents/Resources/Assets.car`: 2,268,968 bytes. `icon.icns`: 66,546 bytes.
- `CFBundleIconName = Icon`, `CFBundleIconFile = icon.icns`, `CFBundleIdentifier = ai.opencode.desktop.dev`.
- Signature: `Signature=adhoc, TeamIdentifier=not set`. This is only Electron's linker signature; signing and notarization were skipped.
- actool 27.0, run with exactly the arguments electron-builder uses: exit 0, no errors. One warning: `Accent color 'AccentColor' is not present in any asset catalogs` (electron-builder always passes `--accent-color AccentColor`; harmless). Its Assets.car is the same size as the bundled one. electron-builder only prints actool output in debug mode, which is why the script reruns actool.
- `electron-builder` did not download anything. Its "downloaded electron" log line was a cache hit: `~/Library/Caches/electron/…/electron-v42.3.3-darwin-arm64.zip` still has its 2026-10-10 mtime. `native/` does not exist, so electron-builder logs "file source doesn't exist"; the build is unaffected.
- The bundle is built and checked, not launched. Launching a bundle registers it and its `opencode://` scheme with LaunchServices.

## 2. Isolated launch

`bun scripts/spicy-launch.ts [--mode built|dev] [--root DIR] [--port N] [--demo-model]`.

| State                                                     | Mechanism                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron userData, logs, crash dumps, Chromium profile    | `CFFIXED_USER_HOME=<root>/home`. Electron derives appData from the CoreFoundation home, so the app's own `join(appData, appId)` lands in `<root>/home/Library/Application Support/ai.opencode.desktop.dev`. `--user-data-dir` alone does not work, because the app calls `setPath("userData")` itself. Verified with a probe app.                 |
| Node `homedir()` (Tauri migration, shell probe, git, npm) | `HOME=<root>/home`, `ZDOTDIR=<root>/home`, `TMPDIR=<root>/tmp`                                                                                                                                                                                                                                                                                    |
| opencode sidecar                                          | `XDG_{DATA,CONFIG,CACHE,STATE}_HOME`, `OPENCODE_TEST_HOME`. The sidecar inherits the main process environment (`createSidecarEnv` copies `process.env`; `preferAppEnv` keeps an existing `XDG_STATE_HOME`). The smoke checks `GET /path`. Also `OPENCODE_DISABLE_AUTOUPDATE/MODELS_FETCH/LSP_DOWNLOAD`, `npm_config_offline`, `npm_config_cache`. |
| Keychain                                                  | A throwaway keychain is provisioned (see the keychain section), plus `--use-mock-keychain`.                                                                                                                                                                                                                                                       |
| Unattended UI                                             | Seeded on a fresh root: onboarding done (it can create `~/Documents/Default Project`), new layout, notifications and sounds off. Plus `--mute-audio`.                                                                                                                                                                                             |
| CDP                                                       | `--remote-debugging-port=<free port>`, plus `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` and `--disable-background-timer-throttling`, so a covered window keeps rendering.                                                                                                                                      |

Not isolated: AppKit writes `~/Library/Preferences/com.github.Electron.plist` (generic keys for the Electron bundle id) on every run.

Real state after all runs, compared with a snapshot taken before the first launch. The desktop dev userData (`~/Library/Application Support/ai.opencode.desktop.dev`), `~/.local/share/opencode`, `~/.config/opencode`, `~/.cache/opencode`, `~/.local/state/opencode`, `~/Documents/Default Project` and `~/Library/Logs` are all unchanged. The only difference is the mtime of `com.github.Electron.plist`.

## 3. CDP smoke (owner's milestone)

`bun scripts/spicy-smoke.ts [--mode built|dev] [--out DIR] [--root DIR]` exits 0 only if every check passes. Final run on the merged tree, built mode: 31/31 checks in 15 s. Dev mode: 33/33 in 52 s; it also has to reopen the panel after the restart.

Checks, in order:

- **Startup:** launch isolated; renderer over CDP; sidecar ready; sidecar reachable from the renderer (`/global/health` 200); server state isolated (`GET /path` under the root); home shell rendered; Dock icon loaded (log).
- **Project and Agents tab:**
  - **Open project.** The new layout adds projects only through the native folder picker, and new-layout home ignores `opencode://open-project` deep links (see findings). So the smoke creates the project's first session through the server API, the same call the app makes on a first prompt, and opens it through the app's own restore of the window's last URL.
  - Bottom panel via ctrl+`, then the Agents tab.
- **Felix:**
  - Create "Felix" on the OpenCode provider through the dialog; cross-checked with `GET /agenthq/agents`.
  - Start a session; send a message.
  - The reply streams into the workspace, with a screenshot while status is `working` and the text is partial.
  - The turn completes with the exact scripted reply.
  - The server's `/event` stream carried `agenthq.session.event` envelopes: 60 envelopes, 56 `message.delta`, seq 1..60 with no gaps.
- **Cancel:** cancel a running turn. Status becomes `cancelled` and the scripted model saw the request aborted.
- **Panel:** close and reopen the panel (ctrl+` twice); the conversation is still there.
- **Restart:**
  - Quit while a turn streams; no processes are left.
  - Restart on the same root; the app restores the project session by itself.
  - The session list shows `interrupted`, and the history has the first reply. Via the API: 14 history entries, statuses idle > working > cancelled > interrupted.
- **Final quit:** no processes are left.
- **Keychain:** the throwaway keychain has no Safe Storage item (the mock keychain was honored); the throwaway keychain is deleted; the real keychain is unchanged.

How "no processes left" is checked: the app's process tree is recorded just before the SIGTERM quit. That tree is the main process, renderer, GPU, network service, the "opencode server" sidecar (`node.mojom.NodeService`) and the terminal shells it spawned. The OpenCode provider runs inside the sidecar, so it has no process of its own. After the quit, every recorded pid must be gone, and `pgrep -f <this checkout's Electron.app>` must be empty. As a positive control, that same pgrep matched 5-6 processes before the quit.

Screenshots from the final built run are local only (`docs/spicy/desktop-smoke/.gitignore`): `docs/spicy/desktop-smoke/20261012T083410/`

- `01-home.png`
- `02-agents-empty.png`
- `03-create-dialog.png`
- `04-streaming.png`
- `05-reply.png`
- `06-cancelled.png`
- `07-reopened.png`
- `08-restored.png`

Dev mode caveat: on the first dev run in a checkout, Vite pre-bundles the Markdown dependencies when the first reply renders and reloads the page mid-flow, so that run fails. The next run passes.

## 4. Deterministic model

`serveScriptedModel()` serves `POST /v1/chat/completions` (SSE, or JSON when `stream` is false):

- A title-generator request gets "Felix demo".
- A prompt containing "slow" gets 40 long paragraphs at 120 ms per word, enough time to cancel or quit mid-turn.
- Anything else gets a fixed introduction at 70 ms per word.

Aborts are recorded. `demoConfig(url)` registers it as provider `spicy-demo` (bundled `@ai-sdk/openai-compatible`), makes it the default and small model, and sets it as the only enabled provider. Unit test: 3 pass.

## 5. Dock icon in dev

`copy-icons.ts dev` puts `icons/dev` into `resources/icons`. `AppIcon.icon` is identical (`diff -rq`) and `dock.png` is identical (`cmp`; a 256×256 PNG). The new `setDockIcon` log line from the final run:

```
[2026-10-12 01:34:11.483] [info]  (window) dock icon { path: '…/packages/desktop/resources/icons/dock.png', loaded: true, size: { width: 256, height: 256 } }
```

`app.dock.setIcon` raised no error. No screen capture was used.

## Keychain incident and fix

**What happened.** My launches put HOME and CFFIXED_USER_HOME in a temp home. In the first dev-mode run (about 01:12), electron-vite replaced the launcher's switch list with an empty one: cac always sets `options['--']`, which overwrites `ELECTRON_CLI_ARGS`. That run therefore had no `--use-mock-keychain`; its DevTools port was 9222 instead of the chosen port, which confirms the switches were dropped. Chromium tried to store its Safe Storage key ("OpenCode Dev Key"), the fake HOME had no default keychain, and macOS showed "Keychain Not Found" on the owner's screen.

**Runs that could have produced system UI before the fix:**

- the 01:12 dev run (keychain dialog);
- the 01:14 dev run, killed by the coordinator;
- one more dev run at about 01:18, which started after that kill but before the STOP message reached me. It had the switches, so it should not have touched the keychain.

The built-mode runs (00:52-01:09) all had `--use-mock-keychain`, which a probe later showed is honored for both Safe Storage and cookies.

All runs before the fix used the app's default settings, which turn on the completion sound and the "Response ready" notification. Whenever the window was unfocused, they probably played the sound and showed a notification, or a notification permission request.

**Read-only diagnosis:**

- The Security framework resolves user keychains and its search-list preferences from HOME. With a fake HOME, `security default-keychain` reports none.
- CFFIXED_USER_HOME alone does not change keychain resolution.
- A marker plist test confirmed that under a fake HOME the search list comes from `<fake>/Library/Preferences/com.apple.security.plist`.
- The real `~/Library/Preferences/com.apple.security.plist` does not exist; the owner's list is the default `login.keychain-db`.

**Fix.** `provisionKeychain(home)` runs every `security` call with `HOME=<fake>` and refuses the real home. It creates `<fake>/Library/Keychains/spicy.keychain-db` (password `spicy-smoke`), makes it the default and the search list, unlocks it, removes auto-lock, and refuses to launch unless the fake default resolves to it. `cleanup()` deletes it after the last quit. Two gotchas found on the way:

1. `<fake>/Library/Preferences` must exist, or the Security framework silently does not save the search list.
2. A keychain named `login.keychain-db` gets special unlock handling: unlock with its own password reports failure while the keychain toggles unlocked anyway. So the throwaway keychain has a normal name.

**Verification, headless** (minimal Electron app named "OpenCode Dev" calling `safeStorage.encryptString` and writing a cookie, with the launcher's env):

- With `--use-mock-keychain`: works, and nothing is written to any keychain.
- Without the flag: the `OpenCode Dev Safe Storage` / `OpenCode Dev Key` item lands in the throwaway keychain, the process exits in about 0 s, and no dialog appears.

**Real keychain before and after every run** (recorded in each smoke summary, attributes only):

- prefs file absent;
- search list and default = `~/Library/Keychains/login.keychain-db`;
- login keychain unlocked (`SecKeychainGetStatus` = 7).

Correction to "no OpenCode Dev\* item": the real login keychain does contain service `OpenCode Dev Safe Storage`, account `OpenCode Dev Key`, created 2026-10-10T09:08:52Z by an earlier dev run before this session. Its cdat and mdat are unchanged by anything here.

## Other side effects

- My first `bun run build` triggered the package's `prebuild` hook, which did two things:
  - fetched `https://models.dev/api.json`;
  - ran `downloadCliToResources()`. That `bun add`-ed `@opencode-ai/cli-darwin-arm64@0.0.0-next-16350` into a temp dir (served from bun's cache, which has held it since 2026-10-10, in 9 ms) and ad-hoc signed it as `resources/opencode-cli` (gitignored). The dev channel's extraResources package it into the .app.

  `spicy-package-check.ts` now runs the build steps itself and never calls that hook.

- Startup of the first runs made the sidecar fetch npm registry metadata for `@opencode-ai/plugin`. This is the server's background config-dir install, and it fails for dev versions. It is now offline.
- A path probe created an empty `~/Library/Logs/spicy-path-probe`, which I removed.

## Findings for other branches

- **Agent HQ, late delta after cancel.** History shows seq 65 `message` "Paragraph 1: this ", seq 66 `status cancelled`, seq 67 `message.delta` "this ". The UI then renders "Paragraph 1: this this" (screenshots 06-08). The provider (`providers/opencode.ts`) appears to emit a delta for a part that already finished. Dropping deltas for finished parts, or for a messageID that already has its final `message`, would fix it.
- **Agent HQ session title** stays "Untitled session" although the title request was answered ("Felix demo").
- **New-layout home ignores open-project deep links.** `opencode://open-project` is only handled in `pages/layout.tsx`, which the new home does not mount. Separately, main keeps deep links pending when no window has ever had focus: `getLastFocusedWindow()` is null for a window opened in the background.
- **No way to add a project in the new layout except the native picker**, which CDP cannot drive. This is why the smoke opens a project through the API plus the last-URL restore.

## Tests

| Command                                                                    | Result                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun test` (packages/desktop)                                              | 75 pass, 3 of them new                                                                                    |
| `bun test --conditions=solid ./src/agenthq ./src/workbench` (packages/app) | 19 pass                                                                                                   |
| `bun run typecheck` (packages/desktop, which builds `../app` too)          | clean                                                                                                     |
| scripts typecheck                                                          | clean, via a scratch tsconfig with `types: ["bun"]`, because the scripts are outside the package tsconfig |
| `bun scripts/spicy-package-check.ts`                                       | 7/7 checks                                                                                                |
| `bun scripts/spicy-smoke.ts`                                               | 31/31                                                                                                     |
| `bun scripts/spicy-smoke.ts --mode dev`                                    | 33/33                                                                                                     |

# Wave 3: the whole workbench in the desktop app

`bun scripts/spicy-smoke.ts` now drives every workbench surface in one isolated root with one fixture project (a git
repo), through the UI, with the scripted model. Final run on `spicy-ide` df4f8e860 plus this branch, built mode: 59/59
checks, no skips. A failing section is recorded and the run goes on with the next one.

| Section             | What the UI does                                                                                                                                                                                     | Checked against                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents              | as in wave 2, plus: the session gets its generated title; after a cancel nothing more arrives                                                                                                        | session list shows "Felix demo" and `session.title`; the shown text is a prefix of the scripted reply; no history entry after `cancelled`                       |
| Tasks               | Tasks view, create an isolated task for Felix and a second one that depends on it, Start, "Waiting for your approval" → open session → **Allow once**, back, review gate, **Approve** (a click)      | dependent shows `Waiting on "…"`, then becomes ready; project has the file, last commit `Merge task: …`, one worktree, no `task-*` branch, worktree folder gone |
| Review              | Felix writes `a.txt` (2 hunks) and `b.txt`; each `edit` permission answered in the UI; Review panel → Agent changes: accept hunk 1, reject hunk 2, open `b.txt` and **Reject file** in the file view | files on disk byte for byte; changeset counts pending 0, accepted 1, rejected 2                                                                                 |
| Problems and Output | Output → **Run checks** (project unit; `tsc` from this tree via the fixture's `node_modules/.bin/tsc` symlink)                                                                                       | a failed `tsc` run with `broken.ts` in its output, the summary line; Problems lists TS2322; `GET /workbench/problems`                                           |
| Debug               | F5 → launch.json "App in terminal" (debugpy, `console: integratedTerminal`), Pause on the first line → click line 11's number in the viewer → F9 → F5 → Debug tab → Debug Console `answer * 2` → F5  | stop at `main app.py:11`, locals `answer = 12`, result 24, Run tab "Exited with code 0", stdout row `answer = 12`, no debugpy process left                      |
| Activity            | the tab                                                                                                                                                                                              | "No investigations yet"; `GET /workbench/investigations` is `[]`                                                                                                |
| Restart             | quit mid-turn, restart, scroll the conversation to its start                                                                                                                                         | record `interrupted` on disk right after the quit; history recovered (26 entries)                                                                               |
| Afterwards          |                                                                                                                                                                                                      | throwaway keychain deleted, real keychain unchanged, no process with the root on its command line, `~/Library/Logs/DiagnosticReports` 90 → 90                   |

Harness changes:

- `spicy-model.ts`: `scripts` option. A conversation whose latest user message contains a trigger gets that script's
  reply for its step (assistant messages after that user message): one tool call per step, then text. Stateless, so a
  task's brief (`WRITE notes/task.txt`) and an Agent HQ session each run their own copy. Test: 4 pass.
- `spicy-cdp.ts`: `query()` with `>>>` into shadow roots (pierre's file viewer) and the first visible match (hidden
  side-panel tabs stay mounted); `click(selector, text?)`; `clickOn(expression)`.
- `spicy-launch.ts`: a fixed `PATH` (`/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`) instead of the caller's, which
  held `~/.opencode/bin` (the owner's opencode) and `~/.local/bin` (claude, cursor-agent).
- debugpy: VS Code's bundled copy is cloned (APFS `cp -c`) into the fake home's `~/.vscode/extensions`, where the server
  looks, so nothing is written into the owner's extension. Python is Homebrew's; the server never uses Apple's.

## Fixed (found by the smoke)

- **Debugger under the desktop: `ReferenceError: Bun is not defined`.** The desktop's v1 sidecar runs the server under
  Node, and the workbench called Bun APIs: `Bun.file` (launch.json, `Cargo.toml`, lldb's Rust scripts, investigation
  patch hashes), `Bun.sleep` (the debug process kill loop), `Bun.which` (lldb-dap), `Bun.CryptoHasher`, `Bun.spawn` (the
  pytest/python probes). Replaced with `@/util/filesystem`, `fs/promises`, `crypto`, `setTimeout`, core's `which` and
  `Process.spawn`; same results (sha256 hex hashes unchanged). `test/workbench`: 145 pass, 9 skip, 0 fail. Guard:
  `scripts/spicy-sidecar-runtime.test.ts` fails on any `Bun.` call in `packages/opencode/src` outside `src/cli`
  (positive control: it flags all 9 pre-fix calls).
- **Quitting killed the sidecar mid-shutdown** (`src/main/index.ts`). Only relaunch and update installs waited for the
  sidecar; a normal quit let the app terminate its utility process. Measured: the app was gone ~200 ms after SIGTERM,
  while the server's own stop takes ~1.1 s with the renderer's event streams open (headless, same server bundle under
  Node). So the server's shutdown never ran: Agent HQ sessions stayed `working` on disk and the restart recovery marked
  them; in one run the history file of the session that was streaming was unreadable at restart and the recovery
  replaced it with one entry (`seq 0 interrupted`), losing the whole conversation. Now `before-quit` waits for the
  sidecar (bounded by the existing 6 s stop timeout) and quits after; a second caller of `killSidecar` waits for the stop
  in flight. Verified: the record reads `interrupted` right after the quit (the server's shutdown ran) and the history
  survives the restart.

## Findings for other branches

- **Agent HQ (data safety):** `readHistory` turns an unreadable or undecodable history file into `[]`, and the restart
  recovery then overwrites it. Storage writes are not atomic (`writeFileString`). With the quit fix the window is
  small, but a crash or kill during a write still loses the history; write-then-rename, or not overwriting a history it
  could not read, would close it.
- **Debugger UI:** on a human-driven stop (entry), `app.py`'s tab was added to the side panel but the Review ("Files
  Changed") tab stayed in front; the smoke clicks the tab, as a person would. The mocked spec expects the file tab
  selected.
- **Run tab:** opened after the program ended, it shows "Exited with code 0" but an empty terminal; the output is only
  in the Debug Console.
- **Review hunk bar:** at the default 1280×800 window with the side panel open, "Accept"/"Reject" wrap mid-word in the
  hunk bars (screenshot 12).
- **Agent HQ title** is fixed (wave 2 finding): the session list shows "Felix demo". **Late delta after cancel** is
  fixed: nothing is recorded after `cancelled`.

Screenshots (local only): `docs/spicy/desktop-smoke/20261012T210056/01-home.png` … `24-restored.png`.

## Wave 3 tests

| Command                                                       | Result                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `bun scripts/spicy-smoke.ts` (built)                          | 59/59 (fourth run; the first three found the issues above) |
| `bun test` (packages/desktop)                                 | 79 pass                                                    |
| `bun run typecheck` (packages/desktop, packages/opencode)     | clean                                                      |
| `bun test --timeout 60000 test/workbench` (packages/opencode) | 145 pass, 9 skip, 0 fail                                   |
| scripts typecheck (scratch tsconfig)                          | clean                                                      |

## Confirmation run on `dev` f314fb483

After Agent HQ's atomic `AgentStore` and UI wave 6, one built-mode run, rebuilt offline: **60/60**. The smoke now also
checks the wave 6 behaviour instead of working around it: the entry stop brings `app.py` forward over Files Changed by
itself (new check), hunk-bar and review-bar labels stay on one line, and the Run tab, opened after the program ended,
replays its output (`answer = 12`). Nothing regressed. The real keychain was unchanged and no process was left. The
crash reports folder went 91 → 92, but the new report is not from the smoke: `memory_intake-checks` (EXC_BREAKPOINT),
a binary under `/private/tmp/*`, responsible process Terminal, with an exited parent. The same binary also crashed at
15:06:56, before the run started.
Screenshots: `docs/spicy/desktop-smoke/20261012T220724/`.
