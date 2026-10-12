# spicy-lsp notes (Phase 0: LSP repairs and environment doctor)

Branch `spicy-lsp`, based on `c59cd9f9c`. Every edit in an upstream-owned file carries a `spicy:` comment.

## Implemented

| ID | Change |
|---|---|
| REG-01 | Swift diagnostics work. The client advertises `workspace.diagnostics.refreshSupport` and handles `workspace/diagnostic/refresh` by re-pulling. For servers that register pull diagnostics at runtime (sourcekit-lsp), an empty pull report is provisional until the server's first refresh, for at most 5 s after start. Static pull providers (eslint, rust-analyzer) keep the old fast path. Root cause is below. |
| REG-02 | Server death is detected from the process `close`/`error` events. During initialize the connection is disposed, so the pending `initialize` rejects at once with `exited with code N: <last stderr line>` instead of after 45 s. The rustup stub now fails in about 1 s, down from 45.7 s. The failure is recorded with its reason. `status()` reports failed starts and crashes as `"error"`, and the reason is logged. |
| REG-09 | When a server crashes after start, its client is dropped and its diagnostics are cleared through `updatePushDiagnostics`/`updatePullDiagnostics` with `[]`, so every listener sees the clear. `lsp.updated` is published. The next touch after a backoff (1 s, then 2 s) restarts the server. After 3 failures per root+server per instance it stays off. Servers whose `spawn` finds nothing (not installed) stay silent and permanent, as before. |
| REG-03 | gopls: `go.work` lookup uses `StrictNearestRoot`, so the `go.mod` branch runs. |
| REG-04 | Root markers that start with `*` (`*.xcodeproj`, `*.xcworkspace`, and the existing `*.tf`, `*.cabal`, `*.jl`) match directory entries by suffix. This uses a local `up()` in `server.ts` with the same walk order as `Filesystem.up`. |
| REG-05 | sourcekit-lsp extensions changed from `[".swift", ".objc", "objcpp"]` to `[".swift", ".m", ".mm"]`. Choice: `.objc` and `objcpp` match no real file, and Objective-C is `.m`/`.mm`. Because `.m` is also MATLAB/Octave, `.m`/`.mm` are claimed only inside an Apple project (strict root: `Package.swift`, `*.xcodeproj`, `*.xcworkspace`). `.swift` keeps the instance-dir fallback. Verified: a `.m` file in a SwiftPM ObjC target gets `clang(-Wint-conversion)` from sourcekit-lsp. |
| REG-06 | TypeScript: with `OPENCODE_DISABLE_LSP_DOWNLOAD`, only a `typescript-language-server` already on PATH is used, and nothing is installed through `Npm.which`. Biome had the same install-on-miss problem and got the same guard. |
| REG-08 | edit, write and apply_patch metadata now hold only the touched files' diagnostics plus `diagnosticCounts` (`{error, warning, info, hint}` over the whole workspace map). write also keeps the up to 5 other files it reports in its output. The key shape (`diagnostics[path]`) is unchanged, so `session-ui` `message-part.tsx`, the TUI and the web share view render as before. |
| REG-10 | `processId` in `initialize` is `process.pid`. |
| DIAG-10 | `LSP.Diagnostic.pretty` prints `source(code): ` when present, for example `ERROR [3:11] clangd(-Wint-conversion): ...` or `typescript(2322)`. `report` keeps errors only, the 20-per-file cap and `... and N more`, and appends `(N warnings not shown)`. Files with only warnings still produce no block, because the tools wrap the block in "LSP errors detected ... please fix". The format is covered by golden tests. |
| Doctor | `src/workbench/doctor.ts` (`Doctor.report`, `Doctor.table`, Effect Schemas `Doctor.Report`/`Language`/`Probe` ready for `GET /workbench/doctor`). The CLI is `opencode debug workbench doctor [--json]`. Details below. |

### Doctor

