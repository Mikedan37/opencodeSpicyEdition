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
