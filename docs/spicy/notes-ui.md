# spicy-ui notes (wave 1)

Branch `spicy-ui`. Scope: bottom-panel Workbench tabs, Agent HQ client state and Agents tab, Problems tab. Built against
`packages/schema/src/agent-hq.ts` and `packages/schema/src/workbench.ts`; no backend routes exist on this branch, so
everything below was exercised with mocked routes and injected events.

## What exists

- **Bottom panel tabs** (new layout, `terminal-panel-v2.tsx`): Agents, Problems, Output, Debug Console and Run sit at
  the trailing edge of the terminal tab bar (sticky, so they stay visible when terminal tabs overflow). Agents shows a
  count of agents needing attention; Problems shows errors + warnings. Output, Debug Console and Run render an empty
  state naming what will appear there. The selected tab is persisted per project with the app's own
  `persisted(Persist.serverWorkspace(scope, directory, "workbench-panel"))`, like the terminal list. Any terminal focus
  request (terminal tab click, new terminal, ``ctrl+` ``) hands the bar back to the terminals, so terminal behaviour is
  unchanged. Commands "Show agents" / "Show problems" (View category) open the panel on that tab.
- **Agent HQ state** (`src/agenthq/store.ts`, `context.tsx`): loads providers, agents and each agent's sessions; applies
  `agenthq.agent.updated|removed`, `agenthq.provider.updated`, `agenthq.session.updated`, `agenthq.session.event`
  (decoded with the contract schemas; undecodable events are dropped). Envelopes are seq-checked per session: duplicates
  are ignored, a gap holds later events and reloads `GET /agenthq/sessions/:id`, then replays the held ones. Accepted
  envelopes are queued and applied once per animation frame in one batch; consecutive `message.delta`s of a message are
  merged first, so a burst of tokens is one store write per message per frame (only that message's text node updates).
  A session is subscribed once no matter how many views show it (ref-counted `watch`/`unwatch`).
- **Agents tab** (`src/agenthq/agents-panel.tsx`, lazy): roster of character cards (avatar, name, provider chip, model,
  status pill from the latest session, title, project + specialty, attention dot for needs-approval / failed latest
  session / completed while unviewed). Selecting a card opens the workspace: session list, virtualized conversation
  (messages, collapsible reasoning, tool rows with state + title + capped output in a disclosure, permission cards,
  file-changed / turn-completed / error rows), composer (Enter sends, Shift+Enter newline), Cancel for running turns
  (disabled with a reason when the provider reports `cancel: false`), Start session, Edit, Expand.
- **Permissions**: cards show the provider's options as buttons. A click sends exactly that option and disables the
  card; it resolves only when the server's `permission.resolved` arrives. A failed answer re-enables it with the error.
  Nothing answers automatically.
- **Expand** opens the same workspace in a full-window layer (portal, scrim, Escape / scrim click to close). Chosen over
  a route or a full-height panel mode because it needs no router or session-page layout change (zero extra upstream
  edits) and keeps one subscription per session (the panel shows a "open in the expanded view" note meanwhile).
- **Create / Edit dialog** (`agent-dialog.tsx`): name, avatar (6 inline-SVG presets: fox, octopus, owl, robot, cat,
  bear; initials; emoji; theme colour token), provider radio list from `/agenthq/providers` (unavailable ones disabled
  with their `reason`, sign-in-required tagged), optional model (disabled when `capabilities.models` is false),
  specialty, project directory with the app's `useDirectoryPicker` (the form survives the picker replacing the dialog).
  Edit has a two-click delete.
- **Problems tab** (`src/workbench/problems-panel.tsx`, lazy): `GET /workbench/problems` at mount, refetch on
  `workbench.problems.updated` (250 ms debounce, never overlapping). Search, severity toggles with counts, source-kind
  filter, collapsible file groups (errors first, then line), stale badge, producer state (running / unavailable /
  failed) in the toolbar, virtualized rows. Clicking a row selects the line (the viewer highlights it), opens the file
  tab through the app's own opener (`createCommandPaletteFileOpener`) and scrolls the viewer's `[data-line]` row into
  view once rendered.
- All copy is in `src/workbench/en.ts` (English only, merged into the base dictionary; other locales fall back to it).

## Files

New (fork-owned): `packages/app/src/agenthq/{store,context,agents-panel,agent-dialog,avatar}.ts(x)`,
`packages/app/src/workbench/{client,en,panel,problems,problems-panel,ui,virtual-list}.ts(x)`, tests
`src/agenthq/store.test.ts`, `src/workbench/{client,problems}.test.ts`, `test-browser/agenthq-store.test.ts`,
`e2e/regression/agenthq-panel.spec.ts`. HTTP lives only in `src/workbench/client.ts`.

Upstream-owned files touched (each edit marked `spicy:`; please add to `SPICY.md`, which this branch does not edit):

| File                                                   | Change                                                                                                                                     | Why                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `packages/app/src/pages/session.tsx`                   | import + wrap `SessionProviders` children in `<WorkbenchProviders>`                                                                        | Agent HQ / Workbench state per workspace         |
| `packages/app/src/pages/session/terminal-panel-v2.tsx` | `useWorkbench()`; Tabs `value`/`onChange`; `<WorkbenchTabTriggers />` in the tab list; Workbench content `Show` beside the terminal `Show` | Tabs beside the terminals                        |
| `packages/app/src/context/language.tsx`                | import `workbench/en`, add it to `RawDictionary` and `base`                                                                                | Typed fork copy without touching 61 locale files |

## Assumptions about the backend (adjust in `src/workbench/client.ts` / `src/agenthq/context.tsx`)

- Routes as in the master plan, instance-scoped through `?directory=<workspace>` on every request (the server reads the
  query param before the header), Basic auth from the server connection, `platform.fetch`.
- `GET /agenthq/sessions/:id` returns `{ session: AgentSessionInfo, history: AgentEventEnvelope[] }` (fixed at
  integration; PATCH clears optional fields with `null`).
- `POST /agenthq/agents/:id/sessions` takes `{}` and returns `AgentSessionInfo`; `POST .../cancel` may return
  `AgentSessionInfo` (used when it decodes); message and permission POSTs only need a 2xx.
- `PATCH /agenthq/agents/:id` gets the full draft; a cleared model/specialty is sent as `""`.
- A 404 or a non-JSON reply means "this server has no Workbench routes yet" (shown as such, with retry).
- Events arrive as `{ type, properties }` (legacy) or `{ type, data, location }` (current), carry the workspace
  directory, and are read from the directory-scoped emitter (`sdk().event.listen`). Session status is taken from
  `agenthq.session.updated` and, for watched sessions, from in-order `status` envelopes.
- `seq` is gap-free per session; history is persisted no later than the event is published (otherwise a gap resync
  could repeat). A 1-based first `seq` costs one extra history load, nothing else.
- `reasoning` carries a block's full text once (a rewrite repeats it), so it replaces; a complete `message` replaces
  the streamed deltas and ends streaming for that message.

## Tests and results

- `bun run typecheck` (packages/app): clean.
- New unit tests, `bun test --conditions=solid ... ./src/agenthq ./src/workbench`: 19 pass (delta buffering, delta
  coalescing order, seq gap → held events → resync, gap inside held events, failed load → retry, duplicate ignore,
  permission pending/answering/failed/resolved, tool row upsert + output cap, one subscription per session, attention
  rules, session replace semantics, problem filter/group/collapse, debounced non-overlapping refetch, client directory
  scoping/auth/encoding, unavailable vs failed errors, contract decoding).
- `test-browser/agenthq-store.test.ts` (browser condition, real Solid reactivity): 100 deltas over 2 frames → 2 writes
  to the reply text, 1 list append, 0 writes to other rows. Pass.
- `src/i18n/parity.test.ts`: pass.
- Full `bun run test:unit`: 487 pass / 23 fail / 16 errors; `bun run test:browser`: 19 pass / 8 fail / 7 errors. The
  failures are pre-existing and identical with the three upstream edits reverted (every one is
  `Export named 'jsxDEV' not found in solid-js` when a test imports a `.tsx` module; this machine runs bun 1.4.3 while
  the repo pins bun 1.3.14). No component render tests for the same reason.
- Playwright (Chromium 1228 via a `PLAYWRIGHT_BROWSERS_PATH` shim; Playwright 1.59.1 wants 1217, nothing was
  downloaded): `e2e/regression/agenthq-panel.spec.ts` passes, 8/8 under `--repeat-each=8` with 4 workers. It covers
  roster, history load, streamed deltas, tool row, permission click → exact POST body → resolution event, seq gap → one
  history reload, attention badges, problems grouping/stale/filter/refetch on event, persistence across reload, and
  the terminal taking the bar back. Terminal and review regressions (`terminal-tab-switch`, `terminal-hidden`,
  `terminal-composer-focus`, `review-terminal-stacked`, `review-open-file`) pass. `tab-navigate-mousedown` fails
  (2 tests) with and without this branch's changes.
- Performance (AGENTS.md baseline rule): `session-tab-switch-benchmark` + `first-navigation-benchmark` against
  production builds, 3 baseline and 3 changed runs interleaved. Medians stay inside run-to-run noise (cold tab switch
  21.8 → 21.0 ms, hot 2.4 → 2.6 ms, v2 closed cold 17.4 → 19.3 ms [base range 17.1–20.4], v2 open cold 18.3 → 18.8 ms,
  first navigation 19.9 → 21.0 ms [base range 14.6–20.4]). An earlier version used `useSessionLayout()` in the provider,
  which builds per-session memos on every session switch; it was replaced by a lazily built view in the command handler.

## Gaps

- Not wired to a real backend; payload shapes above are assumptions until `spicy-agenthq` / `spicy-problems` land.
- Old layout (`terminal-panel.tsx`, new layout designs off) has no Workbench tabs.
- Debug Console and Run are empty states only (they need the `spicy-dap` contracts).
- Relative times do not tick.
- Line navigation depends on the viewer's `[data-line]` markup inside its shadow root (polls up to ~1 s); files outside
  the workspace root cannot be opened by the app's file tabs.
- Keyboard: Workbench tabs open on click / Enter / Space; arrow keys only move focus to them (Kobalte selects the first
  tab on its own whenever its value is missing, so automatic activation is ignored for these tabs).
- Load races: an agent created while the initial list request is in flight can be dropped until the next event or
  reload.

## Wave 2

### Markdown messages

Assistant and system messages (and reasoning) render through `@opencode-ai/session-ui/markdown`, the timeline's own
component: worker parsing, highlighted code blocks, DOMPurify sanitizing (`javascript:` links lose their `href`, other
links get `target="_blank" rel="noopener noreferrer"`). User messages stay plain text. A message streams (`streaming`)
until its complete `message` event arrives and only while the session runs; deltas still reach the store once per
animation frame per message, so the component sees at most one text update per frame. `cacheKey` is per message, so
rows that the virtualizer remounts reuse the parsed HTML.

Verified against the real server (isolated XDG dirs, a local OpenAI-compatible stub as the model): created an agent
and a session from the UI, sent a message, watched the reply stream with a partially highlighted code block, then
the final render: 1 code block with 29 highlighted spans, bold, a 3-item list, the https link with
`target=_blank rel="noopener noreferrer"`, the `javascript:` link without `href`, status back to `idle`. The e2e spec
asserts the same rendering with mocked events. In a fresh Vite dev server the first Markdown render can fail once
while Vite re-optimizes `marked`/`shiki` (it reloads the page); the timeline has the same behaviour.

### Output tab

`src/workbench/runs.ts` (state), `ansi.ts` (SGR → styled segments, `file:line` references, path resolution),
`output-panel.tsx` (lazy), shared `open-file.ts` (also used by Problems).

- Runs come from `workbench.run.updated` and `workbench.run.output` (decoded with the contract), newest first, at most 100. A run seen starting in this view is "live": chunks append in `seq` order, duplicates are dropped, a missing
  `seq` marks a gap. Its output is kept up to 1 MB (the newest part), like the server's stream cap.
- History: when the tab first opens, `GET /workbench/runs` (assumed `RunInfo[]`) adds earlier runs. Output the stream
  cannot provide (runs not seen starting, or a live run with a gap once it finishes) is fetched with
  `GET /workbench/runs/:runID` (assumed `{ run: RunInfo, output: string }`) when its section is open. A 404 or a
  non-JSON reply marks history unavailable: the tab then shows "Showing runs from this window only" and works from
  events alone. Both shapes live in `client.ts`.
- Each run: status chip (`RunStatus`), checker, unit relative to the project, error/warning counts, duration (locale
  number formatting, ticking while running), exit code, the command, the reason when skipped/unavailable/timed out,
  and the output: ANSI colors (16 colors mapped to theme tokens, 256-color and truecolor, bold/dim/italic/underline;
  other escapes dropped), virtualized lines, `path:line[:col]` and `path(line,col)` linkified (resolved against the
  unit's folder, never inside URLs). A link opens the file tab at that line, like a problem row.
- "Run checks" calls `POST /workbench/check` with `{}` (the server decides what to check) and shows the report summary;
  without the route it shows "This server can't start checks from the app yet." and nothing else changes.
- The Output tab badge counts runs that are queued or running.

Against the `spicy-problems` routes (commit `a9d2d9c8a` applied to this worktree temporarily, not committed here):
`GET /workbench/runs` listed an earlier run, opening it fetched `GET /workbench/runs/:runID` and showed tsc's output,
"Run checks" posted `{ unit: <project> }` and showed "Last check: 0 passed, 1 failed, …" with the new run on top. That
run also found a bug, now fixed: pressing ctrl+` (a terminal focus request) and switching to a Workbench tab before the
terminal took focus left the request pending, so a terminal created later (here a stale PTY recovered after a server
restart) pulled the bar back to the terminal. Opening a Workbench tab now cancels a pending terminal focus request.

Verified against the real server (same setup as above, the stub model asked for the `check` tool on
`src/broken.ts`): the run appeared as Running, streamed tsc's text output, finished as Failed with 2 errors, `0.4 s`,
`exit 2`; both `src/broken.ts(1,14)` / `(3,19)` links were clickable and opened `broken.ts` with line 1 selected.
Before those routes were applied, the server answered `GET /workbench/runs` and `POST /workbench/check` with HTML, so
the tab showed the window-only hint and the toast, as designed. Runs started by the server have `NO_COLOR`/`TERM=dumb`, so
real output is usually uncolored; colors are covered by unit tests and the e2e spec.

### Agent HQ across projects, persisted "finished but not viewed"

- Agent HQ now listens on the server-wide event stream (`serverSDK().event.listen`) instead of the open workspace's:
  every `agenthq.*` event carries its agent's project directory, so agents working in other projects stay live in
  the roster and workspace. HTTP calls still go through the open workspace's instance (the session manager is
  process-global). Workbench events (`workbench.*`) stay per workspace.