- Covers Swift, C/C++, Python, TypeScript/JavaScript, Rust and Go. Areas: `runtime` (python3), `lsp`, `check`, `test`, `debug`. Statuses: `ok`, `missing`, `broken` (found but not runnable: stub, dead binary, non-zero exit, timeout), and `blocked` (lldb-dap while Developer Mode is off).
- Each probe runs `--version`, `version` or `--help` through `AppProcess` with a 3 s timeout and stdin ignored. All probes run concurrently. A full run takes about 1.4 s, including CLI startup.
- Lookup is PATH order plus `Global.Path.bin`, which is what `which()` and server spawns use. npm-cache servers (typescript-language-server, pyright) are also looked up in `Global.Path.cache/packages/<pkg>`. On macOS it falls back to `xcrun -f` for sourcekit-lsp, swiftc, swift and lldb-dap.
- The Python interpreter lookup runs every `python3` on PATH. It reports the first runnable one and lists the skipped ones, for example `skipped /usr/local/bin/python3: EBADARCH: bad CPU type in executable`.
- debugpy is checked as importable by that interpreter, or as bundled in `~/.vscode/extensions/ms-python.debugpy-*/bundled/libs`. The bundled copy is verified by importing it with `PYTHONPATH`.
- js-debug looks for `dapDebugServer.js` under `Global.Path.bin/js-debug/src` and `~/.vscode/extensions/ms-vscode.js-debug*/src`.
- lldb-dap: `--version` plus `DevToolsSecurity -status`. Nothing is ever launched under lldb.
- macOS safety: `/usr/bin` developer shims are never run when `xcode-select -p` fails, because they would open the Command Line Tools installer dialog.
- Not implemented: custom LSP commands from config are not probed. The doctor checks the built-in server for each language.

Doctor output on this Mac, with the interactive PATH:

```text
swift       lsp      ok       sourcekit-lsp               /usr/bin/sourcekit-lsp
swift       debug    blocked  lldb-dap                    LLVM version 21.0.0 | Developer Mode is off: ...
python      runtime  ok       python3                     Python 3.9.6 | skipped /usr/local/bin/python3: EBADARCH: bad CPU type ...
python      test     ok       pytest                      pytest 8.3.4
python      debug    ok       debugpy                     1.8.20
typescript  lsp      missing  typescript-language-server
typescript  debug    missing  js-debug                    no vscode-js-debug dapDebugServer.js
rust        lsp      broken   rust-analyzer               error: Unknown binary 'rust-analyzer' in official toolchain ...
go          lsp      missing  gopls
go          debug    missing  dlv
```

pytest is present: 8.3.4 on the interactive PATH and 9.0.2 at `/opt/homebrew/bin/pytest`. The environment notes listed it as missing. The `#!/bin/zsh` script PATH puts `/opt/homebrew/bin` first and leaves out `/usr/local/bin`, so results depend on which PATH the CLI inherits.

## REG-01 root cause (measured)

sourcekit-lsp registers `textDocument/diagnostic` right after `didOpen`. If a pull arrives before its SwiftPM build settings are loaded, it answers `{"kind":"full","items":[]}` (built from fallback settings) about 50 ms later. Once the settings exist, about 0.7 s after open, it sends `workspace/diagnostic/refresh` and expects the client to pull again. It never pushes `publishDiagnostics` to a client that advertised pull support. opencode advertised `refreshSupport: false`, answered the refresh with null without re-pulling, and treated the empty report as final: `matched` meant return, and `mergeResults` stored `[]`. The result was `{file: []}` every time.

Every opencode run hit the cold path, while a plain JSON-RPC client usually got the error on the first pull, after about 0.5 s. The difference is the environment. `src/index.ts:77` exports a fresh `OPENCODE_PID` per process, and SwiftPM's manifest cache is keyed on the environment, so each opencode-spawned sourcekit-lsp re-evaluates the manifest. Reproduced with the raw client: any new environment variable made the first pull empty, in 5 of 5 runs with `OPENCODE_PID=<random>`. Each run then got a refresh at about 0.73 s and the error on the re-pull at about 1.2 s.

These were not the cause: languageId (`swift` is correct), `processId`, `initializationOptions: {}`, and the `didChangeWatchedFiles` created event. Each of them, toggled alone in the raw client, matched the baseline.

Results after the fix: `debug lsp diagnostics Sources/Demo/main.swift` returns `Cannot convert value of type 'String' to specified type 'Int'` in 2.3 to 3.1 s total wall time. A clean Swift file returns `[]` in about 2.4 s, once the refresh arrives. clangd (C) is unchanged at about 1 s.

## Upstream-owned files touched

