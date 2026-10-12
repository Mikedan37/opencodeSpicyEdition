# Agent HQ backend notes (`spicy-agenthq`, wave 1)

Scope: identity registry, provider contract, OpenCode native adapter, external CLI detection, session
manager (events, history, recovery) and the `AgentHQApi` routes. Contract: `packages/schema/src/agent-hq.ts`
(unchanged by this branch).

## Implemented

| File                                                                       | What                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/agenthq/provider.ts`                                | `AgentProvider.Interface` (`id`, `status`, `createSession`, optional `resumeSession`), `AgentProvider.Session` (`send`, `cancel`, optional `respondPermission`, `close`), `Emit` callback, typed errors `NotFoundError`, `InvalidInputError`, `UnsupportedError`, `ProviderError` |
| `packages/opencode/src/agenthq/registry.ts`                                | `AgentRegistry` service: list/get/create/update/remove identities in the JSON store, validated with the schema, publishes `agenthq.agent.updated` / `agenthq.agent.removed`                                                                                                       |
| `packages/opencode/src/agenthq/providers/opencode.ts`                      | OpenCode adapter: runs the session in-process inside the identity's own instance (`InstanceStore.provide({ directory: workingDirectory ?? projectDirectory })`), maps session events to `AgentEvent`s, cancel = abort, resume supported; `guard()` permission policy              |
| `packages/opencode/src/agenthq/providers/detect.ts`                        | Status-only providers for `claude-code`, `cursor`, `codex`: `which` + `--version` (and `--help` for cursor's ACP check), 3 s timeout, never reads credentials or env; `createSession` fails with `UnsupportedError`                                                               |
| `packages/opencode/src/agenthq/session.ts`                                 | `AgentSessions` manager (process-global): sessions, per-session queue + single consumer, delta coalescing, gap-free `seq`, capped compacted history, persistence, publishing, cancel, permission replies, restart recovery, provider status cache                                 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/agenthq.ts`   | `AgentHQApi` route group (payload/response schemas)                                                                                                                                                                                                                               |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/agenthq.ts` | Handlers; translates domain errors to API errors                                                                                                                                                                                                                                  |
| `packages/opencode/test/agenthq/agenthq.test.ts`                           | AHQ-01..07, AHQ-10 + `guard` policy test                                                                                                                                                                                                                                          |
| `packages/opencode/test/agenthq/agenthq-http.test.ts`                      | Route-level error mapping (400/404/409 bodies)                                                                                                                                                                                                                                    |
| `packages/opencode/test/server/httpapi-exercise/agenthq.ts`                | `test:httpapi` scenarios for all 11 routes                                                                                                                                                                                                                                        |

### Why the manager is process-global (not `InstanceState`)

An agent session belongs to its identity's project, not to whichever directory a client is routed to, and
must stay reachable from any instance. Identities and sessions live in the global JSON store. The provider
work itself runs inside the identity's project instance (OpenCode adapter uses `InstanceStore.provide`).

## Upstream-owned files touched (each line marked `// spicy:`; please add to `SPICY.md`)

| File                                                             | Change                                                                                                                            | Why                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | import `AgentHQApi`; `.addHttpApi(AgentHQApi)` on `InstanceHttpApi`                                                               | compose the route group                                                             |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | import + add `agenthqHandlers` to `instanceApiRoutes`; import + add `AgentRegistry.node`, `AgentSessions.node` to the `app` group | serve the routes and build the services                                             |
| `packages/opencode/test/server/httpapi-exercise/index.ts`        | import + `...agenthqScenarios` at the end of `scenarios`                                                                          | `bun run test:httpapi --fail-on-missing` requires a scenario for every public route |

`bun run generate` in `packages/client` produces no diff: that client is generated from the V2 Server API
(`@opencode-ai/protocol`), not from `InstanceHttpApi`. The legacy JS SDK (`packages/sdk/js`) was **not**
regenerated (it would conflict with the other wave-1 route groups); regenerate once after integration.

## Routes (as implemented)

All routes are instance routes: they take the usual `?directory=` query / `x-opencode-directory` header and
server auth (401 without credentials when a password is set), like every other instance group.