- "Finished but not viewed" is now a persisted `seen` map (sessionID → the `updatedAt` last seen),
  `Persist.serverGlobal(scope, "agenthq.seen")`, pruned to existing sessions on load. A session is flagged when it is
  `completed` or `idle` (the server reports a finished turn as `idle`) and changed after the user last looked at it.
  Viewing a session, or updates arriving while it is open, move the mark; a session met for the first time counts as
  seen unless it arrives completed. So work that finishes while the app is closed is still flagged on the next start.
- Verified against the real server: an agent created by API in another project (`…/other`) appeared in the roster of
  the open project through its event, went `working` → `idle` live, showed the finished dot, kept it across a reload,
  lost it once opened, and its history rendered (Markdown included) through the open project's instance. The e2e spec
  covers the same with events from another directory and two reloads.

### Wave 2 tests and performance

- Unit (`bun test --conditions=solid … ./src/agenthq ./src/workbench ./src/i18n/parity.test.ts`): 35 pass (new: ANSI
  segments/256-color/truecolor, file references and URL exclusion, path resolution, run streaming/gaps/history/detail/
  unavailable routes/check, message finality, reasoning replace, persisted seen marks). Browser-condition streaming
  test: pass. `bun run typecheck`: clean.
- e2e `agenthq-panel.spec.ts`: 3 tests (Agent HQ + Markdown + Problems; Output tab; cross-project + persisted seen),
  pass with `--repeat-each=2` and 4 workers, together with the terminal and review regressions (22 runs).