| File | Why |
|---|---|
| `packages/opencode/src/lsp/client.ts` | REG-01 refresh support and provisional wait. REG-02/REG-09 stderr tail, `exited` promise, dispose on death, clearing through the storage functions, and dead-server guards in the wait loops. REG-10 `processId`. `updatePushDiagnostics`, `updatePullDiagnostics` and the publish handler are not renamed or changed. |
| `packages/opencode/src/lsp/lsp.ts` | `broken` changed from `Set<string>` to `Map<string, Broken>` (reason, failures, retryAt). Adds `fail()`, `blocked()`, the crash watcher, error entries in `status()`, an `EffectBridge` in state, and a finalizer that empties `clients` before shutdown. `Interface` is unchanged. |
| `packages/opencode/src/lsp/server.ts` | Suffix-aware `up()` for `NearestRoot`/`StrictNearestRoot` (REG-04). gopls strict `go.work` (REG-03). sourcekit extensions and root (REG-05). TypeScript and Biome download guard (REG-06). |
| `packages/opencode/src/lsp/diagnostic.ts` | `pretty` source(code) and `report` warnings count (DIAG-10). New `metadata()` helper (REG-08). |
| `packages/opencode/src/tool/edit.ts`, `write.ts`, `apply_patch.ts` | Diagnostics metadata only (REG-08). |
| `packages/opencode/src/cli/cmd/debug/index.ts` | One import line plus one `.command(WorkbenchCommand)` line. |
| `packages/opencode/test/lsp/client.test.ts` | The `refreshSupport` assertion changed from `false` to `true`, because refresh is now handled, not overclaimed. Adds a `processId` assertion and new tests. |
| `packages/opencode/test/lsp/index.test.ts`, `test/fixture/lsp/fake-lsp-server.js` | New tests. Fixture controls: `provisionalMs` (sourcekit pattern), `FAKE_LSP_EXIT_ON_CHANGE`, `FAKE_LSP_PUBLISH_ON_OPEN`, `FAKE_LSP_STATIC_PULL`. |

New fork-owned files: `src/workbench/doctor.ts`, `src/cli/cmd/debug/workbench.ts`, `test/lsp/{sourcekit,server-roots,diagnostic}.test.ts`, `test/tool/diagnostics-metadata.test.ts`, `test/workbench/doctor.test.ts`.

## Tests

From `packages/opencode`:

- `bun test --timeout 30000 test/lsp`: 77 pass, 0 fail (baseline 58).
- `bun test --timeout 30000 test/tool`: 344 pass, 0 fail (baseline 341).
- `bun test --timeout 30000 test/workbench`: 5 pass, 0 fail.
- `bun run typecheck`: clean.

The real sourcekit test (`test/lsp/sourcekit.test.ts`) ran and passed here. It skips with the stated reason in its name when `xcrun -f sourcekit-lsp` fails. The lldb-dap doctor test skips with a reason off macOS. With refresh support reverted, the sourcekit test and three of the fake-server REG-01 tests fail. The root tests fail on the original `server.ts`.

## Trade-offs and limits

- A clean file from a runtime-registered pull server that never sends a refresh waits until warm-up ends: at most 5 s, only within the first 5 s after that server starts. sourcekit-lsp always refreshes, so a clean Swift file costs about 1 s.
- A refresh only wakes waiters. Open files nobody is waiting on are re-pulled on their next touch, so the stored list for those files can stay at the provisional `[]` until then.
- `LSP.Status` (the public HttpApi schema) has no reason field. Adding one needs `packages/client` regeneration, which is outside my ownership. Reasons are kept in `lsp.ts` state and logged as `LSP server failed`.
- An unavailable server (not installed) is still never retried during an instance's lifetime, same as before.

## Notes for the coordinator and other branches

- spicy-problems hook: when a server dies, client.ts writes `[]` for every stored file through `updatePushDiagnostics`/`updatePullDiagnostics`. A hook placed in those functions reports the clearing with no extra code. After a crash, lsp.ts removes the client from `clients`. The new code sits just above `// --- Connection state ---` and right after `connection.listen()`, so expect small merge-context overlap near lines 135 to 230.
- spicy-dap: the doctor's interpreter rule ("run every python3, take the first that works") and the bundled-debugpy check (`PYTHONPATH=<libs>`) match what the DAP launcher needs.
- Bugs seen but not fixed (out of scope):
  - `RustAnalyzer.root` checks `NearestRoot(...) === undefined`, which is dead for the same reason as REG-03, so `.rs` files outside a crate fall back to the instance dir.
  - FSharp root markers `.sln`, `.slnx` and `.fsproj` are literal names and never match.
  - The unique `OPENCODE_PID` in the LSP server environment slows sourcekit's first diagnostics (manifest cache miss), but REG-01 no longer depends on it.

## Blockers

None. The live TypeScript LSP check was not run, because typescript-language-server is not installed and installing it needs the network.
