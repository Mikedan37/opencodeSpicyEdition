# spicy-problems notes

Branch `spicy-problems`. Scope: P1 (problem store, LSP hook, events, `GET /workbench/problems`) and P2
(verification engine, `check` tool, turn-end gate). Contract: `packages/schema/src/workbench.ts`, unchanged.

## P1: problem store, LSP hook, events, route

Implemented:

- `packages/opencode/src/workbench/problems/store.ts` (`WorkbenchProblems.Service`, per-instance `InstanceState`).
  Slices keyed by producer, each holding file → `Problem[]`. `begin(producer)` starts a new generation and aborts the
  previous run's `AbortSignal`; `finish(producer, generation, result)` replaces the slice atomically and returns
  `false` (results dropped) when a newer generation exists. Problem ids are `sha1(producer, file, code, message,
  start line)`; duplicates within one result are dropped. `snapshot({ severity, source, file })` computes counts,
  producer states and `stale` (one `stat` per file: stale when mtime is newer than `observedAt`, or the file is gone).
- `workbench.problems.updated` is coalesced to at most one event per 100 ms by a scoped fiber reading a change
  queue, and published through `EventV2Bridge`, so it carries `location.directory` and reaches GlobalBus with the
  project directory.
- LSP hook: `LSPClient.create` takes `onDiagnostics` and calls it with the merged (push + pull, deduplicated) list
  whenever a push or a pull replaces a file's diagnostics. `LSP.Service.diagnosticEvents()` is a `Stream` that
  replays the latest event per server, root and file, then follows new ones (replay and listener registration
  happen in one synchronous step, so nothing is lost). The store subscribes when its instance state is created.
- `packages/opencode/src/workbench/problems/lsp-source.ts`: LSP `Diagnostic` → problem draft (kind `lsp`, tool =
  server id, producer `lsp:<serverID>:<root>`, code, `codeDescription.href` → `codeHref`, `relatedInformation` →
  `related`, ranges kept 0-based).
- Route group `WorkbenchApi` (`groups/workbench.ts`, `handlers/workbench.ts`): `GET /workbench/problems` with query
  `severity`, `source`, `file` (absolute or relative to the directory) → `ProblemsSnapshot`.

Upstream-owned files touched (each edit marked `spicy:`):

| File | Change | Why |
|---|---|---|
| `packages/opencode/src/lsp/client.ts` | `DiagnosticsEvent` type, `onDiagnostics` input, `emitDiagnostics` called after push, pull and the TS first-push seed | Problem store hook; no other logic changed |
| `packages/opencode/src/lsp/lsp.ts` | State keeps the latest event per file plus listeners; `onDiagnostics` passed to `LSPClient.create`; `diagnosticEvents()` on the interface | Subscription for the store |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | Import and `.addHttpApi(WorkbenchApi)` | Compose the route group |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Import handlers + store; add `workbenchHandlers` and `WorkbenchProblems.node` | Serve the group |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | One coverage line for `workbench.problems` | `test:httpapi --fail-on-missing` |
| `packages/opencode/test/{session/prompt,session/snapshot-tool-race,tool/lsp}.test.ts` | LSP stubs gain `diagnosticEvents: () => Stream.empty` | They build `LSP.Service.of` with every method |

`bun run generate` in `packages/client` produced no tracked changes (the client is generated from the protocol API,
which does not include instance route groups).

Design choices:

- DIAG-01 "both sources listed": the contract has one `source` per problem, so push and pull of the same error
  become one problem from the server's producer. The LSP client already merges both channels; the store never sees
  two copies.
- Stale uses mtime, not a content hash: one `stat` per file at read time, no reads.
- Check runs that time out, are cancelled or have no tool keep the previous slice (it turns stale when the file
  changes) and set the producer state and reason instead.

Tests (`packages/opencode/test/workbench/problems.test.ts`):

- DIAG-01 push + pull through the real LSP service and a fake server (`test/fixture/workbench/lsp-push-pull.js`) →
  one problem with code, href, range and producer.
- DIAG-02 edit after observation → stale; new result → fresh.
- DIAG-03 newer generation aborts the older signal; the older `finish` is dropped.
- DIAG-04 the event reaches GlobalBus with the project directory and EventV2 listeners with `location.directory`.