- Real server (isolated XDG dirs, OpenAI-compatible stub model, `OPENCODE_DISABLE_MODELS_FETCH=1`): Markdown streaming,
  the Output tab from the `check` tool, the runs/check routes (applied temporarily), cross-project events and the
  persisted finished dot, as described above.
- Benchmarks (first navigation + session tab switching, production builds, 3 runs of the wave 1 integration commit
  `3a601fc50` and 3 of this HEAD, interleaved): medians within run-to-run noise with overlapping ranges, e.g. first
  navigation 23.6 → 24.7 ms, cold tab switch 21.9 → 24.2 ms (ranges 20.6–22.4 / 22.3–27.3), v2 closed cold 17.3 → 18.3
  ms, v2 open cold 9.8 → 13.4 ms (ranges 8.1–12.4 / 7.9–19.2). Nothing added in wave 2 runs on a session switch; the new
  panels are lazy chunks.

## Wave 3: debugger UI

Built on the `spicy-dap` routes and events (`docs/spicy/notes-dap.md`, "UI reference"). State: `src/workbench/debug.ts`
(pure store, unit tested) behind `DebugProvider` (`debug-context.tsx`, inside `WorkbenchProviders`), which follows
`workbench.debug.updated` / `workbench.debug.output` / `pty.exited` and registers the debugger commands.