| Method | Path                                                  | Body                                                                                                                 | 200 response                                                                                       | Errors             |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| GET    | `/agenthq/providers`                                  |                                                                                                                      | `ProviderStatus[]` (all four ids, always)                                                          |                    |
| GET    | `/agenthq/agents`                                     |                                                                                                                      | `AgentIdentity[]`, **all projects**, oldest first                                                  |                    |
| POST   | `/agenthq/agents`                                     | `{ name, avatar, provider, model?, specialty?, projectDirectory?, workingDirectory? }`                               | `AgentIdentity`                                                                                    | 400                |
| PATCH  | `/agenthq/agents/:agentID`                            | any of `name, avatar, provider, projectDirectory`; `model, specialty, workingDirectory` (string, or `null` to clear) | `AgentIdentity`                                                                                    | 400, 404           |
| DELETE | `/agenthq/agents/:agentID`                            |                                                                                                                      | `true` (also cancels + deletes its sessions and histories; the backing opencode sessions are kept) | 404                |
| GET    | `/agenthq/agents/:agentID/sessions`                   |                                                                                                                      | `AgentSessionInfo[]`, oldest first                                                                 | 404                |
| POST   | `/agenthq/agents/:agentID/sessions`                   | `{ title? }` (send `{}`)                                                                                             | `AgentSessionInfo` (status `idle`, `providerSessionID` set)                                        | 404, 409, 502      |
| GET    | `/agenthq/sessions/:sessionID`                        |                                                                                                                      | `{ session: AgentSessionInfo, history: AgentEventEnvelope[] }`                                     | 404                |
| POST   | `/agenthq/sessions/:sessionID/messages`               | `{ text }`                                                                                                           | `true` (accepted; progress arrives as events)                                                      | 400, 404, 409, 502 |
| POST   | `/agenthq/sessions/:sessionID/cancel`                 |                                                                                                                      | `AgentSessionInfo` after cancel                                                                    | 404, 409, 502      |
| POST   | `/agenthq/sessions/:sessionID/permissions/:requestID` | `{ optionID }`                                                                                                       | `true` (accepted; resolution arrives as an event)                                                  | 400, 404, 409, 502 |

- `projectDirectory` defaults to the directory the request is routed to. Directories must be absolute and
  exist; they are stored realpath-resolved (e.g. `/private/var/...` on macOS).
- Identities may use any provider, available or not. Starting a session for `claude-code`, `cursor` or
  `codex` returns **409** (no adapter yet) and creates no session record.
- `messages` on an `interrupted` session resumes it first when the provider supports resume (OpenCode does).
- `cancel` on a session that is not active returns it unchanged.

Error bodies (exact):

```json
400 {"_tag":"InvalidRequestError","message":"projectDirectory must be absolute: rel"}
400 {"name":"BadRequest","data":{"message":"Missing key\n  at [\"avatar\"]","kind":"Payload"}}   // schema decode
404 {"name":"NotFoundError","data":{"message":"Agent session not found: ags_x"}}
409 {"_tag":"ConflictError","message":"Codex sessions are not supported by Agent HQ yet","resource":"codex"}
502 {"_tag":"UpstreamError","message":"...","service":"opencode"}
```

## Events (as implemented)

Every `agenthq.agent.*` and `agenthq.session.*` event carries `location.directory = identity.projectDirectory`,
so it reaches `/event?directory=<project>` and the global stream with that directory.
`agenthq.provider.updated` carries the directory of the request that triggered detection.