### What exists

- **Debug tab in the side panel** (v2 layout, `debug-side.tsx` + lazy `debug-panel.tsx`): a `Debug` trigger after
  Review/Context (amber dot while paused, green while running). It shows over whatever tab the panel has selected; any
  other tab or file opening hides it (other contents stay mounted, hidden by `debug-side.css`). Contents: toolbar
  (start, continue/pause, step over/into/out, stop; a disabled button says why in its tooltip: ending, the agent drives,
  starting, running), session picker, owner chip (You / Agent / No owner / Ending) with **Take over**
  (`POST /owner {owner:"human"}`), status line ("Paused: breakpoint", the exception id/description, a failed session's
  error verbatim), call stack (click selects the frame; the arrow opens its file at the line), variables of the top
  frame as a lazy tree (children paged 50 at a time with "Load more"; open nodes stay open across steps and reload with
  the new references), watches, breakpoints and exception filters.
- **Start dialog** (F5 with no live session, or the toolbar): a program path (prefilled with the active `.py` file),
  arguments (quotes group words), "Pause on the first line", or a `.vscode/launch.json` configuration (names read with
  a small JSONC scanner; the server resolves the configuration). The active file is sent as `${file}`. Saved
  breakpoints go along as absolute paths, and saved exception filters for the adapter the server will pick. A refusal
  is shown as the server words it ("Developer Mode off — run sudo DevToolsSecurity -enable", missing debugpy, …) and
  the dialog stays open. On success the bottom panel opens on the Debug Console.
- **Breakpoints** are saved per workspace (project-relative paths). Edits sync to every running/paused session the
  human drives (an idle session would be claimed, an agent's would refuse with 409); the adapter's `verified` comes back
  per session and an unverified breakpoint is drawn hollow with its message. Conditions, hit counts and log messages are
  edited inline; a field the selected session's adapter lacks (`supportsConditionalBreakpoints`,
  `supportsHitConditionalBreakpoints`, `supportsLogPoints`) is disabled and says so. Exception filters are a static
  per-adapter list (the session's capabilities hold only booleans): debugpy raised/uncaught/userUnhandled (server
  default: uncaught), lldb-dap cpp/objc/swift throw/catch; changes are saved per adapter and pushed to the sessions of
  that adapter the human drives.
- **Watches** are saved per workspace and evaluate in the selected frame on each stop and frame change, but only while
  the human drives the session (they run program code); otherwise they keep their last values (dimmed) and offer
  "Evaluate now".
- **Debug Console** (bottom tab, lazy `debug-console.tsx`): `GET /output?after=0` once per session merged with live
  rows by `seq` (duplicates dropped, order kept), the server's truncation row, a client cap of 256 KB with its own
  "… N earlier rows dropped (256 KB output cap)" row (the server's dropped count included), Output / Errors / Debugger
  filters (stdout, stderr, adapter console; telemetry never reaches the client), attribution chips (you / agent /
  program / debugger) where the author changes, stop and exception locations that open the file, and an input that
  evaluates in the selected frame (disabled unless paused). Completions come from `GET /completions` (150 ms debounce,
  only with `supportsCompletionsRequest`): Up/Down move, Tab/Enter accept, Escape closes. Up/Down otherwise walk the
  saved history (50). Results with a `variablesReference` expand like variables while their pause is current.
- **Run tab** (`debug-run.tsx`): the selected session's program PTY (`ptyID`) in the existing `Terminal` component; the
  terminal context's remove-on-exit is not involved, so the terminal stays after the program exits with "Exited with
  code N" from `pty.exited`. Switching tabs mounts it again with its saved buffer and reconnects. Without a PTY
  (debugpy's default internal console) the tab says so and links to the Debug Console.
- **Editor gutter** (`debug-file.tsx`, provided app-wide through `FileComponentProvider` in `app.tsx`): in the file
  viewer (the `File` instance with line selection; timeline previews and diffs are untouched), red dots for breakpoints
  (amber for conditions/log points, hollow when unverified), the selected frame's line tinted amber with an amber
  gutter bar, and under the top frame's paused line a row with the values of the locals named on that line (shortened;
  the Debug tab has them in full). Pierre renders lines in a shadow root, so these are inline styles on its
  `[data-column-number]` / `[data-line]` nodes, reapplied by MutationObservers whenever it re-renders them; the values
  row is a pierre annotation appended after the file view's own (comment) annotations.
- **Keys** (Debug category, rebindable): F5 start/continue, Shift+F5 stop, F10 step over, F11 step into, Shift+F11 step
  out, F9 toggle breakpoint, plus Pause and Show debugger in the palette. They fire while typing; the list lives in
  `src/workbench/keys.ts` (`SPICY_EDITABLE_KEYBIND_IDS`), which `context/command.tsx` spreads into
  `EDITABLE_KEYBIND_IDS`, so later fork keys are added there without touching `command.tsx` again. Inapplicable keys
  are hidden from the palette but stay bound (a disabled command would let F5 reload the page). F9 toggles the line
  the active viewer shows selected, else the paused line when that file is paused.
- A stop the human drives opens its file scrolled to the paused line, unless the Debug tab is in front. Debug paths
  open files without selecting the line: the file view keeps the first selection pierre reports (`note.selected` in
  `file-tabs.tsx`), so a later programmatic selection in the same file would not show.

### Files

New (fork-owned): `packages/app/src/workbench/{debug,debug-context,debug-ui,debug-panel,debug-side,debug-start,
debug-console,debug-run,debug-file,keys}.ts(x)`, `debug-side.css`; client routes added to `client.ts`; tests
`src/workbench/debug.test.ts`, `test-browser/debug-store.test.ts`, `e2e/regression/debug-panel.spec.ts`.

Upstream-owned files touched in wave 3 (each edit marked `spicy:`). The `server-session.ts` skip of `workbench.*`
events and its test were reverted on `spicy-ide` (`5c86aa388`): `workbench.debug.output` now names the debug session
`debugSessionID`, so that file matches dev again.

| File                                                     | Change                                                                                                                                                                                                  | Why                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/app/src/pages/session/session-side-panel.tsx`  | import; `useDebugSideTab(() => tabs().active())`; v2 `Tabs` `value` / `onChange` / `data-workbench-side`; `<DebugSideTrigger />` after the Context trigger; `<DebugSideContent />` after the file browser | Debug tab in the side panel                                           |
| `packages/app/src/app.tsx`                               | `File` import replaced by `DebugFile`; `FileComponentProvider component={DebugFile}`                                                                                                                     | Gutter marks in the file viewer                                       |
| `packages/app/src/context/command.tsx`                   | import `SPICY_EDITABLE_KEYBIND_IDS` (`workbench/keys.ts`) and spread it into `EDITABLE_KEYBIND_IDS`                                                                                                     | Debugger keys fire while typing; the shared seam for later fork keys |

### Assumptions about the backend

- Completion items count `start` from 0 (debugpy computes `column - 1 - len(qualifier)`, like VS Code expects) even
  though the session asks for 1-based columns; without `start` the identifier before the cursor is replaced.
- Variable references die with their stop; evaluate results expand only while `row.at >= stop.at`.
- Route replies (control, owner, stop) are applied unless an event already moved the session (a newer `stop.at` or an
  end), so a slow reply never undoes a stop.
- Every evaluate, watches included, is also a console row (`eval` + `result`), so watches show up in the console. A
  watch flag on the evaluate route would let the console skip them.
- Contract smell worth fixing upstream of the UI: `workbench.debug.output.sessionID` holds a debug session id; naming
  it `debugSessionID` would keep generic `sessionID` handlers away.

### Gaps

- Legacy side panel (new layout designs off) has no Debug tab; the bottom tabs need the v2 terminal panel too.
- Variables only for the top frame (the routes have no scopes for other frames); other frames get a note.
- No gutter click to toggle a breakpoint: pierre's line-number click opens the file view's comment draft. F9 (on the
  selected or paused line) and the breakpoint list cover it; clicking a line to select it also opens that draft.
- The Debug tab and the file viewer share the side panel, so opening a frame's file leaves the Debug tab.
- Exception filter checkboxes show the saved preference per adapter, not the filters an agent-started session uses;
  breakpoints shown are the human's, not ones the agent set.
- Function and data breakpoints, investigations, and "hand to agent" / "release" are not exposed yet.
- The Run tab's exit code needs this window to see `pty.exited`; after a reload an ended program shows "Ended".
- Paths are treated as POSIX (`relative`/`absolute` in `debug.ts`).

### Wave 3 tests and verification

- Unit: `src/workbench/debug.test.ts` (15: session order/adoption, frame reset and page pruning per stop, a control
  reply never undoing a newer stop, list merge, console merge/cap/dropped counts/late backlog, history, completion
  range, breakpoint save/sync/verified/refusal, start payload, exception defaults, watches, launch.json JSONC, args,
  adapter guess); `test-browser/debug-store.test.ts` (loaders called from effects neither loop nor retry a failure,
  and reload after a stop).
- With bun 1.4.3 the tsx-importing unit and browser tests fail on `jsxDEV`; they run with
  `bun --tsconfig-override=<tsconfig extending packages/app/tsconfig.json with "jsx": "react-jsx",
  "jsxImportSource": "solid-js/h"> test …`: `src` 769/770 (the one failure is `i18n/desktop-native.test.ts`
  "likely subtags", bun's ICU data, unrelated), `test-browser` 43/43. `bun run typecheck`: clean.
- e2e `debug-panel.spec.ts` (mocked routes, injected events): side panel (start dialog with a verbatim refusal, stack,
  lazy variables 50 + "Load more", watches per frame, stepping, agent ownership and Take over, F9, conditions per
  capability, exception filters, hiding on another tab); Debug Console (backlog + live merge, truncation row, filters,
  chips, completions, evaluate, expandable result, exception row, history, disabled while running); Run tab (PTY
  terminal, exit code, remount, internal-console state); gutter (paused line, values row, dots, F9, frame selection).
  Passes with the agenthq, review, file browser and terminal regression specs (one hover test in
  `review-line-comment.spec.ts` flaked under parallel load and passed 15/15 with `--repeat-each=3`).
- Real flow (isolated XDG dirs, real server from this branch, debugpy from VS Code's bundle on Homebrew Python 3.14,
  Playwright Chromium against the Vite app; no Electron, no lldb): F5 → start `app.py` paused on entry; the file opened
  with line 1 marked; clicked line 13 + F9 → `POST …/breakpoints` with the absolute path, debugpy verified it; F5 →
  stopped at `main:13`, values row `items = […]`, Debug tab: stack `main app.py:13 < <module> app.py:21`, locals
  items/name/total, `items` children 50 then 63 after "Load more"; watch `total + 100` = 100; F10 → 14, F11 → `helper:5`
  (watch shows the NameError), Shift+F11 → back in `main`; console completions for `ite` (iter, items, item), Tab
  accepted, `items[:3]` evaluated and expanded (6 children); Shift+F5 ended it ("program exited with code 247");
  launch.json "App in terminal" (`console: integratedTerminal`) → `ptyID`, Run tab terminal printed the program's
  output and showed "Exited with code 0". The final run had no 5xx responses and no console errors. It found and
  fixed: the `GET /session/dbg_…` 500s, a variables retry loop after a 502 for a stale reference, console results
  expanding with stale references, F9 using a selection the viewer did not show, and over-wide values rows.
- Benchmarks (first navigation + session tab switching, production builds, 3 runs of `fe1c8528b` and 3 of this HEAD,
  interleaved): within run-to-run noise, e.g. cold tab switch 25.0 → 22.1 ms (ranges 23.2–26.6 / 19.8–22.7), v2 open
  hot stable 19.4 → 16.5 ms, v2 closed cold stable 34.5 → 35.5 ms (33.5–35.2 / 35.2–35.8), first navigation 22.9 →
  23.1 ms. An earlier pass showed v2 open hot stable 16.8 → 19.3 ms; since then the File wrapper calls `File(props)`
  directly for diffs and previews (no spread proxy per review diff), and the rerun above is with that change.

## Wave 4: Agent HQ tasks and team view, activity and evidence

### What exists

- **Tasks view** (`src/agenthq/tasks-panel.tsx`, state in `src/agenthq/tasks.ts`): the Agents tab has an
  Agents | Tasks switch (Tasks counts tasks waiting for review). Tasks are listed in dependency order: a task follows
  the tasks it waits on, a chain reads top to bottom, indented by its longest dependency path, with dependency chips
  coloured by their status and the server's reason (`Waiting on "…"`, blocked, failed). A running task whose session
  asked for a permission says "Waiting for your approval" and offers that session.
- **Task detail**: Start (ready) / Start again (failed, cancelled), Cancel, Edit, Delete (two clicks), Open session
  (the Agents workspace on the task's session; coming back keeps the task selected), assignee, depends-on chips
  (click to select), where it works (worktree branch and path; "Merged from <branch>; its worktree is removed" once
  done), description, the result summary (Markdown).
- **Create / edit dialog**: title, description (`null` clears it on edit), assignee from the roster, depends-on
  checkboxes, "Run in its own git worktree" (on by default). Server refusals (cycles, unknown dependencies, edits
  after start) are shown in the dialog as worded.
- **Review gate**: a task in review first loads `GET /tasks/:id/review` (once per review; "Check again" reloads):
  "Approve merges <branch> into <base>", commits, files with +/−, and the dirty-project or conflict reason. Approve
  is disabled while the dry run says it cannot merge, is only ever a click, and a 409 from approve is shown verbatim
  under it. Nothing approves on its own.
- **Messages**: per task (in its detail) and per agent (Messages toggle in the agent workspace): from you or from an
  agent, to an agent, with Relay for agent-to-agent exchanges; delivery failures and stopped exchanges show the
  server's reason; each message links to the session it was delivered to.
- **Live updates**: `agenthq.task.updated` / `agenthq.task.removed` / `agenthq.message` (decoded with the contract) in
  the Agent HQ provider; a route reply older than an event (`updatedAt`) never replaces it; a status change drops the
  task's dry run. The Agents tab badge adds tasks in review.
- **Activity tab** (bottom panel, `src/workbench/activity-panel.tsx`, state in `src/workbench/investigations.ts`):
  investigations newest first with status, agent, evidence count and reason (badge: needs_human, blocked,
  interrupted). The detail shows the status timeline (checkpoints with reasons and evidence ids that scroll to the
  evidence), evidence (observed / verified, kind, summary, data) with links: a run opens Output on that run (opened
  and scrolled to), a debug session opens the side panel's Debug tab on it (disabled once the server no longer keeps
  it), an Agent HQ session opens in the Agents tab; plus the budget, repair attempts, the agent's inferred notes
  (labelled as not evidence), unverified files and the report (Markdown). Resume (interrupted / needs_human /
  blocked) and Cancel (not ended) use the existing routes; a newer `workbench.investigation.updated` reloads the
  open record.
- **Debug ownership**: the owner chip offers Take over, Hand to agent and Release (`POST /owner` with `human`,
  `agent`, `idle`) by owner: agent → take over; idle → take over, hand to agent; you → hand to agent, release.

### Files

New (fork-owned): `src/agenthq/{tasks,tasks-panel}.ts(x)`, `src/workbench/{investigations,activity-panel}.ts(x)`;
tests `src/agenthq/tasks.test.ts`, `src/workbench/investigations.test.ts`, `e2e/regression/agenthq-tasks.spec.ts`,
`e2e/regression/activity-panel.spec.ts`. Changed fork files: `agenthq/{context,agents-panel}.tsx`,
`workbench/{client,en,panel,runs,output-panel,debug,debug-context,debug-ui}`. No upstream-owned file changed in wave 4.
The e2e specs set `shouldDisplayTabsToast: false`, because the "Introducing Tabs" card can cover buttons near the
bottom right.

### Notes for the backend owners

- Agent HQ sessions ask before editing (`edit: <path>` permission), so every task that writes waits once for the
  user's answer in its session while the task stays `running`; the Tasks view surfaces it from the session status.
- After approve the task record still carries `worktree` (path and branch) although both are removed; the UI words
  it as merged. Clearing it, or a `merged` marker, would make the record say so itself.
- Messages sent to a task's assignee while the task is in review start a new turn in the task's session.
- No investigations exist without an agent running the `debug` tool, so the Activity tab was verified against the
  real routes only in its empty state; the rest is covered by the mocked spec.

### Wave 4 tests and verification

- Unit: `src/agenthq/tasks.test.ts` (6: dependency tree order/depth/cycles, list + event merge with `updatedAt`, one
  action at a time and the refusal kept, dry run kept per review and dropped on status change, threads load once and
  merge), `src/workbench/investigations.test.ts` (2: merge and staleness, record reload and retry). Agent HQ +
  Workbench unit tests 53/53. With the JSX override: `src` 776/777 (the `desktop-native` ICU test again), `test-browser`
  43/43. `bun run typecheck`: clean.
- e2e: `agenthq-tasks.spec.ts` (create with dependencies, refused edit, start, approval wait, open session and back,
  review dry run with a dirty project, Check again, approve refused then merged, dependent ready, messages with relay
  and a stopped exchange, per-agent messages, cancel, refused delete), `activity-panel.spec.ts` (timeline, evidence
  classes, Output / Debug / Agent HQ links, hand to agent and release, resume, newer summary, cancel). With the
  Agent HQ, debugger, review, file browser and terminal specs: 23/23 with `--workers=2`. With 7 workers the machine
  was overloaded and 6–8 tests (upstream and fork alike) timed out on 10 s expectations; each passes alone.
- Real pass (isolated server from this branch, fake OpenAI-compatible model that writes a file when the brief says
  `WRITE <path>`, Playwright Chromium against the Vite app, no Electron): two agents, Task 1 (isolated) and Task 2
  (isolated, depends on Task 1) created from the dialog; Task 2 showed `Waiting on "Write the first note"`. Start
  created `task-write-the-first-dff3` under the data dir's worktree folder; the agent's edit asked for permission, the
  task said "Waiting for your approval", the driver answered "Allow once" in the session; review showed
  `Approve merges task-write-the-first-dff3 into main`, commit `4f15563 Write the first note`, `notes/one.txt +1 −0`;
  Approve merged it (`fdc8a50 Merge task: Write the first note`) and Task 2 became ready; the same for Task 2
  (`08bbbf5`, `8250604 Merge task: Write the second note`), with a message to its assignee delivered to the task's
  session. Afterwards the project had both files and merge commits, no worktrees and no task branches. The first
  attempt (before the approval hint existed) was cancelled and both tasks deleted, which removed its worktree and
  branch (the delete of the depended-on task was refused with `Task "Write the second note" depends on it` first).
  Owner controls on a real debugpy session: you → Release → idle → Hand to agent → agent → Take over → you, matching
  the server each time. No new crash reports in `~/Library/Logs/DiagnosticReports` (Python 11 before and after; the
  only additions were three macOS `SFA-*.diag` snapshots).