| Type                       | Data                               | When                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agenthq.agent.updated`    | `{ agent: AgentIdentity }`         | create and every update                                                                                                                                                                                     |
| `agenthq.agent.removed`    | `{ id: AgentID }`                  | delete                                                                                                                                                                                                      |
| `agenthq.provider.updated` | `{ provider: ProviderStatus }`     | a provider's status differs from the last published one; the first `GET /agenthq/providers` publishes all four. Detection is cached 30 s and runs only when providers are requested (no background polling) |
| `agenthq.session.updated`  | `{ session: AgentSessionInfo }`    | after any batch that changed the info (status, `pendingPermissions`, `error`, ...)                                                                                                                          |
| `agenthq.session.event`    | `{ envelope: AgentEventEnvelope }` | one bus event per envelope, in `seq` order                                                                                                                                                                  |

`seq` is per session, starts at 0, and is gap-free on the bus. Provider events pass through one queue per
session and one consumer, so there is exactly one event stream per session no matter how many callers
attach, load or resume it concurrently. Text deltas are coalesced: a delta-only batch waits 40 ms and adjacent
deltas of the same message merge into one `message.delta`.

### OpenCode → `AgentEvent` mapping

| OpenCode                                                            | AgentEvent                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send` (manager, any provider)                                      | `message` `{ role: "user", messageID: <uuid>, text }` then `status: working`                                                                           |
| text part delta                                                     | `message.delta` (`messageID` = opencode text **part** id)                                                                                              |
| text part finished (`time.end`)                                     | `message` `{ role: "assistant", messageID: <same part id>, text }` (if opencode rewrites a finished part, `message` repeats with the same id: replace) |
| reasoning part finished                                             | `reasoning` `{ messageID: <part id>, text }` (full text, once)                                                                                         |
| tool part pending/running/completed/error                           | `tool` `started`/`running`/`completed`/`error`, `title`, `output` = output or error text capped at 2000 chars; one event per state change              |
| patch part                                                          | `file.changed` per file                                                                                                                                |
| `permission.asked` for the session or a subagent session it spawned | `permission.requested` `{ requestID, title: "<permission>: <patterns>", tool: <permission>, details: <metadata JSON, capped>, options }`               |
| `permission.replied`                                                | `permission.resolved` `allowed` / `rejected`                                                                                                           |
| session busy / retry while our turn runs                            | `status: working` / `status: blocked`                                                                                                                  |
| turn ends normally                                                  | `turn.completed` `{ stopReason: <assistant finish, e.g. "stop"> }`                                                                                     |
| turn ends with an error                                             | `error` `{ message }` then `status: failed`                                                                                                            |
| turn aborted outside Agent HQ                                       | `status: cancelled`                                                                                                                                    |
| run interrupted (instance disposed)                                 | `error` then `status: disconnected`                                                                                                                    |

Permission options (ids are what `POST .../permissions/:requestID` takes as `optionID`):
`once` → `allow_once`, `always` → `allow_always`, `reject` → `reject_once`.

### Session status rules (manager, provider-independent)

- `start` → `idle`; `send` → `working` (clears `error`); `turn.completed` → `idle`.
- `permission.requested` → `needs_approval`, `pendingPermissions` counts open requests; while any is open,
  provider progress (`working`/`thinking`) does not hide it. The last `permission.resolved` → `working`.
- `cancel` → open requests get `permission.resolved` `cancelled`, then `status: cancelled`. The session stays
  usable: the next `send` starts a new turn.
- `error` sets `AgentSessionInfo.error`; `failed`, `disconnected`, `cancelled`, `interrupted` are not
  terminal — a later `send` continues the session (resuming it first if needed).
- Restart: on graceful shutdown the manager appends `status: interrupted` to every active session (`starting`,
  `thinking`, `working`, `needs_approval`, `blocked`); after a crash the first Agent HQ call does the same for
  records left active. History stays intact.

### History (`GET /agenthq/sessions/:id`, key `["agenthq","events",id]`)

A compacted view of the stream, newest 2000 entries: a completed `message` replaces its deltas, a `tool`
keeps only its latest state, consecutive deltas of one message merge. Seq in history is strictly increasing
but may skip compacted entries; the last entry always has the newest seq. A client that reconnects calls GET,
continues from `history.at(-1).seq` (GET returns exactly what has been persisted and published, never more), and
resyncs again whenever a live envelope skips a seq. Deltas-only
batches are written at most once per second, everything else immediately.

## Persistence

- `["agenthq","agent",agentID]` → `AgentIdentity`
- `["agenthq","session",agentSessionID]` → `AgentSessionInfo` + `pid` of the driving process. A second opencode
  process sharing the data directory can read such a session but gets 409 when it tries to drive it, and
  does not mark it interrupted while that pid is alive.
- `["agenthq","events",agentSessionID]` → `AgentEventEnvelope[]` (compacted, capped)
- No credentials, environment variables or provider tokens are stored or returned.

## Permission policy (never auto-approve)

OpenCode sessions created by Agent HQ get a session ruleset built from the default agent's rules
(`guard()` in `providers/opencode.ts`): every `allow` becomes `ask` except for read-only tools (`read`, `glob`,
`grep`, `list`, `lsp`, `todoread`, `todowrite`, `skill`, `webfetch`, `websearch`); `deny`/`ask` rules keep their
order, so nothing becomes looser. `bash`, edits, `task`, MCP tools, `verify.exec`, `debug.*` therefore never run
without the human (a configured `deny` stays `deny`). `question`, `plan_enter`, `plan_exit` are denied because Agent HQ has no question surface yet
(an unanswered question would block the turn forever). Agent HQ itself never answers a permission request;
only `POST .../permissions/:requestID` does. The ruleset is snapshotted when the session is created.

## Tests

From `packages/opencode`:

| Command                                               | Result                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `bun test --timeout 60000 test/agenthq`               | 10 pass, 0 fail; 5 consecutive full runs green, AHQ-03/AHQ-10 12 more runs green |
| `bun test --timeout 30000 test/server test/session`   | 716 pass, 9 skip, 1 todo, 0 fail (skips/todo are pre-existing upstream markers)  |
| `bun run test:httpapi` (coverage, auth, effect modes) | 219 pass, 0 fail, 0 skip, 0 missing in each mode, exit 0                         |
| `bun run typecheck`                                   | clean                                                                            |

Test IDs covered: AHQ-01 (identity CRUD, persistence, events, validation), AHQ-02 (two identities on one
provider: separate sessions/histories), AHQ-03 (fake model: streamed deltas, glob tool events, reasoning,
completion, persisted compacted history, seq continuity, event location), AHQ-04 (bash asks; nothing runs and
the model is not called again for 500 ms; unknown request → 404; answering completes the turn), AHQ-05 (cancel
→ `cancelled`, opencode session idle, no further model calls, session usable afterwards), AHQ-06 (graceful
shutdown and crash both → `interrupted`, history intact, resume completes a turn), AHQ-07 (fake `claude`,
non-ACP and ACP `cursor-agent` scripts, missing `codex`; manager lists all four with reasons; publishes on
change only; unsupported provider → typed error, no record), AHQ-10 (fresh lifetime, concurrent
load/attach/send/respond: one stream, no duplicate events, contiguous unique seq from the resume point).
No test needs a paid model (fake server `test/lib/llm-server.ts`). AHQ-07's manager section runs the real
`claude --version`, `cursor-agent --version/--help` if present on PATH (read-only probes, 3 s timeout);
its assertions do not depend on what is installed. AHQ-08/09 are wave 2.

## Blockers and known limits

- Cursor: installed `cursor-agent` 2025.09.12 has no `acp` command → `available: false`, reason
  `cursor-agent 2025.09.12 has no ACP mode; update cursor-agent`. Its `-p` mode runs tools without approval and
  is not used.
- Codex: not installed → `available: false`, `codex not found on PATH`.
- Claude Code: binary detected (`2.1.296`, `auth: "unknown"`) but no adapter yet: capabilities all `false`,
  starting a session → 409.
- Changing an identity's `model` (or directories) applies to sessions attached after the change; a live
  OpenCode session keeps the values it was attached with.
- Sessions of identities whose `provider` is changed keep their original `provider`.
- `GET /agenthq/agents` is global; the UI filters by `projectDirectory` if it wants a per-project roster.

## Next: Claude Code, Cursor (ACP), Codex adapters

Each adapter implements `AgentProvider.Interface` in `src/agenthq/providers/<name>.ts` and replaces the
`AgentDetect.make(...)` stub in the `providers` map in `session.ts`; keep `status` from `detect.ts`
(availability) and set capabilities honestly. Shared requirements:

- Spawn with `ChildProcessSpawner`/`AppProcess` in the manager scope, local only; `cancel` and `close` must
  kill the whole process tree (AHQ-05 "process tree gone"); on unexpected exit emit `error` + `status:
failed` (or `disconnected`) — the manager keeps history.
- Never pass bypass flags (`--dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
  `cursor-agent -p/--force`). Permission asks must surface as `permission.requested` and wait for
  `respondPermission`.
- Emit `message.delta` per text chunk (the manager coalesces), `message` with the full text at the end of a
  block, `tool` per state change, `turn.completed` at turn end; return `providerSessionID` so
  `resumeSession` can work after a restart (omit `resumeSession` if the CLI cannot resume).
- Cursor (ACP): use `@agentclientprotocol/sdk` (already a dependency): `session/new`, `session/prompt`,
  `session/update` → events, `session/request_permission` → `permission.requested` (ACP option kinds match the
  contract's `allow_once`/`allow_always`/`reject_once`/`reject_always`), `session/cancel`. AHQ-08 can run
  against `opencode acp` as a real ACP agent until `cursor-agent` ships `acp`.
- Claude Code: stream-json in/out (`-p --output-format stream-json --input-format stream-json
--include-partial-messages --resume <id>`); permission asks need a non-bypass approval surface (the progress
  doc plans `@anthropic-ai/claude-agent-sdk`, which is a new dependency and needs the coordinator). AHQ-09 is
  opt-in for a real authenticated `claude`, contract test otherwise.
- Codex: blocked until `codex` is installed; evaluate its non-interactive protocol and approval surface then.
