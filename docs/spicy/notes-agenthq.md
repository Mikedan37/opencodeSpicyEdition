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
keeps only its latest state (both within the current turn since wave 3), consecutive deltas of one message merge. Seq in history is strictly increasing
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

# Wave 2

## Contract changes (additive, `packages/schema/src/agent-hq.ts`)

| Change                                                                                                                      | Why                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ProviderID` gains `"acp"`                                                                                                  | custom ACP agents (any binary that speaks ACP over stdio)                                                          |
| `AgentIdentity.launch?: { command, args[] }`                                                                                | what provider `"acp"` spawns; settable on create, `PATCH` with `null` clears it. No env vars (never store secrets) |
| `AgentEvent` gains `{ type: "plan", entries: { content, status: "pending" \| "in_progress" \| "completed", priority? }[] }` | ACP `plan` updates; each event replaces the previous plan                                                          |
| `turn.completed.usage?: { inputTokens, outputTokens, costUSD? }`                                                            | what a turn cost (Claude Code result, OpenCode assistant message)                                                  |
| `TaskID` (`tsk_`), `TaskStatus`, `Task`, `TaskReview`, `AgentMessageID` (`amg_`), `AgentMessage`                            | orchestration (below)                                                                                              |
| `AgentSessionInfo.taskID?`, `AgentSessionInfo.workingDirectory?`                                                            | a task's session and where it runs (the task's worktree)                                                           |
| events `agenthq.task.updated { task }`, `agenthq.task.removed { id }`, `agenthq.message { message }`                        | in the same `AgentHQ.Event.Definitions` inventory, so no manifest edit                                             |

## ACP adapter (`src/agenthq/providers/acp.ts`)

Client side of `@agentclientprotocol/sdk` over the agent's stdio. The process is spawned with the existing
`ChildProcessSpawner` in its own process group (killed as a group on close, SIGKILL after 3 s); cwd is the
identity's `workingDirectory ?? projectDirectory`.

- `initialize` advertises **no** client capabilities (`fs.readTextFile/writeTextFile: false`, `terminal: false`):
  the agent does its own file and shell work and must ask through `session/request_permission`.
- `session/new` per Agent HQ session (`providerSessionID` = ACP `sessionId`, `mcpServers` carries the
  Workbench MCP server since wave 3). Resume after a restart or crash: `session/resume` when advertised, else `session/load` with
  its replayed updates suppressed, else 409.
- Turns: `session/prompt`; one prompt at a time per session (later messages queue behind it).
- Mapping: `agent_message_chunk` → `message.delta` (`messageID` = ACP `messageId`, or a generated id per text
  block), completed text → `message` when a tool/plan/permission update or the turn end arrives;
  `agent_thought_chunk` → `reasoning`; `tool_call`/`tool_call_update` → `tool` (`pending` → started,
  `in_progress` → running, `completed`, `failed` → error; `tool` = ACP `kind`, output preview from text content or
  `rawOutput`); diff content → `file.changed`; `plan` → `plan`; prompt result → `turn.completed { stopReason }`
  (ACP stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`; `cancelled` → status `cancelled`).
- Permissions: each request becomes `permission.requested` with the agent's own options (`id` = ACP `optionId`,
  `kind` passes through: `allow_once`, `allow_always`, `reject_once`, `reject_always`); the request id is
  `acp_<n>_<toolCallId>`. Only `POST .../permissions/:requestID` answers it; `permission.resolved` is `allowed` for
  `allow_*`, `rejected` for `reject_*`.
- Cancel: `session/cancel`, and every parked permission request is answered `cancelled` (as ACP requires).
- Agent exit or a closed stream: `error` (exit code + stderr tail) then `status: disconnected`. The manager drops
  the dead handle on `disconnected`, so the next message starts a new process and reattaches.

Providers using it:

- `cursor`: launches `cursor-agent acp` only when detection finds an `acp` command in `cursor-agent --help`;
  until then `available: false` with `cursor-agent 2025.09.12 has no ACP mode; update cursor-agent` and starting
  a session returns 409 with that reason.
- `acp` (custom): launches `identity.launch`. Status `available: true` (per-identity command), capabilities as above.
- Future `agentkit`: if the AgentKit daemon speaks ACP it needs no new code (an `acp` identity whose `launch`
  runs it, or a `ProviderID` entry pointing `AcpProvider.make` at its binary). See the final report for a non-ACP
  bridge.

## Claude Code adapter (`src/agenthq/providers/claude-code.ts`)

`@anthropic-ai/claude-agent-sdk` **0.3.293** (exact pin, its own commit). One SDK `query()` in streaming-input
mode per Agent HQ session, so one Claude Code process serves every turn; `providerSessionID` is a UUID passed as
`sessionId` (resume passes it as `resume`).

- Runs the detected `claude` binary (`pathToClaudeCodeExecutable`), so the owner's existing login is used; the
  adapter never reads, copies or logs credentials. Its `env` is this process's environment without the opencode
  server's credentials (wave 3 follow-up).
- Isolation: `settingSources: []` (no `~/.claude` settings, hooks or CLAUDE.md), `strictMcpConfig: true` and no
  `mcpServers` option (wave 3 adds the Workbench MCP server over the SDK control channel), `cwd` = the identity's working directory.
- Permissions: `permissionMode: "default"` is set explicitly (when omitted, Claude Code may start in `auto`, where
  a classifier approves calls). Every `canUseTool` call becomes `permission.requested` (`requestID` =
  `cc_<toolUseID>`, options `allow` → allow_once, `always` → allow_always, `deny` → reject_once) and waits for
  `POST .../permissions/:requestID`. "Always" applies only Claude Code's own allow-rule suggestions, re-scoped to
  the in-memory session (never written to settings files); mode switches such as `acceptEdits` are never applied.
- Mapping: stream events → `message.delta` (`messageID` = `<api message id>-<block index>`), a finished text block
  → `message`, a finished thinking block → `reasoning`, `tool_use` → `tool started` (title = command / file path /
  pattern), `tool_result` → `tool completed|error` (+ `file.changed` for Edit/MultiEdit/Write/NotebookEdit), result
  → `turn.completed { stopReason, usage: { inputTokens, outputTokens, costUSD } }`, failed result → `error` +
  `failed`, assistant `error` field → `error`. Subagent traffic is not mapped.
- Cancel: `query.interrupt()`; parked prompts are denied; the interrupted turn's result is swallowed (matched by
  the `uuid` sent with each user message). Close: `query.close()`. Process end → `error` + `disconnected`.
- Capabilities: streaming, tool events, permission requests, cancel, resume, models (`identity.model`, e.g.
  `haiku`); `mcpTools: true` since wave 3.

Contract change (additive): `turn.completed` gains optional `usage { inputTokens, outputTokens, costUSD? }`. The
OpenCode adapter fills it from the assistant message's tokens and cost.

### The first real Claude Code session (2026-10-12, wave 2)

`SPICY_REAL_CLAUDE=1 bun test --timeout 240000 test/agenthq/claude-code.test.ts -t "REAL:"`, run once. Temp project
dir, model `haiku`, `maxTurns: 1`, `persistSession: false`, the test answers any permission request with `deny`.

```
SPICY_REAL_CLAUDE evidence {"durationMs":3069,"deltas":2,"answer":"pong","end":{"type":"turn.completed",
"stopReason":"end_turn","usage":{"inputTokens":2,"outputTokens":4,"costUSD":0.0032092}},"permissionRequests":0,"tools":0}
```

Session start to turn end 3.07 s; two streamed deltas; final text `pong`; reported cost $0.0032092 (2 input
tokens outside the cache, 4 output). Wave 3 replaced this test with the Workbench session below.

## Orchestration engine (`src/agenthq/orchestrator.ts`)

Process-global service on top of `AgentSessions`; it knows sessions only through that interface, never a
provider's internals (providers stay leaves behind `AgentProvider`). Records: `["agenthq","task",id]` and
`["agenthq","message",id]` in the JSON store. Events carry `location.directory` = the assignee's (task) or
recipient's (message) project.

### Tasks

- Create: `{ title, description?, assignee: AgentID, dependsOn?: TaskID[], isolated?: boolean }`. Status is derived
  from dependencies: all `done` → `ready`; any `failed`/`cancelled`/`blocked` → `blocked` (reason names it);
  otherwise `pending` (`reason: 'Waiting on "<title>", …'`). Unknown dependencies are 400. Changes propagate down
  dependency chains (a failure blocks every task after it; a retry that ends `done` unblocks them).
- Edit (`PATCH`, only while pending/ready/blocked/failed/cancelled): title, description (`null` clears), assignee,
  `dependsOn`, `isolated`. A dependency that would close a cycle is 400 `Dependency cycle: A → C → B → A`.
- Start (`POST .../start`, from ready/failed/cancelled once dependencies are `done`; otherwise 409 with the
  reason): an isolated task first gets a git worktree from opencode's worktree module (branch
  `task-<three-word-slug>-<4 hex>`, no slashes; under `<data>/worktree/<projectID>/`), then the assignee gets a
  new session (`taskID` set, `workingDirectory` = the worktree) whose first message is the task brief: title,
  description, completed dependencies with their summaries, and the worktree note. A setup failure leaves the
  task `failed` with the reason.
- Session → task: `turn.completed` → `review` (the worktree's changes are committed on the task branch, authored
  `<agent> (Agent HQ)`; `result.summary` = the last assistant message); session `failed`/`disconnected` →
  `failed`; `cancelled` → `cancelled`; `interrupted` (restart) → `failed` with "send it a message or start the
  task again".
- Review gate: `GET .../review` is a dry run (`TaskReview`: branch, `head` = the branch commit it describes, base =
  the project's current branch, commits, per-file additions/deletions, `clean`, `mergeable`, `reason`; conflicts
  come from `git merge-tree`; the project is not touched). It first commits the agent's leftover worktree changes
  on the task branch, unless the agent is working. `POST .../approve { head }` (only from `review`) merges exactly
  that commit: 409 while the task's session is working or has a pending permission, 409 when the branch is no
  longer at `head` after committing leftovers (the task changed since the review), 409 if the project has
  uncommitted changes to tracked files (untracked files do not count; git refuses itself if they would be
  overwritten). It runs `git merge --no-ff <head>` into the project's current branch (commit `Merge task:
  <title>`), aborts and returns 409 on any merge failure, and on success removes the worktree and branch, clears
  `worktree` from the task and marks it `done`. A task without a worktree needs no `head` and just becomes `done`
  (still refused while its agent works). Nothing else ever merges. (Since wave 3, see below.)
- Cancel: marks `cancelled` first, then cancels the running session; dependents become `blocked`. The worktree
  is kept for inspection; `DELETE` removes the task and its worktree (409 while another task depends on it).

### Agent messages

`POST /agenthq/messages { from?: AgentID | "user" | "system" (default "user"), to, text, taskID?, evidenceIDs?,
relay? }`. Delivery target: the task's session when `to` is the task's assignee, else the recipient's newest
session, else a new session titled "Messages". The text arrives as a user message headed
`Message from <sender> [about task "<title>" (<id>)]:`. `relay: true` routes the recipient's next answer back to
the sender (as a new message with `inReplyTo` and `hops + 1`, itself relaying), so two agents can hold an
exchange. Limits stop it deterministically; the stopping message is stored with `delivery: "failed"`, a `reason`
and `relay: false`, and nothing further is sent:

| Limit                                            | Reason text                                         |
| ------------------------------------------------ | --------------------------------------------------- |
| more than 6 replies in one exchange (`hops > 6`) | `Stopped: the exchange reached the 6-reply limit`   |
| 20 messages for one task                         | `Stopped: task <id> reached its 20-message limit`   |
| 10 messages from one agent within 60 s           | `Stopped: <agent> sent 10 messages within a minute` |
| a reply identical to the message it answers      | `Stopped: the reply repeats the message it answers` |

Pending relays are in memory (an exchange in flight during a restart is not resumed).

### Routes (wave 2)

| Method | Path                             | Body / query                                                | 200                                                              | Errors                                                                                     |
| ------ | -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/agenthq/tasks`                 |                                                             | `Task[]`, oldest first                                           |                                                                                            |
| POST   | `/agenthq/tasks`                 | create input above                                          | `Task`                                                           | 400, 404 (assignee)                                                                        |
| GET    | `/agenthq/tasks/:taskID`         |                                                             | `Task`                                                           | 404                                                                                        |
| PATCH  | `/agenthq/tasks/:taskID`         | edit input above                                            | `Task`                                                           | 400, 404, 409                                                                              |
| DELETE | `/agenthq/tasks/:taskID`         |                                                             | `true`                                                           | 404, 409                                                                                   |
| POST   | `/agenthq/tasks/:taskID/start`   |                                                             | `Task` (`running`, `result.sessionID`, `worktree` when isolated) | 400, 404, 409, 502                                                                         |
| POST   | `/agenthq/tasks/:taskID/cancel`  |                                                             | `Task`                                                           | 404                                                                                        |
| GET    | `/agenthq/tasks/:taskID/review`  |                                                             | `TaskReview`                                                     | 404                                                                                        |
| POST   | `/agenthq/tasks/:taskID/approve` | `{ head? }` (the review's `head`; required with a worktree) | `Task` (`done`)                                                  | 404, 409 (not in review, agent working, changed since review, dirty project, merge failed) |
| GET    | `/agenthq/messages`              | `?taskID=&agentID=` (agentID matches sender or recipient)   | `AgentMessage[]`, oldest first                                   |                                                                                            |
| POST   | `/agenthq/messages`              | send input above                                            | `AgentMessage` (`delivered`, or `failed` + `reason`)             | 400, 404                                                                                   |

409 bodies are `{"_tag":"ConflictError","message":"<reason>"}`; the rest as in wave 1.

### Future `agentkit` provider

Agent HQ owns orchestration; AgentKit (the ProjectBlaze daemon) is only ever a provider. If it speaks ACP it
works today as a custom `acp` identity (`launch` = its command), or as a dedicated `ProviderID` entry pointing
`AcpProvider.make` at its binary. A non-ACP bridge needs one `AgentProvider.Interface` implementation:
create/resume a daemon session and return its id, send a prompt, cancel, answer permission prompts (surfacing
them as `permission.requested`, never auto-approving), close, and stream its activity as normalized
`AgentEvent`s through `emit`; its own task store stays internal to it.

## Tests (wave 2)

| Test                                                            | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AHQ-08 (`test/agenthq/acp.test.ts`)                             | Real `opencode acp` from this tree (isolated HOME/XDG via a launcher script, fake model server), driven only through HTTP: create `acp` identity → start session → message → streamed reply with a `bash` tool → `permission.requested` (allow_once/allow_always/reject_once) → answered via `POST /agenthq/sessions/:id/permissions/:requestID` → tool completed with output → `message` + `turn.completed end_turn`; second turn hangs → `POST .../cancel` → `cancelled`, no extra `turn.completed`; `DELETE` the identity → the agent's process is gone (`pgrep`)                                                                                                                                                                                          |
| AHQ-08b (`test/agenthq/agenthq.test.ts`)                        | Scripted ACP agent (`test/fixture/agenthq/fake-acp-agent.ts`): `plan`, thought → `reasoning`, text completed before the tool, diff → `file.changed`, `reject_always` option and invalid option (400-class error), crash → `error` with exit code and stderr + `disconnected`, next message reattaches with `session/load` and the replay is not recorded                                                                                                                                                                                                                                                                                                                                                                                                      |
| AHQ-07 (updated)                                                | Cursor with an ACP-capable `cursor-agent` reports available with ACP capabilities; the manager lists five providers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AHQ-09 (`test/agenthq/claude-code.test.ts`, scripted SDK)       | Isolation options (binary, `settingSources: []`, `strictMcpConfig`, `mcpServers: {}`, `permissionMode: "default"`, own `sessionId`, no bypass flag); streamed text/thinking emitted once with usage on `turn.completed`; a prompt parks until answered, `always` re-scoped to the session and mode switches dropped; deny path; cancel interrupts quietly and the session keeps working; crash → `disconnected` and later sends fail; close; resume passes `resume`; unavailable → typed error                                                                                                                                                                                                                                                                |
| AHQ-09 real (opt-in)                                            | One real session through the installed `claude`, evidence above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Orchestration (`test/agenthq/orchestrator.test.ts`, fake model) | Dependency ordering (start refused with the waiting reason, review is not done, approving unblocks the dependent, the brief carries the dependency's summary); cycle rejection (`A → C → B → A`, self, unknown dependency); worktree isolation (two isolated tasks write the same file in separate worktrees, the project is untouched, the dry run lists the file and commit); review gate (a dirty project is refused and left untouched, approve merges `Merge task: …` and removes the worktree, the now-conflicting second branch is reported by the dry run and refused with the merge aborted); hop-limit stop (exactly 7 model calls, 8 messages, the 8th failed with the reason, nothing after); cancellation (session cancelled, dependent blocked) |

Results on the final tree (from `packages/opencode`, `SPICY_REAL_CLAUDE` unset):

| Command                                             | Result                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `bun test --timeout 120000 test/agenthq`            | 25 pass, 1 skip (the opt-in real Claude session, reason in its name), 0 fail |
| `bun test --timeout 30000 test/server test/session` | 716 pass, 9 skip, 1 todo (pre-existing), 0 fail                              |
| `bun run test:httpapi`                              | 231 pass, 0 fail, 0 missing in coverage, auth and effect modes               |
| `bun run typecheck`                                 | clean                                                                        |

Upstream-owned edits in wave 2: `server.ts` gains one more import and `AgentOrchestrator.node` in the `app` group
(both `// spicy:`); everything else is in fork-owned files (`src/agenthq/**`, the Agent HQ group/handlers, the
`agenthq` exercise scenario file, `test/agenthq/**`, `test/fixture/agenthq/**`). `packages/opencode/package.json` and
`bun.lock` gain `@anthropic-ai/claude-agent-sdk` 0.3.293.

# Wave 3

## Late delta after cancel (fixed for every provider)

Desktop smoke history: seq 65 `message` "Paragraph 1: this ", seq 66 `status cancelled`, seq 67 `message.delta`
"this ", rendered as "Paragraph 1: this this".

Root cause, in the session manager rather than a provider: the consumer took a delta-only batch from the queue
and waited `DELTA_LINGER` (40 ms) to coalesce it, outside the session lock. `cancel` took the lock in that window,
called `handle.cancel` (the OpenCode adapter then emits the aborted part's final text as `message`), drained the
queue, and recorded `message` + `cancelled`. The consumer then recorded the delta it was holding.

Fix, in `src/agenthq/session.ts`, which every provider goes through:

- One writer per session. Manager events (user message + `working`, a send failure, cancel, restart recovery)
  are queued behind the provider's output and the caller waits until they are recorded, so nothing taken from
  the queue can be overtaken. `GET` reads between recorded batches.
- Stale output is dropped when recorded: more text for a message that already has its final `message` (the first
  final text wins), updates for a tool that already completed or failed, and turn output (`message.delta`,
  `message`, `reasoning`, `tool`, `plan`, `file.changed`, `turn.completed`) when no turn is owed. Each user
  message owes one turn; `turn.completed` or `failed` closes one; `cancelled`, `disconnected` and `interrupted`
  close all. The finished-message and finished-tool sets are per turn, because some models number tool calls per
  turn (the fake model reuses `call_1`).
- A turn that ends (`turn.completed` or a non-active status) first answers its open permission requests
  `cancelled`, so nothing waits on a finished turn. A cancel with no active turn still records nothing.
- History compaction (a final `message` replaces its deltas, a `tool` keeps its latest state) stays within the
  current turn, so an earlier turn's tool with a reused call id is kept.
- ACP adapter: text that resumes under an ACP `messageId` whose text was already completed gets a segment id
  (`<id>-<n>`), so each completed message keeps its own text instead of being dropped as a repeat.

## Session title (fixed)

Root cause: the OpenCode adapter never forwarded the title opencode generates for its session, so the Agent HQ
session kept "Untitled session" although the title request was answered. Fix: a new `title` event. The OpenCode
adapter emits it on `session.updated` for its own session when the title changed and is not a default
placeholder; the ACP adapter maps `session_info_update.title`; the manager stores it in `AgentSessionInfo.title`,
which reaches clients through `agenthq.session.updated` like any other change.

## Contract change (additive, `packages/schema/src/agent-hq.ts`)

| Change                                                | Why                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `AgentEvent` gains `{ type: "title", title: string }` | the provider named the session; clients may ignore it (see above) |

Semantics clients can rely on now: after a message's final `message` no more deltas arrive for it in that turn,
and after `status: cancelled` no turn output is recorded until the next user message.

## Workbench MCP bridge for external agents

Claude Code and ACP agents (custom `acp` identities and Cursor) get exactly one MCP server, `opencode-workbench`:
`opencode workbench mcp --url <server> --directory <dir>` (`src/agenthq/workbench.ts`).

- Command: this same opencode. A compiled binary runs itself (`process.execPath`); from source it is Bun with
  this tree's `src/index.ts` (as AHQ-08 launches `opencode acp`); a Node build (the desktop's utility-process
  sidecar) only when `OPENCODE_BIN_PATH` names an opencode CLI, otherwise no server is given.
- `--url`: this process's listener (`Server.url`; a wildcard host becomes `127.0.0.1`). No listener (in-process
  use) means no server. `--directory`: the session's working directory, so a task's worktree for isolated tasks.
- Credentials: when the server has a password, `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` in the
  MCP server's `env`, and nothing else. Arguments carry only the URL and directory; nothing is stored.
- Claude Code: `query.setMcpServers(...)` over the SDK control channel (stdin), awaited (up to 15 s) before the
  session is returned. Not `options.mcpServers`: SDK 0.3.293 passes that as `--mcp-config <json>` on the claude
  command line (`sdk.mjs`), where the password would be visible to other processes. A failed connect becomes an
  `error` event with the password masked, and the session goes on without the tools.
- ACP: the stdio entry in `session/new`, `session/resume` and `session/load`. `opencode acp` registers it as a
  local MCP server held in memory only (`sdk.mcp.add`), and its tools appear as `opencode-workbench_workbench_*`.
- Permissions: unchanged. Each tool call goes through the agent's own permission flow and reaches Agent HQ as
  `permission.requested`, never auto-approved; `workbench_check` still sends trigger `agent`, so `verify.exec`
  still gates checks that run project code.
- Capabilities: `mcpTools: true` for `claude-code`, `acp` and `cursor`.

Limits:

- Verified on the real binary (Claude Code 2.1.296, below): `setMcpServers` under `--strict-mcp-config` connects
  the Workbench server, lists its tools, and Claude calls them.
- Claude Code defers the Workbench tools behind its tool search: the model calls `ToolSearch` first, which costs a
  turn. `alwaysLoad: true` on the server config would put all 15 tool definitions in every prompt instead and make
  the first turn wait for the connection (up to 5 s). Not set; a product choice.
- Claude Code hands the model the tool's `structuredContent` (the doctor report as JSON), not the text summary.
- After merging with `spicy-ide` (`97cca65c9`), `opencode workbench mcp` also serves the `debug_*` tools, so
  external agents get them through the same server.

### The second real Claude Code session (2026-10-12, wave 3)

Approved by the owner to check the Workbench server in a real session. Test:
`SPICY_REAL_CLAUDE=1 bun test --timeout 300000 test/agenthq/claude-code.test.ts -t "REAL:"`, run once. A
password-protected listener (`test/fixture/agenthq/listener.ts`, as in AHQ-08) is running, so the bridge comes from
`AgentWorkbench.server(dir)` exactly as the manager builds it; the session is the adapter's, through the installed
`claude` with the owner's login, model `haiku`, `maxTurns: 3`, `persistSession: false`. The test allows the doctor
once (standing in for the human) and denies anything else. `SPICY_REAL_CLAUDE=status` runs everything before the
prompt and nothing reaches the model; it ran twice while the test was written.

Before the prompt (`mcpServerStatus()`, no model call):

```
{"connectMs":1884,"firstStatus":"connected","server":{"name":"opencode-workbench","status":"connected",
"source":"dynamic","serverInfo":{"name":"opencode-workbench","version":"local"}},
"tools":["workbench_problems","workbench_check","workbench_doctor","debug_start","debug_attach","debug_control",
"debug_breakpoints","debug_inspect","debug_evaluate","debug_output","debug_status","debug_stop","debug_note",
"debug_escalate","debug_resume"],"claudeFound":true,"claudeStrict":true,"claudeMcpConfigArg":false,
"claudeHasPassword":false,"bridgeFound":true,"bridgeArgsHavePassword":false,"bridgeEnvHasPassword":true,
"bridgeGotClaudeEnv":true}
```

- `setMcpServers` returns after the server connected: the first status read right after the session started was
  already `connected` (session start including the claude process: 1.9 s).
- The claude command line has `--strict-mcp-config` and no `--mcp-config`; its environment has no server password.
  The bridge's arguments have no password; its environment has it, plus claude's whole environment.

The prompt ("Call the mcp**opencode-workbench**workbench_doctor tool exactly once with no arguments, then reply
with exactly: done"):

- `ToolSearch` started and completed without a permission prompt (the Workbench tools are deferred).
- `permission.requested` for `mcp__opencode-workbench__workbench_doctor`, answered allow once, `permission.resolved`
  `allowed`.
- The tool completed; its output (the doctor report JSON, starting with Swift: `sourcekit-lsp`, `swiftc` 6.4) came
  back to the model.
- One streamed delta, final text `done`, `turn.completed` `end_turn`, 5.0 s from session start.
- Cost: $0.00432649 (6 input tokens outside the cache, 186 output).

Afterwards: no bridge process left, no project written under `~/.claude/projects`, no new DiagnosticReports.

## Approve merges exactly what the human reviewed (wave 3 follow-up)

The bug: approve committed whatever was in the worktree at that moment and merged whatever the branch pointed at.
A message to a task in `review` starts a new turn in its session, so commits made after the human's dry run, or
a half-finished turn, could be merged unreviewed.

The rule, in `src/agenthq/orchestrator.ts`:

- `GET .../review` commits the agent's leftovers first (never mid-turn) and reports the branch commit it
  describes as `head`. Its commits, files and merge check are computed against `head`, not the branch name.
  While the session works or waits on a permission it reports `mergeable: false` with "The agent is still
  working; review again when it finishes".
- `POST .../approve` takes `{ head }`. It refuses with 409 "The agent is still working; review again when it
  finishes" while the session is active (`starting`, `thinking`, `working`, `needs_approval`, `blocked`) or has a
  pending permission, and with 409 "The task changed since you reviewed it; review again" when, after committing
  leftovers, the branch is not at `head` (or `head` is missing for a task with a worktree). It merges the commit
  `head` itself, so nothing newer than the review can land even inside the lock.
- After a merge the saved task has no `worktree`.

Contract (additive): `TaskReview.head?: string`; the approve route gains the payload `{ head?: string }`.

App (minimal): `approveTask(id, head)` in `packages/app/src/workbench/client.ts`, `approve(id, head)` in
`packages/app/src/agenthq/tasks.ts` (the store between the panel and the client), and the panel passes the head of
the review on screen. A 409 shows verbatim and "Check again" reloads the review.

## Agent processes never get the server's credentials (wave 3 follow-up)

`AgentProvider.agentEnv()` (`src/agenthq/provider.ts`) is the environment for every process a provider spawns:
this process's environment without `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`. The Claude Code SDK
spawn (`options.env`, which replaces the subprocess environment), every ACP spawn (custom `acp` identities and
Cursor) and the detection probes (`--version`, `--help`) use it. Only the Workbench MCP server gets the credentials,
through its own `env`.

ACP children additionally get a fresh `OPENCODE_SERVER_PASSWORD` (`crypto.randomUUID()`): an agent that is opencode
itself (`opencode acp`) starts its own TCP listener, which stays authenticated that way without sharing this
server's password. Other agents ignore the variable. The Workbench MCP server an ACP agent starts still gets this
server's credentials, because its `env` entries override the agent's own environment.

Where the real boundary is: stripping the variables only closes the trivial path (`env | grep` in an approved shell
command). A process running as the same user with approved shell access can still read the bridge's environment
(`ps -E` shows it for any non-platform process of that user, which AHQ-08 relies on) and the opencode data
directory. The real control is the human approving each shell command. OpenCode's own sessions (provider
`opencode`) run in this process, and their shell tool keeps the upstream behavior of passing the whole environment.

Desktop (`packages/desktop`): the v1 sidecar runs the server under Node, which has no CLI of its own, so
`createSidecarEnv()` (`src/main/server.ts`) now sets `OPENCODE_BIN_PATH` to the bundled CLI when it exists.
`src/main/bundled-cli.ts` holds the lookup that `background-cli.ts` already used (`executableName()`, the app's
resources when packaged, this tree's `resources/` in development), and `background-cli.ts` now calls it. The v2
sidecar runs the compiled CLI and needs nothing. Covered by `src/main/bundled-cli.test.ts`; the desktop smoke can
cover the running app later.

## Tests (wave 3)

| Test                                                 | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AHQ-11 (`test/agenthq/agenthq.test.ts`, fake model)  | The desktop race: the model streams "Paragraph 1: " then "this " and hangs; cancel lands right after the "this " delta is published. No turn output after `cancelled`, no delta after the final text, and a client rebuilding text renders "Paragraph 1: this ". Failed 5 of 5 before the fix, 0 of 10 after                                                                                                                                                     |
| AHQ-11b (scripted ACP agent, script `late`)          | Late output after the turn ended (a chunk for the finished message, a tool update 30 ms later) is dropped for a non-OpenCode provider                                                                                                                                                                                                                                                                                                                            |
| AHQ-12                                               | The fake model answers the title request "E2E Title"; the Agent HQ session's title becomes it. Failed before the fix                                                                                                                                                                                                                                                                                                                                             |
| AHQ-03 (extended)                                    | A second turn's tool call reuses `call_1`: it is recorded, and the history keeps both turns' tool entries. Failed before the per-turn fix                                                                                                                                                                                                                                                                                                                        |
| AHQ-09 (scripted SDK, 2 new)                         | No MCP option or secret in the options that become the claude command line; `setMcpServers` gets exactly `opencode-workbench` (stdio, command, args with URL and directory, env with the two credentials) before the session is returned, and again on resume; a failed connect is an `error` event with the password masked                                                                                                                                     |
| AHQ-08 (now through a real listener with a password) | Unauthenticated request refused (401); the model is offered `opencode-workbench_workbench_problems`, `_check` and `_doctor`; a `workbench_problems` call raises `permission.requested` and does not run until allowed through the route; it then returns the listener's counts ("0 errors, 0 warnings, 0 info, 0 hints") through the bridge; the bridge's command line has `--directory <dir>` and no password; the bridge is gone after the identity is removed |

Results on the final tree (from `packages/opencode`, `SPICY_REAL_CLAUDE` unset):

| Command                                             | Result                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun test --timeout 120000 test/agenthq`            | 30 pass, 1 skip (the opt-in real Claude session), 0 fail                                                                                                                                                                                                                                                                                   |
| `bun test --timeout 30000 test/server test/session` | 719 pass, 9 skip, 1 todo (pre-existing), 0 fail                                                                                                                                                                                                                                                                                            |
| `bun run test:httpapi`                              | coverage and auth modes 255/255 in all three runs; effect mode 253, 254, 254, each time a different upstream scenario timing out at 30 s (`session.diff` and `session.prompt`; `project.update.missing`; `v2.provider.get`) at load averages of 24 to 54; all four pass alone in effect mode; every `agenthq` scenario passed in every run |
| `bun run typecheck`                                 | clean                                                                                                                                                                                                                                                                                                                                      |

`test/server/httpapi-v2-pty.test.ts` ("retains exited sessions") is a load-sensitive upstream flake: run interleaved
20 times each, it failed once on the base (`fe1c8528b`) and once on this branch, both with the PTY still `running`
after 20 s.

Follow-up tests:

| Test                            | What it proves                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AHQ-09 (scripted SDK)           | With `OPENCODE_SERVER_USERNAME/PASSWORD` set in this process, the claude spawn's `env` has neither key and keeps the rest (`PATH`); the bridge config still carries the credentials. Fails without the change (no `env` option)                                                                                                                                                                            |
| AHQ-08                          | The real `opencode acp` child's environment (`ps -E` on macOS, `/proc/<pid>/environ` on Linux) has a UUID `OPENCODE_SERVER_PASSWORD`, no `OPENCODE_SERVER_USERNAME`, and nothing of the parent's password; its own listener (given a free `--port`) answers 401 without credentials and 401 with the parent's password, and 200 with its own. Without the change the child inherited the parent's password |
| `bundled-cli.test.ts` (desktop) | A packaged app gets `OPENCODE_BIN_PATH` set to `<resources>/opencode-cli` only when that file exists; in development the CLI is looked up in `packages/desktop/resources`                                                                                                                                                                                                                                  |

Upstream-owned edits (wave 3 follow-up, each marked `// spicy:`): `packages/desktop/src/main/server.ts` (one import,
one line in `createSidecarEnv()`), `packages/desktop/src/main/background-cli.ts` (imports `bundledCli` and
`executableName` from the new `bundled-cli.ts` instead of defining them). No upstream files were edited in wave 3
itself.

Approve fix tests (from `packages/opencode` unless noted):

| Test                                                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator.test.ts` "approve merges exactly the reviewed commit" | After the review, a message to the task starts a turn that asks for permission: approve with the reviewed head is 409 "still working" and the review says so. The turn then adds `extra.txt`: approve with the old head is 409 "changed since you reviewed it", the project is untouched and the task stays in review. Reviewed again, the new head merges (`HEAD^2` is that commit, both files land) and the task has no `worktree`. Fails on the old orchestrator |
| `orchestrator.test.ts` isolated tasks (updated)                     | `head` is the branch commit, approve with it merges it (`HEAD^2`), the record drops `worktree`; a dirty project and a conflicting branch are still refused                                                                                                                                                                                                                                                                                                          |
| `packages/app` `tasks.test.ts`                                      | `approve(id, head)` passes the head to `approveTask`                                                                                                                                                                                                                                                                                                                                                                                                                |

# Wave 4: data safety for Agent HQ records

Found by the desktop smoke: an unreadable session history became `[]` and restart recovery then wrote over it, and
writes were not atomic, so a crash mid-write could tear a history.

## One store for Agent HQ's records (`src/agenthq/store.ts`)

Identities, sessions, histories, tasks and messages went through upstream's `Storage` service, whose `write`
rewrites the file in place. Rather than change that for everyone, Agent HQ now uses its own `AgentStore` service
over the same layout (`<data>/storage/<key>.json`, same JSON formatting), so existing records keep working and tests
or tools that read them through `Storage` still do.

- Writes go to `<file>.tmp-<pid>-<n>` in the same directory and are renamed over the record. A crash before the
  rename leaves the previous record whole and a stray `.tmp-*` file, which is not a record (`list` only returns
  `*.json`) and is left in place. No fsync, as before.
- Reads tell a missing record from a corrupt one: not valid JSON, or not the expected shape. A record that does not
  decode is treated as corrupt even when the JSON is fine, for example one written by a newer build. A read error
  such as a permission problem is neither.
- A corrupt record is never overwritten. It is renamed to `<file>.corrupt-<ms>` and logged (`agenthq moved an
unreadable record aside`, with the file and the reason). Renaming it back restores it.
  - Identity, task, message and session records: moved aside on the first read and treated as missing from then on.
  - Session history: moved aside by the process that drives the session, when it loads it (restart recovery, a
    message, cancel, a permission answer, or a `GET` of a session it owns). The session then records an `error`
    ("This session's history could not be read (it is not valid JSON); it was quarantined as
    `<id>.json.corrupt-<ms>`") and `status: interrupted`. Its new history starts with those two events, with `seq`
    from 0. A `GET` of a session another live process drives shows an empty history and moves nothing. A read
    error fails the load, so nothing is recorded over a history that could not be read.
- The registry's identity edit used `Storage.update`'s per-key lock; it now merges into the stored record (keeping
  fields this build does not know) under a per-identity lock.

## Tests (wave 4)

| Test    | What it proves                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AHQ-13  | A session is mid-turn when the server stops; its record says `working` and its history file is torn (invalid JSON). After a restart the session is `interrupted` with the quarantine error, the torn file is kept byte for byte as `<id>.json.corrupt-<ms>`, and the history (in memory and on disk) holds only the `error` and `status` events of the recovery. Fails with the previous session manager |
| AHQ-13b | An identity record that does not decode is not returned by `get` or `list` and is moved aside as `.corrupt-*`                                                                                                                                                                                                                                                                                            |
| AHQ-14  | A write killed after its temporary file and before the rename (simulated by writing the temporary file and skipping the rename) leaves the record at its previous version, and the temporary file is not listed. A completed write then replaces the record and leaves no temporary file of its own                                                                                                      |

Results (from `packages/opencode`): `bun test --timeout 120000 test/agenthq` 35 pass, 1 skip (the opt-in real
Claude session), 0 fail; `bun test --timeout 30000 test/server test/session` 720 pass, 9 skip, 1 todo, 0 fail;
`bun run test:httpapi` 258/258 in coverage, auth and effect modes; `bun run typecheck` clean.

No upstream-owned files were edited in wave 4.

# Wave 5: Codex through Zed's ACP bridge; Cursor stays unavailable

## Codex (`AgentDetect.codex`, `src/agenthq/providers/detect.ts`)

Codex has no ACP mode of its own (codex-cli 0.162.1 has `app-server`, experimental), so Agent HQ runs Zed's bridge
through the generic ACP adapter: `codex-acp` from PATH if present, else `npx -y @zed-industries/codex-acp@0.16.0`
(pinned exactly; nothing is installed globally). The bridge embeds Codex's own crates (`rust-v0.137.0`) and uses the
owner's Codex login and config; Agent HQ never reads `~/.codex`.

- Status: `codex` on PATH and `codex --version` → version; `codex login status` (exit code only, its output is not
  kept) → `auth: "ok"`, otherwise `available: false`, `auth: "required"`, "Codex is not logged in; run `codex
login`". Without `codex-acp` or `npx` on PATH: "Codex needs Zed's codex-acp bridge: put codex-acp or npx on PATH".
- Approvals always reach the human. The bridge turns Codex's approval requests into ACP `session/request_permission`
  (commands: approve, approve for the session, deny, abort and Codex's exec-policy and network choices; edits: approve
  or abort; MCP tool calls: approve once, for the session, always, or cancel), which Agent HQ surfaces as
  `permission.requested` and never answers itself. What Codex asks about is its approval policy, so Agent HQ sets it
  explicitly on the bridge's command line, whatever `~/.codex/config.toml` says:
  - `-c approval_policy="untrusted"`: Codex asks before anything but known-safe read-only commands, and before every
    edit. Its default, `on-request`, lets the model decide and applies workspace edits without asking.
  - `-c sandbox_mode="workspace-write"`: what is approved still runs in Codex's sandbox.
  - `-c approvals_reviewer="user"`: approvals go to the human, never to Codex's automatic reviewer
    (`guardian_subagent`).
- Agent HQ never calls `session/set_mode`. The bridge's modes are `read-only`, `auto` (`on-request`) and
  `full-access` (`never`, no sandbox), and choosing `auto` or `full-access` also marks the project trusted in
  `~/.codex`. With `untrusted` the bridge reports no current mode, so `session/new` returns no `modes`, only a
  `model` config option.
- "Always" choices are Codex's own; an exec-policy amendment can persist in `~/.codex`.
- The Workbench MCP server goes in `session/new` as for every ACP agent. The bridge gets no server credentials
  (only a fresh password of its own, as every ACP child).
- Capabilities: the ACP adapter's (streaming, tool events, permission requests, cancel, MCP tools); the bridge
  advertises `loadSession` and `session/resume`, which the adapter uses to resume.
- Upstream moved the bridge to `agentclientprotocol/codex-acp` (npm `@agentclientprotocol/codex-acp`); the
  `@zed-industries` package is archived at 0.16.0, which is what is pinned (see below for why not 2.2.2).

### Why not `@agentclientprotocol/codex-acp` 2.2.2 (checked 2026-10-12)

The maintained bridge cannot run Codex under `untrusted`, so Agent HQ stays on the archived 0.16.0. From its v2.2.2
source:

- It is a Node rewrite that drives `codex app-server`. It ignores command-line arguments other than `--version`,
  `login` and `cli` (`src/index.ts` starts the ACP server without reading `process.argv`), so the three `-c`
  overrides are dropped. Configuration comes from the `CODEX_CONFIG` (JSON) and `INITIAL_AGENT_MODE` environment
  variables.
- Every turn sends the session's agent mode as `approvalPolicy`, `approvalsReviewer` and `sandboxPolicy`
  (`CodexAcpClient.sendPrompt`), which overrides any configured policy. The modes (`src/AgentMode.ts`) are
  `read-only` (`on-request`, reviewer `user`, read-only sandbox), `workspace-write` (`on-request`, `user`,
  workspace-write), `agent` (`on-request`, reviewer `auto_review`, workspace-write) and `agent-full-access`
  (`never`, no sandbox).
- The default mode is `agent`, which sends approvals to Codex's automatic reviewer instead of the human. The best it
  allows is `INITIAL_AGENT_MODE=workspace-write`: the reviewer is the human, but `on-request` still applies edits
  inside the workspace and runs sandboxed commands without asking.

To move to it, it would need a mode that sends `untrusted`, or one that honours a configured approval policy.

## Cursor

Unavailable, with the reason "Cursor's CLI has no ACP mode; Agent HQ needs approvals routed to you". Even
cursor-agent 2026.10.01 has no ACP subcommand, and its headless mode runs tools without asking. Detection still looks
for an `acp` command, so a future ACP mode would be picked up.

## Free real check (`SPICY_REAL_CODEX=status`)

`SPICY_REAL_CODEX=status bun test --timeout 300000 test/agenthq/codex.test.ts -t "REAL:"` runs the pinned bridge
through npx (one download), `initialize`, and one `session/new` in a temp git repo with the Workbench MCP server of a
password-protected listener. It never sends a prompt. For this check only, the bridge also gets
`-c cli_auth_credentials_store="file" -c mcp_oauth_credentials_store="file"`, so it cannot touch the keychain. It
stops the whole process tree (npx, bridge, Workbench server) afterwards. Run twice on 2026-10-12, second time to
check the cleanup:

```
{"status":{"available":true,"auth":"ok","version":"0.162.1"},
 "launch":{"command":"npx","args":["-y","@zed-industries/codex-acp@0.16.0","-c","approval_policy=\"untrusted\"",
   "-c","sandbox_mode=\"workspace-write\"","-c","approvals_reviewer=\"user\""]},
 "protocolVersion":1,"agentInfo":{"name":"codex-acp","title":"Codex","version":"0.16.0"},
 "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
   "mcpCapabilities":{"http":true,"sse":false,"acp":false},"sessionCapabilities":{"list":{},"resume":{},"close":{}},
   "auth":{"logout":{}}},
 "authMethods":["chatgpt","codex-api-key","openai-api-key"],"sessionCreated":true,"configOptions":["model"],
 "updates":["available_commands_update"]}
```

No `modes` came back. That fits the bridge running under `untrusted`, which matches none of its presets: under the
default `on-request` it would report `auto`. Each run likely leaves one empty session in the owner's Codex history.

An earlier test (`agenthq-http.test.ts`) created a `codex` identity to check the 409 for an unsupported provider. Once
Codex became a real provider, two runs of the suite on this machine started real Codex sessions (`session/new` only,
no prompt) before I changed that test to an `acp` identity without a launch command, which can never start. No
regular test now starts a real provider.

## Tests (wave 5)

| Test                                                                     | What it proves                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex.test.ts` detection (fake `codex` on a temp PATH)                  | Available with `auth: "ok"` and version `0.162.1` only when logged in and a bridge can run; `auth: "required"` with the login reason; the bridge reason; "codex not found on PATH"                                                                                                                                               |
| `codex.test.ts` command line (fake `npx` running the scripted ACP agent) | Agent HQ spawns `npx -y @zed-industries/codex-acp@0.16.0 -c approval_policy="untrusted" -c sandbox_mode="workspace-write" -c approvals_reviewer="user"`; no secret in the arguments; the bridge's own `OPENCODE_SERVER_PASSWORD` is a fresh UUID, not this server's; `session/new` gets the cwd and exactly the Workbench server |
| `codex.test.ts`                                                          | `codex-acp` on PATH wins over npx, with the same policy                                                                                                                                                                                                                                                                          |
| AHQ-07 (updated)                                                         | Cursor's reason; an unavailable provider fails with a typed error and leaves no session                                                                                                                                                                                                                                          |
| `agenthq-http.test.ts` (updated)                                         | The 409 mapping, with a provider that cannot start anywhere                                                                                                                                                                                                                                                                      |

Results (from `packages/opencode`): `bun test --timeout 120000 test/agenthq` 38 pass, 2 skip (the opt-in real Claude
and real Codex checks), 0 fail; `bun test --timeout 30000 test/server test/session` 720 pass, 9 skip, 1 todo, 0 fail;
`bun run typecheck` clean.

No upstream-owned files were edited in wave 5.

# Wave 6: AgentKit through the ACP adapter

`agentkit` is a provider (additive: `ProviderID` gains `"agentkit"` in `packages/schema/src/agent-hq.ts`). It runs
`agentkit-bridge acp`, the ACP mode the session that owns OpenCode Native's AgentKitBridge is adding, through the
generic ACP adapter, so it gets everything every ACP agent gets:

- this server's credentials stripped plus a fresh password of its own;
- the process group killed on close;
- the Workbench MCP server in `session/new`;
- permission requests surfaced as `permission.requested` and never answered by Agent HQ;
- the stale-output and cancel rules of the session manager.

- Binary: an identity's `launch.command` (the existing per-identity launch override, settable through the API)
  replaces the bridge, and Agent HQ always runs it with `acp`; otherwise `agentkit-bridge` from PATH. Nothing is
  hardcoded yet; the bridge's install location comes from the coordinator once it exists.
- Status (`AgentDetect.agentkit`): available when `agentkit-bridge` on PATH answers `acp --help` with exit 0 and output
  that names `acp`. Otherwise "AgentKit bridge not found", or "this AgentKit bridge has no ACP mode yet". Starting a
  session without the bridge or a launch command fails with that reason. To adjust once the bridge's real `--help`
  output is known.

## Tests (wave 6)

| Test                                                                                     | What it proves                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentkit.test.ts` detection (fake `agentkit-bridge` on a temp PATH)                     | Available with an ACP mode; "this AgentKit bridge has no ACP mode yet" when `acp` is an unknown command; "AgentKit bridge not found" when missing, and a session cannot start then                                                                                          |
| AHQ-15 (scripted ACP agent behind a fake `agentkit-bridge`, through the session manager) | Under the `agentkit` provider: a streamed reply; a diff becomes `file.changed` (what review picks up); a permission request waits (`needs_approval`) and the human's answer reaches the agent; cancel records `cancelled`, and what the agent says after it is not recorded |
| `agentkit.test.ts` real check (`SPICY_REAL_AGENTKIT=status`)                             | `initialize` and one `session/new` with the Workbench MCP server against the real bridge, never a prompt. Skipped, with "no agentkit-bridge on PATH yet" in its name, until the bridge is installed                                                                         |
| AHQ-07 (updated)                                                                         | Six providers, one `provider.updated` each                                                                                                                                                                                                                                  |

The scripted ACP agent gained a `hang` script (it says "working", waits for `session/cancel`, then talks after it).

Results (from `packages/opencode`):

| Command                                             | Result                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test --timeout 120000 test/agenthq`            | 40 pass, 3 skip (the opt-in real Claude, Codex and AgentKit checks), 0 fail                                                              |
| `bun test --timeout 30000 test/server test/session` | 721 pass, 9 skip, 1 todo, 1 fail: the upstream `httpapi-v2-pty` timing flake at a load average of 16; it passed 3 of 3 alone right after |
| `bun run typecheck`                                 | clean                                                                                                                                    |

`packages/app` typecheck only reports `@codemirror/state` as missing, because this worktree's `node_modules` predates the
editor's dependencies. The new `ProviderID` value needs no app change, since the app keeps no per-provider tables.

No upstream-owned files were edited in wave 6.

# Wave 7: AgentKit's real ACP mode (agentkit-bridge 0.1.0, OpenCode Native 0.14.1)

## Detection and launch

- Bridge lookup: the identity's `launch` (its args, or `acp`); otherwise `OPENCODE_AGENTKIT_BRIDGE` (when set, nothing
  else is searched, so a wrong path says "not found"), then `agentkit-bridge` on PATH, then
  `/Applications/OpenCode Native.app/Contents/MacOS/agentkit-bridge` and the same under `~/Applications`. No build
  path is hardcoded; the real tests point at the build through the env var.
- Probe: `agentkit-bridge --help` prints its usage on stderr with exit 64 ("usage: agentkit-bridge app-server | mcp |
  acp [--local-only] | autopilot <project> --state <dir> | --version"). The provider is available when that usage
  lists `acp`; the exit code does not matter. `acp --help` is not supported (exit 64, same usage), and `--version`
  (exit 0, "agentkit-bridge 0.1.0") gives the version. Neither starts a session or a daemon.

## Adapter changes (every ACP agent)

- An agent without `session/resume` or `session/load` (AgentKit: `loadSession: false`) is not asked to load anything.
  A reattach starts a new agent session and records an `error`: "This agent cannot restore a conversation, so it
  continues in a new session without the earlier context". The manager stores the new `providerSessionID`.
- Diff paths inside the session's directory become `file.changed` paths relative to it. The directory is compared as
  given and resolved, since AgentKit reports `/private/var/...` for `/var/...`. `oldText: null` (a new file) is
  valid ACP and needs nothing special. Review then lists the file.
- A second permission request in the same turn (AgentKit's "outside" keep / undo) is surfaced and answered like any
  other (AHQ-16, scripted).

## Real validation (`SPICY_REAL_AGENTKIT=status|1`, always `--local-only`, $0)

`OPENCODE_AGENTKIT_BRIDGE=<bridge> SPICY_REAL_AGENTKIT=1 [SPICY_REAL_AGENTKIT_LOGS=<dir>] bun test --timeout 1800000
test/agenthq/agentkit.test.ts -t "REAL:"`. A shim in front of the bridge always adds `--local-only` and logs the
JSON-RPC exchange both ways. The run is driven only through the HTTP API of a password-protected listener, in a
temp git repo holding a Swift package whose only file does not build. AgentKit plans and verifies with
`swift build`; a JavaScript project made it plan Swift edits (see b1 below). Every check is recorded and the run
goes on.

Run of 2026-10-12 17:35 (qwen2.5-coder:14b on local Ollama): 18 of 20 checks pass.

| Step                                                             | Result                                                                                                                                                                                                | Latency                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| a. status, initialize, session/new with the Workbench MCP server | pass: available 0.1.0; `loadSession: false`, `authMethods: []`, no image/audio/embedded context; session `agentkit-<UUID>`; the bridge starts a private `AgentDaemon` and `/tmp/ocn-acp-<pid>.sock`   | session start 0.66 s                |
| c. declined proposal                                             | proposal (apply / skip), `end_turn`, the Swift file untouched: pass. Nothing else changed: **fail**, AgentKit created `.blaze/routing_telemetry.jsonl` in the project, which review lists as a change | proposal 0.5 s                      |
| d. cancel with a proposal pending                                | `cancelled`, nothing recorded after it, no stray edits: pass. The client answered the pending request `{"outcome":"cancelled"}` and sent `session/cancel`; the prompt ended `stopReason: "cancelled"` |                                     |
| b. fix applied, reviewed, accepted                               | proposal; apply tool call completed; `file.changed` `Sources/Math/Math.swift` (relative); review lists it (2 hunks); accept; `swift build` passes: all pass                                           | proposal 0.3 s, apply to end 16.2 s |
| e. IDE server restart                                            | no `session/load` (methods: initialize 2, session/new 2, session/prompt 4, session/cancel 1); the notice recorded; the question answered: pass                                                        | answer 1.2 s                        |
| f. cleanup                                                       | no bridge or private daemon process, no socket left after the restart or the identity's removal: pass                                                                                                 |                                     |

The quirk (a question answered with a proposal) did not occur in this run; the test records it and declines when it
does. Nothing under `~/Documents/Codex` changed. The standing `AgentDaemon` (`/tmp/blaze_agent.sock`, running since
01:58) is not ours and was left alone.

## For the AgentKit bridge (b1)

1. AgentKit writes its state into the project being edited: `<project>/.blaze/` gets `agentkit.db`,
   `.agentkit.db.lock`, `agentkit.meta`, `agentkit.salt`, `agentkit.wal`, `execution_telemetry.jsonl`,
   `routing_telemetry.jsonl` and `runtime/tool-schema.json`. Even a declined change leaves
   `.blaze/routing_telemetry.jsonl`, for example
   `{"schema_version":1,"type":"routing",...,"intent":"executableStrong","outcome":"gated:implicit_execution_blocked","duration_ms":6}`.
   Review sees all of it as the agent's changes, and "Accept all" takes it into the project. It should live outside
   the project, under the bridge's or daemon's own state, not least the salt.
2. On a project that is not Swift, the local-only planner plans Swift. For a JavaScript file, after `apply` it ran
   "Building project to verify changes..." and the step "Add missing import statement for Swift standard library",
   which failed with "error: Could not find Package.swift in this directory or any of its parent directories". The
   turn ended `end_turn` with the edit tool calls `failed` and nothing changed. Exchange (session/new and the prompt):
   `{"method":"session/prompt","params":{"prompt":[{"type":"text","text":"fix the build error in src/math.js"}]}}` →
   `tool_call_update {"toolCallId":"step-2-…","status":"failed","content":[…"Add missing import statement for Swift
standard library.\nStep failed: error: Could not find Package.swift…"]}` → `{"result":{"stopReason":"end_turn"}}`.
3. `--local-only` starts `~/Developer/ProjectBlaze/AgentDaemon/.build/release/AgentDaemon`, a development build
   outside the app bundle.
4. Cosmetic: for the Swift fix, the plan said "Add return types for `add` and `sub` functions" while the edit closed
   the missing brace.

## Tests (wave 7)

| Test                                                                  | What it proves                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentkit.test.ts` detection                                          | Usage-based probe: available (version from `--version`), "no ACP mode yet" for a bridge whose usage has no `acp`, "not found"; lookup order env var → PATH → `OpenCode Native.app`, and an explicit env var that points nowhere is not replaced                                                                                                  |
| AHQ-16 (scripted ACP agent without session/load behind a fake bridge) | apply / skip proposal, then the "outside" keep / undo request, both surfaced and answered; an absolute diff path with `oldText: null` becomes `file.changed` `src/fixed.txt` and review lists the file; after a crash, the reattach starts a new agent session (never `session/load`), records the notice and stores the new provider session id |
| `agentkit.test.ts` real (`SPICY_REAL_AGENTKIT=status` / `1`)          | As above                                                                                                                                                                                                                                                                                                                                         |

Results (from `packages/opencode`): `bun test --timeout 120000 test/agenthq` 42 pass, 3 skip (the opt-in real Claude,
Codex and AgentKit checks), 0 fail; `bun test --timeout 30000 test/server test/session` 722 pass, 9 skip, 1 todo,
0 fail; `bun run typecheck` clean. `packages/app` typecheck is clean after `bun install --frozen-lockfile --offline`.

No upstream-owned files were edited in wave 7.

# Wave 8: finding OpenCode Native's bridge without setup

On this Mac OpenCode Native is in neither Applications folder and `agentkit-bridge` is not on PATH (a GUI-launched
server does not see `~/.local/bin` either), so the provider said "AgentKit bridge not found". The last lookup step is
now LaunchServices' index:

- `mdfind "kMDItemCFBundleIdentifier == 'local.opencode.spicy.native'"` lists every copy of OpenCode Native. The
  bundle id lives in one constant, `AGENTKIT_BUNDLE_ID`. Spotlight's index is read-only, has no network and shows no
  UI. The query has a 3-second timeout, any failure finds nothing, and it runs on macOS only.
- Of each copy's `Contents/MacOS/agentkit-bridge` that exists, the ones whose `--help` usage lists `acp` qualify, and
  the newest by the binary's mtime wins.
- The choice is kept per process. Each provider list chooses again, and a session start uses the last choice (it
  only runs the search when there is none yet). The status names the bridge in its first note, `Bridge: <path>`.
- Order: the identity's `launch`; `OPENCODE_AGENTKIT_BRIDGE` (alone when set); PATH; `/Applications` and
  `~/Applications`; LaunchServices.

On this Mac the index returns four copies: the outputs build (bridge 17:36 with ACP), two work/package copies
without a bridge, and `~/OpenCodeCode/OpenCodeNative-agentkit` (bridge 01:18, no ACP). The outputs build wins.

Tests: with an injected finder, the newer of two bridges with ACP wins over an older one; a newer bridge without
ACP and a copy without a bridge are skipped; a session starts the chosen bridge; and an empty, failing or crashing
finder gives "AgentKit bridge not found". Earlier detection tests now inject an empty finder, so Spotlight on the test
machine cannot change them. The real check (`SPICY_REAL_AGENTKIT=index`, status only, no session):
`{"available":true,"version":"0.1.0","bridge":"Bridge: /Users/mdanylchuk/Documents/Codex/2026-10-10/so-w/outputs/OpenCodeNative/OpenCode Native.app/Contents/MacOS/agentkit-bridge"}`.

Results (from `packages/opencode`): `bun test --timeout 120000 test/agenthq` 43 pass, 4 skip (the opt-in real checks),
0 fail; `bun test --timeout 30000 test/server test/session` 721 pass, 9 skip, 1 todo, 1 fail: the upstream
`httpapi-v2-pty` timing flake, which passed 3 of 3 alone right after; `bun run typecheck` clean.

No upstream-owned files were edited in wave 8.

# Wave 9: AgentKit's state outside the project (OpenCode Native 0.14.3)

The bridge under test is the one the product finds: LaunchServices returned the outputs build of OpenCode Native
0.14.3 (`agentkit-bridge` 0.1.0, binary of 18:11), so the real test no longer needs `OPENCODE_AGENTKIT_BRIDGE`: it
reads the bridge from the provider status (`Bridge: <path>`) and puts its `--local-only` shim in front of it.
`SPICY_REAL_AGENTKIT=1 [SPICY_REAL_AGENTKIT_LOGS=<dir>] bun test --timeout 1800000 test/agenthq/agentkit.test.ts -t
"REAL:"`.

New checks in the real run: `git status --porcelain` is empty after the declined change; `<project>/.blaze` never
exists (after skip, cancel, apply and the restart); after apply only `Sources/Math/Math.swift` changed and review
shows only that file; the daemons' temp state folders (their `BLAZE_STATE_HOME`, read from the process environment)
are gone at the end; nothing of this run (`agentkit-acp-<bridge pid>`, `ocn-*`, `blaze`) is left in `$TMPDIR` or
`/tmp`.

## Our side: a session's agent is now allowed to exit on its own

The first run with the new checks (18:14) passed all 20 earlier checks and every new one except "the daemons' temp
state folders are gone": `$TMPDIR/agentkit-acp-<pid>/` (`daemon.lock`, `daemon.log`, `daemon-home/`, `workspaces/`)
stayed for both bridges. A free probe (initialize and session/new only) showed why:

| How the bridge is stopped    | Exit       | `agentkit-acp-<pid>` |
| ---------------------------- | ---------- | -------------------- |
| end of input                 | 0 in 73 ms | removed              |
| SIGTERM to the process       | 143        | stays                |
| SIGTERM to the process group | 143        | stays                |

Agent HQ closed the agent's input and killed its process group in the same breath, so AgentKit never got to clean
up. Now the session's scope gets a finalizer (`providers/acp.ts`) that closes the agent's input and waits up to 3
seconds for it to exit before the group is killed. It runs however the session ends: closed, forgotten, after a
disconnect, or when the server shuts down. Other agents are not slowed: `opencode acp` exits 45 ms after its input
ends and the fake agent in 0 to 2 ms; AHQ-08 took 3.85 s before and 3.50 s after, AHQ-08b 0.33 s and 0.27 s.

AHQ-16's stand-in bridge now keeps a per-process state folder that it removes 200 ms after its input ends (a kill
leaves it). After `forget`, the folder of the live process must be gone; with the old close it stayed (checked
before the fix).

## Run of 2026-10-12 18:26 (qwen2.5-coder:14b on local Ollama, 39 s)

All 20 earlier checks pass. Of the 11 new ones, 10 pass and one fails: two empty SwiftPM lock files are left in
`$TMPDIR` for the bridge that ran `swift build`.

| Step                        | Result                                                                                                                                                                                      | Latency                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| a. status, initialize, new  | available 0.1.0, bridge from LaunchServices; `loadSession: false`; Workbench MCP server sent; private `AgentDaemon` and `ocn-acp-<pid>.sock`                                                | session start 0.67 s                 |
| c. declined proposal        | apply / skip, `end_turn`, file untouched, nothing else changed, no changeset: pass. New: `git status --porcelain` empty, no `.blaze`: pass                                                  | proposal 0.39 s                      |
| d. cancel, proposal pending | `cancelled`, nothing after it, file untouched, no stray edits: pass. New: no `.blaze`: pass                                                                                                 |                                      |
| b. fix applied and accepted | proposal, apply completes, `file.changed` for the file, review lists it (2 hunks), accept, `swift build` passes: pass. New: only that file changed, review shows only it, no `.blaze`: pass | proposal 0.41 s, apply to end 22.8 s |
| e. IDE server restart       | no `session/load` (initialize 2, session/new 2, session/prompt 4, session/cancel 1), new session, notice recorded, question answered: pass. New: no `.blaze`: pass                          | answer 0.97 s                        |
| f. cleanup                  | no bridge, daemon or socket left: pass. New: state folders seen (2) and gone, no state folder of ours in `$TMPDIR` or `/tmp`: pass. No SwiftPM lock files of ours: **fail**                 |                                      |

Nothing under `~/Documents/Codex` changed. No crash reports from our processes. The standing `AgentDaemon` and the
bridges of other sessions were left alone; this run's leftovers (and the earlier runs' state folders) were removed.

## For the AgentKit bridge (b1), after 0.14.3

1. `.blaze` no longer lands in the project, and a declined change leaves the project clean. Confirmed.
2. The per-process `$TMPDIR/agentkit-acp-<pid>` is removed only when the bridge exits on end of input. SIGTERM (to
   the process or its group) leaves it. A client that kills instead of closing (or a crash of the client) leaves it
   every time; cleaning up on SIGTERM and SIGINT too would cover that.
3. Every session that runs `swift build` leaves two empty files in `$TMPDIR`:
   `_private_var_folders_<…>_T_agentkit-acp-<pid>_daemon-home_.swiftpm.lock` and
   `_private_var_folders_<…>_T_agentkit-acp-<pid>_daemon-home_Library_Caches_org.swift.swiftpm_manifests_manifest.db.lock`.
   SwiftPM puts lock files in the temp folder, named after the locked path. Giving the daemon a `TMPDIR` inside the
   state folder would take them along.
4. `--local-only` still starts `~/Developer/ProjectBlaze/AgentDaemon/.build/release/AgentDaemon`, a development build
   outside the app bundle.
5. `$TMPDIR` holds many older `agentkit-acp-*`, `agentkit-autopilot-*`, `agentkit-boundary-*` and
   `agentkit-bridge-checks-*` folders and lock files from earlier runs that are not this session's.

## Tests (wave 9)

From `packages/opencode`: `bun test --timeout 120000 test/agenthq` 43 pass, 4 skip (the opt-in real checks), 0 fail;
`bun test test/review/review.test.ts test/event-manifest.test.ts` 10 pass; `bun run typecheck` clean.

No upstream-owned files were edited in wave 9.

# Wave 10: a found AgentKit bridge must be local and the human's own

The independent validation found that discovery ran `agentkit-bridge --help` from every app with OpenCode Native's
bundle id each time the Agents tab listed providers, without approval, and the newest copy became the bridge for new
sessions. A downloaded app with that bundle id would have been run, and a quarantined binary makes Gatekeeper show a
dialog.

Now a copy found in Applications or through LaunchServices runs only after it passes these checks, made on resolved
paths before anything of it runs (`vet` in `providers/detect.ts`):

1. Neither the app nor its bridge has `com.apple.quarantine`. `/usr/bin/xattr <app> <bridge>` only lists attribute
   names (a native tool, no UI), and an answer it cannot give counts as quarantined. Nothing under `/Volumes/`.
2. The bridge, its folder and the bundle's `Contents/MacOS` are owned by this user or root and are not writable by
   group or others.
3. Only paths under the home folder (`Global.Path.home`) or `/Applications` qualify.
4. `--help` and `--version` run once per binary (real path, size, mtime, inode), one question at a time; provider
   lists reuse the answer until the binary changes. This holds for every bridge, including one set by the human.

A session start checks the chosen copy again and refuses ("AgentKit bridge not found") if it no longer passes or now
resolves to another file. The status note `Bridge: <path>` names the resolved file that runs, and the new-agent
dialog's provider picker now shows it under an available provider; before, it showed only name, version and reason.
`OPENCODE_AGENTKIT_BRIDGE`, PATH and an identity's `launch` are what the human chose and stay unchecked, as `claude` and
`codex` on PATH are.

Changes in behavior: a copy in an Applications folder gets the same checks, and one without an ACP mode is now
skipped (LaunchServices is asked next) instead of reported as "no ACP mode yet". Opened downloads keep their
quarantine attribute (flags `01c3` on this Mac's downloaded apps), so a downloaded OpenCode Native is never picked up
on its own; the human can point at it with the env var or PATH. In tests the home folder is the test home, so the unit
tests never run this Mac's real bridge; the opt-in real checks drop `OPENCODE_TEST_HOME` to look from the real home.

On this Mac LaunchServices lists four copies. The outputs build (`~/Documents/Codex/.../outputs/OpenCodeNative`) is
owned by the user, mode 755 for the app, `Contents/MacOS` and the bridge, and has only `com.apple.FinderInfo` and
`com.apple.fileprovider.fpfs#P`. It is still chosen: `SPICY_REAL_AGENTKIT=index` gave `{"available":true,
"version":"0.1.0","bridge":"Bridge: /Users/mdanylchuk/Documents/Codex/2026-10-10/so-w/outputs/OpenCodeNative/OpenCode
Native.app/Contents/MacOS/agentkit-bridge"}`. `~/OpenCodeCode/OpenCodeNative-agentkit` passes the checks but has no
ACP mode (asked once); the two package copies have no bridge.

## Tests (wave 10)

`agentkit.test.ts`, with copies of OpenCode Native under the test home whose bridges log every run:

| Test                                                                                                  | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applications, else the newest copy LaunchServices knows                                               | as before (newest with ACP wins, skips no-ACP and bridgeless copies, a failing index finds nothing); the session runs the chosen bridge; a copy in an Applications folder beats newer indexed ones                                                                                                                                                                                                                                                          |
| never runs a found copy that is quarantined, on a mounted image, outside home, or not the human's own | the newest copy is skipped and never runs when its app or only its bridge is quarantined, when its owner is someone else (faked stat), when it or its folder is writable by others or the group (real chmod), or outside home; on a mounted image (faked realpath, home on the image too) nothing is even asked about it; a chosen copy quarantined after the list is refused at session start and never runs `acp`; the control then picks the newest copy |
| asks a bridge about itself once per binary, until it changes                                          | 5 lists: one `--help`, one `--version`; after a new mtime, 3 lists: one more of each; a session start adds only `acp`                                                                                                                                                                                                                                                                                                                                       |
| reads the quarantine attribute with the system's xattr (macOS)                                        | a plain temp file: false; after `xattr -w com.apple.quarantine` on it: true; a missing path: true                                                                                                                                                                                                                                                                                                                                                           |

Each rule was removed in turn from `vet` (quarantine, `/Volumes`, roots, owner, group-writable, the session-start
recheck, the cache) and each time a test failed.

Results: `bun test --timeout 120000 test/agenthq` 46 pass, 4 skip (the opt-in real checks), 0 fail; `bun run
typecheck` clean in `packages/opencode` and `packages/app`; `packages/app` Agent HQ unit tests 18 pass.

No upstream-owned files were edited in wave 10.

# Wave 11: discovery never touches the folders macOS guards

In the desktop app the server runs as the app's utility process, and macOS guards `~/Documents`, `~/Desktop`,
`~/Downloads` and iCloud Drive (`~/Library/Mobile Documents`) per app (TCC). The first touch shows "“OpenCode” would
like to access files in your Documents folder". Listing providers in the real app did that: discovery resolved,
stat'ed, read the xattrs of and probed LaunchServices hits under `~/Documents/Codex/…`. The CLI tests never saw it
because Terminal already has access.

Now LaunchServices hits are judged by the path the index gives, before anything resolves, stats, reads or runs them:
one under `PROTECTED_FOLDERS` (`providers/detect.ts`: `Documents`, `Desktop`, `Downloads`, `Library/Mobile Documents`
of the home folder, compared without regard to case and against the home as given and resolved) is skipped. `mdfind`
only queries the index. The env var, PATH, an identity's `launch` and the Applications folders are unchanged.

When nothing else qualifies, the status and a session start say why: "OpenCode Native was found only in a protected
folder (Documents); install it in Applications or set OPENCODE_AGENTKIT_BRIDGE" (the folders the skipped copies were
in). The new-agent dialog shows a provider's reason when it is unavailable.

On this Mac LaunchServices lists four copies; three are under `~/Documents/Codex` and are skipped, and
`~/OpenCodeCode/OpenCodeNative-agentkit` has no ACP mode. The free status check (`SPICY_REAL_AGENTKIT=index`, which now
records every path discovery resolves or stats) reports that reason, and it touched only `/Applications/OpenCode
Native.app` and `~/Applications/OpenCode Native.app` (neither exists), the home folder, and the `OpenCodeNative-agentkit`
copy; nothing in a protected folder. Until a build is installed in Applications (by copying it: a link in Applications
that points into Documents would be resolved), the full real run (`SPICY_REAL_AGENTKIT=1`) needs
`OPENCODE_AGENTKIT_BRIDGE`.

## Tests (wave 11)

`agentkit.test.ts`: the newest copies, with an ACP mode, in the test home's Documents, Desktop, Downloads and iCloud
Drive folders (plus one listed with `documents` in lower case and one by the resolved home) are never resolved,
stat'ed or asked about (a spy on `files` and `quarantined`) and never run (their logs stay empty); the status and a
session start give the reason with all four folders; a copy in `~/Applications` is still chosen, listed by
LaunchServices beside them or found in the folder. Removing the skip, the case folding, the resolved home or the
reason at session start each makes it fail.

Results: `bun test --timeout 120000 test/agenthq` 47 pass, 4 skip (the opt-in real checks), 0 fail; `bun run
typecheck` clean.

No upstream-owned files were edited in wave 11.

# Wave 12: AgentKit 0.15.0, the full real run with no env var

OpenCode Native 0.15.0 (commit 6e73547) is installed by copy at `~/Applications/OpenCode Native.app`: owned by the
user, mode 755 for the app, `Contents/MacOS` and its binaries, no extended attributes, `Contents/MacOS` holds
`agentkit-bridge`, `AgentDaemon` and `OpenCodeNative`. `SPICY_REAL_AGENTKIT=1` ran with `OPENCODE_AGENTKIT_BRIDGE`
unset, `--local-only` only.

New checks in the real run:

- a: the env var is unset; the bridge is `~/Applications/OpenCode Native.app/Contents/MacOS/agentkit-bridge`; the same
  discovery, watched (spy on every path it resolves or stats, a finder that records whether it is asked), finds it by
  the Applications lookup without asking LaunchServices and touches nothing in a protected folder (it touched only the
  two Applications candidates, the home folder and the installed app).
- f: every private daemon seen is the app's own `Contents/MacOS/AgentDaemon` (none from `~/Developer/ProjectBlaze`).
- g: SIGKILL the bridge mid-session (idle, after the restart's answer), then start a new session for the same agent.
  The killed bridge's `agentkit-acp-<pid>/` stays after the kill and is gone after the new session starts (AgentKit's
  sweep). Its private daemon and `/tmp/ocn-acp-<pid>.sock` must be gone within 20 seconds; the test then stops
  whatever the crash left, so f checks the rest on its own.
- The test only counts and kills bridges that descend from its own process, since other sessions may run the same app.

Run of 2026-10-12 21:40 (65 s): all 20 earlier checks, all 11 state checks (no SwiftPM lock files left), the four a
checks and the bundled-daemon check pass. Of the five g checks, three pass and two fail: the dead agent's private
daemon (pid 49193) was still running 20 seconds after the new session started, and its socket was still there.

| Step                               | Result                                                                                                              | Latency                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| a. status, initialize, session/new | available 0.1.0 from `~/Applications`; LaunchServices not asked; nothing protected touched                          | session start 1.37 s                 |
| c. declined proposal               | all pass                                                                                                            | proposal 0.43 s                      |
| d. cancel with a proposal pending  | all pass                                                                                                            |                                      |
| b. fix applied and accepted        | all pass (review: only `Sources/Math/Math.swift`, 2 hunks; `swift build` passes)                                    | proposal 0.36 s, apply to end 24.6 s |
| e. server restart                  | all pass (initialize 2, session/new 2, session/prompt 4, session/cancel 1)                                          | answer 1.16 s                        |
| g. SIGKILL, new session            | folder kept until the new session, then swept: pass. Daemon and socket gone: **fail**                               | new session 0.76 s                   |
| f. cleanup                         | no process or socket left, state folders gone, nothing in `$TMPDIR` or `/tmp`, no lock files, daemons bundled: pass |                                      |

An earlier run the same evening (21:37, before g stopped the orphan itself) passed the same checks and reported the
orphaned daemon under f instead (process 41079 and `ocn-acp-41073.sock` left after the identity was removed).

## For the AgentKit bridge (b1), after 0.15.0

A free probe (initialize and session/new, then SIGKILL the bridge) shows why: the private daemon runs in a process
group of its own (bridge 46287 in group 46287, daemon 46320 in group 46320), so killing the bridge's group never
reaches it; it was alive 5 seconds after the kill with its socket, and SIGTERM stopped it and removed the socket. The
sweep removes the dead agent's folder (its `daemon.lock` with it) while that daemon keeps running. Either the daemon
should exit when its bridge dies, or the sweep should stop a dead agent's daemon and remove `/tmp/ocn-acp-<pid>.sock`
before removing the folder. Agent HQ cannot do it: it only knows the bridge's process group.

Nothing under `~/Documents/Codex`, the OpenCode Native repo or the installed app changed. The owner's launchd daemon
(now `~/Applications/OpenCode Native.app/Contents/MacOS/AgentDaemon`, pid 36132) was left alone.

# Wave 13: AgentKit 0.15.1, crash cleanup

OpenCode Native 0.15.1 (commit 2fd2290, installed by copy at `~/Applications`, owned by the user, mode 755, no
extended attributes) gives each private daemon a watcher, `agentkit-bridge watch <bridge pid> <daemon pid> <socket>
<state>`. The watcher is a child of the bridge in a process group of its own; it sees the bridge exit (kqueue), stops
the daemon and removes the socket and the state folder. The next local-only session's sweep also stops a dead
agent's daemon (found by its socket) before removing the folder.

Step g of the real run now has two crashes, after the restart's answer:

- g1: SIGKILL the bridge. Its daemon, watcher, socket and folder must all be gone within 15 seconds, with no new
  session.
- g2: start a new session, wait until its bridge runs a daemon and a watcher, SIGKILL the bridge and the watcher.
  Three seconds later the daemon, socket and folder must still be there (nothing else stops them); after the next
  session starts, all must be gone within 20 seconds.

The test identifies the daemon and the watcher among the killed bridge's own children, so it only counts and kills
processes descended from itself.

Run of 2026-10-12 21:50 (48 s, `OPENCODE_AGENTKIT_BRIDGE` unset, `--local-only`): all 42 checks pass (the 4 discovery
checks, the 20 earlier checks, the 11 state checks, the 6 crash checks and the bundled-daemon check).

| Step                               | Result                                                                                                                   | Latency                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| a. status, initialize, session/new | from `~/Applications` by the Applications lookup, LaunchServices not asked, nothing protected touched                    | session start 0.75 s                                        |
| c. declined proposal               | pass                                                                                                                     | proposal 0.42 s                                             |
| d. cancel with a proposal pending  | pass                                                                                                                     |                                                             |
| b. fix applied and accepted        | pass (review: only `Sources/Math/Math.swift`, 2 hunks; `swift build` passes)                                             | proposal 0.36 s, apply to end 23.7 s                        |
| e. server restart                  | pass (initialize 2, session/new 2, session/prompt 4, session/cancel 1)                                                   | answer 1.10 s                                               |
| g1. SIGKILL the bridge             | daemon, watcher, socket and folder gone with no new session: pass                                                        | 0.12 s after the kill                                       |
| g2. SIGKILL bridge and watcher     | daemon, socket and folder kept, then swept by the next session: pass                                                     | new sessions 0.77 s and 1.27 s; gone as the second returned |
| f. cleanup                         | no process or socket left, state folders gone, nothing left in `$TMPDIR` or `/tmp`, no lock files, daemons bundled: pass |                                                             |

A free probe before the run (initialize and session/new only) showed the same: after SIGKILL of the bridge all was
gone in 212 ms; with bridge and watcher killed the daemon stayed until the next session started, then all was gone.

Nothing under `~/Documents/Codex`, the OpenCode Native repo or the installed app changed. The SwiftPM lock files in
`$TMPDIR` named `agentkit-acp-2sajeo_2` (17:05) and `agentkit-acp-j90bi3uk` (21:46) are not from this session's runs.

# Security wave: one scoped token per Workbench bridge

Two HIGH findings of the security review, one design fix.

1. External agents got the full server password. `AgentWorkbench.server()` put `OPENCODE_SERVER_PASSWORD` into the
   Workbench MCP server's `env`, which reaches the agent (ACP `session/new` mcpServers, the Claude SDK's bridge spawn)
   and the bridge's environment. The server's auth is one global basic-auth check, so whoever held it reached every
   route: answering its own permission asks, starting the debugger as the person, writing files, sessions.
2. `POST /workbench/check` trusted `trigger: "user"` from the body, so any password holder ran exec-class checks
   without the `verify.exec` ask.

## The design

- `src/server/bridge-token.ts` (`BridgeToken`): `mint()` makes a random 256-bit token (base64url) held only in this
  process's memory; `revoke()` ends it; `of(request)` finds the live token of `Authorization: Bearer <token>`.
- `AgentWorkbench.server()` gives the bridge `OPENCODE_SERVER_TOKEN` and nothing else: no username, no password, and
  never in its arguments. The manager (`session.ts`, `withWorkbench`) revokes it when the provider session closes
  (detach, forget, shutdown), and at once when the session never opens. `AgentProvider.agentEnv()` also strips
  `OPENCODE_SERVER_TOKEN`.
- The instance API's `Authorization` middleware (upstream, `// spicy:`): a request with a live token is let through
  only to the endpoints in `BridgeToken.ROUTES`, matched on the HttpApi group and endpoint the router resolved (not
  on the path), and answers 403 anywhere else. Routes that do not use that middleware (PTY connect, the v2 `/api`
  routes, the UI and `/doc`) do not know tokens and answer 401. The server password works as before.
- A token is always an agent: `POST /workbench/check` runs with trigger `agent` whatever the body says; `user` is
  honoured only without a token (the server password, the IDE).
- A token acts only in its own session. The bridge used to create its session with `POST /session`, which accepts a
  `permission` ruleset; with that, or with a person's session id, `tools/agent` and `debug/agent` would have used
  allow rules the agent wrote or the person saved. Now the bridge calls `POST /workbench/session` (new; a session
  titled "Workbench MCP", nothing else accepted), a token gets exactly one such session, and `WorkbenchAgent.runner`
  refuses (403) any other session for a token.
- `opencode workbench mcp` sends `Bearer <token>` when it has `OPENCODE_SERVER_TOKEN` (or `Connection.token`), and
  basic auth with the server password otherwise, so a person can still run it by hand.

The allow-list (`BridgeToken.ROUTES`), all the bridge calls:

| Endpoint                | Route                                                |
| ----------------------- | ---------------------------------------------------- |
| `workbench.problems`    | `GET /workbench/problems`                            |
| `workbench.check`       | `POST /workbench/check` (always trigger `agent`)     |
| `workbench.doctor`      | `GET /workbench/doctor`                              |
| `workbench.session`     | `POST /workbench/session` (the token's one session)  |
| `workbench-debug.agent` | `POST /workbench/debug/agent` (in that session only) |
| `workbench-tools.list`  | `GET /workbench/tools`                               |
| `workbench-tools.agent` | `POST /workbench/tools/agent` (in that session only) |

## Where the boundary still is

- (Closed by the follow-up below: the token is bound to its session's directory.)
- A same-uid agent whose shell command the human approves can still read this server process's own environment (the
  password is in it when the server was started with it) or its memory. Human approval of shell commands stays the
  outer control.
- Without a server password the server is open to anyone on the machine, token or not; the token then only keeps the
  bridge's own requests to trigger `agent` and its own session.

## Tests

- `test/workbench/security-bridge-token.test.ts`, against a real listener with a password: the review's repro
  inverted (a token with `trigger: "user"` is skipped with "needs approval in the IDE" and writes no marker; the
  password still runs the check); a token gets 200 on its endpoints, 403 on `/agenthq/sessions/…/permissions/…`,
  `/agenthq/agents`, `POST /workbench/debug/sessions`, `GET` and `PUT /workbench/file`, `/workbench/runs`,
  `POST /workbench/tools`, `GET` and `POST /session`, `/session/…/permissions/…`, `/permission`, `/global/health`, and
  403 for `tools/agent` and `debug/agent` in a session of the person's, while its own session passes; a revoked or
  made-up token gets 401; Agent HQ's `session/new` gives the bridge only `OPENCODE_SERVER_TOKEN` (the password nowhere
  in the params), the token works on the bridge's routes and gets 401 after the identity is removed.
- AHQ-08 (`acp.test.ts`, real `opencode acp`): the running bridge's environment (`ps -E`) holds a token and not the
  password; the token gets 200 on `/workbench/problems`, 403 on `/agenthq/agents`, and 401 once the identity is removed.
- `claude-code.test.ts` and `codex.test.ts`: the Workbench server's env is the token alone; the claude process gets
  no token; the real Claude check now expects the token in the bridge's environment and never the password.
- `mcp.test.ts`: a bridge with a token sends `Bearer <token>` and nothing else. The httpapi exercise covers
  `POST /workbench/session`.

The review's repro on `spicy-security` (`security-trigger-bypass.test.ts`) runs without a password and without a
token, where the caller is the person by design; the inverted test above replaces it.

Results: `bun test test/agenthq test/workbench …` green; `bun test --timeout 60000 test/server test/workbench
test/session` 895 pass, 11 skip, 1 todo, 1 fail (the upstream `httpapi-v2-pty` timing flake, 3 of 3 alone);
`bun run test:httpapi` coverage, auth and effect each 270 pass, 0 fail, 0 missing; `bun run typecheck` clean.

## Follow-up: each token is bound to its session's directory

A token is minted for one directory, resolved (realpath): the Agent HQ session's working directory, which for an
isolated task is its worktree (`AgentWorkbench.server(directory)` → `BridgeToken.mint(directory)`). A token request
runs only when the directory it targets is that one; otherwise 403, on every allow-listed route
(`BridgeToken.reaches`, called by the same middleware). The targeted directory is picked as workspace routing and the
instance context pick it: `?directory=`, else `x-opencode-directory`, else the server's working directory,
URI-decoded, then resolved; a request that names another workspace (`?workspace=`) is never the token's. A folder
inside the directory, a worktree of it and its parent are all other directories.

Tests (`security-bridge-token.test.ts`): a project token reads problems, runs a check and gets its session in its own
directory (also through a symlink and URI-encoded), and gets 403 with another project, a subfolder, a worktree of the
project, `?directory=` naming another project (it wins over the header, as in routing), `?workspace=` and no directory
at all; a worktree token gets 200 in the worktree and 403 in the project; through Agent HQ, an identity working in a
worktree gets a bridge `--directory <worktree>` whose token reaches the worktree and not the project. Removing the
directory comparison, the query-first order, the URI decoding, the realpath or the workspace refusal each makes the
test fail.

Results: `bun test test/agenthq test/workbench/{security-bridge-token,mcp,mcp-debug}.test.ts test/workbench/tools
test/server/{auth,httpapi-instance-route-auth}.test.ts` 80 pass, 4 skip, 0 fail; `bun run test:httpapi` coverage,
auth and effect each 270 pass, 0 fail, 0 missing; `bun run typecheck` clean.

# Cursor through its ACP mode (`cursor-agent acp`)

Cursor's CLI does have ACP: `acp` is a hidden subcommand, absent from the top-level help. In the 2026.10.01 build,
`cursor-agent acp --help` prints "Start the Cursor Agent as an ACP (Agent Client Protocol) server"; the installed
2025.09.12 answers `acp --help` with its top-level help.

- Detection (`AgentDetect.cursor`): `OPENCODE_CURSOR_AGENT` (a path, alone when set), else `cursor-agent` on PATH;
  never a bare `agent` (on this Mac `~/.local/bin/agent` is the ProjectBlaze AgentKit CLI). Available when
  `cursor-agent acp --help` exits 0 and mentions ACP; otherwise "This cursor-agent (2025.09.12) has no ACP mode; update
  the Cursor CLI". Probing runs only `--version` and `acp --help`; it does not check the login.
- Launch: `cursor-agent acp` and nothing else (never `--force`, `--yolo`, `--auto-review`, `--approve-mcps` or
  `--trust`), through the ACP adapter with its credential stripping, Workbench token and process-group handling. An
  identity's `launch` replaces the command. `CURSOR_CONFIG_DIR` points at Agent HQ's own folder
  (`<state>/agenthq/cursor`, made with `permissions: { allow: [], deny: [] }`), so the owner's Cursor allowlist and
  MCP config are not used and "Allow always" is remembered there, not in `~/.cursor`. The login is in the keychain, not
  in that folder (`cursor-agent status` gives the same answer with either folder).
- Approvals: Cursor's docs say tools that need approval go through `session/request_permission` (allow-once,
  allow-always, reject-once). Its code (the ACP decision provider) asks for every write, delete, read, shell command
  and MCP call in its default "allowlist" approval mode, except what the allowlist already allows (by default
  `Shell(ls)`). Run Everything needs `--force`/`--yolo`, Auto-review needs `--auto-review`; Agent HQ passes neither, and
  the folder above starts with an empty allowlist, so Cursor asks before everything.
- Login: Agent HQ never calls ACP `authenticate`. Cursor's handler for `cursor_login` opens a browser login when there
  is no login, and the server already checks the login the same way at startup, so after an auth_required answer
  authenticate would always start that browser flow. Instead `session/new`'s auth_required becomes "Cursor is not
  logged in; run `cursor-agent login`" (`AcpProvider.make({ authRequired })`).

Tests (`test/agenthq/cursor.test.ts`): a bare `agent` is ignored; an old cursor-agent says to update; a new one is
available; `OPENCODE_CURSOR_AGENT` finds a build outside PATH and, pointing nowhere, is not replaced by PATH; a session
starts with exactly `acp` as arguments and `CURSOR_CONFIG_DIR` at the folder with the empty allowlist; a Cursor that
answers auth_required fails the start with the login message and is never sent `authenticate`. AHQ-07 now checks the
old CLI's reason and keeps the manager away from this machine's own Cursor.

Free real check (`SPICY_REAL_CURSOR=status`, `OPENCODE_CURSOR_AGENT` = the unpacked 2026.10.01-e373342 build, no
prompt): available; `session/new` answered auth_required after 14.4 s, reported as "Cursor is not logged in; run
`cursor-agent login`". `cursor-agent status` from that build says "Not logged in" with the owner's default config and
with Agent HQ's folder alike, so the owner's Cursor login is not there for this CLI; nothing logged in. The owner's
`~/.cursor/cli-config.json` was not touched; Cursor made an empty `~/.cursor/projects/<temp dir>` folder for the test
project, which was removed.

Results: `bun test --timeout 120000 test/agenthq` 50 pass, 5 skip (the opt-in real checks), 0 fail; typecheck clean.

# UX audit fixes

## #12 An approval cut off mid-merge

The audit aborted an approve after 1 s: the merge was on `main`, the task stayed in Review, its worktree was gone but
still recorded and its branch was left. Merge, worktree removal and the status save were all interruptible.

- `approve` records the reviewed head as `merging` on the task (an additive, optional `AgentHQ.Task` field), then
  merges, removes the worktree and its branch, and saves `done`, all in one uninterruptible step: a client that goes
  away no longer stops it halfway. A merge that fails is aborted and `merging` cleared.
- `reconcile` finishes or undoes what a crash cut off, on the first call after a start (`ready`), and before `review`
  and `approve`: with `merging` recorded, the task is done when that head is in the project, and back to plain review
  otherwise; without it (an approval from before), a merge commit of the branch tip in the project counts. A branch
  with no commits of its own never counts, so such a task keeps waiting for the human. Finishing removes the worktree
  and deletes the branch, which `Worktree.remove` leaves when git no longer lists the worktree.
- A second approve after the first one finished is refused ("Task is done"); one whose merge already landed but was
  not yet marked is answered with the done task.

Tests (`orchestrator.test.ts`): an approval interrupted while its merge runs (a slow `post-merge` hook) still ends done,
merged (`HEAD^2` is the head), worktree and branch gone; after a crash at each point (merged with worktree and branch
left; merged with the worktree removed; recorded but not merged; merged by an approval without the record) a new
server lifetime finishes or undoes each, and a task whose branch has nothing of its own stays in review. Without the
uninterruptible step the first test fails.

## #3 Structured permission previews

Approval cards printed `JSON.stringify(metadata).slice(0, 2000)`; temp paths ate the budget and diffs were cut off as
escaped strings. `permission.requested` now also carries `preview` (`AgentHQ.PermissionPreview`, additive; `details`
stays):

- `{ kind: "edit", path, diff, truncated? }`: a unified diff, file headers relative to the project, capped at 32,000
  characters (`truncated: true` when cut). Several files: their paths comma-separated and their diffs one after
  another.
- `{ kind: "command", command, cwd? }`.
- `{ kind: "other", summary }`: one line, at most 500 characters.

Built in `src/agenthq/preview.ts` and filled by every adapter:

- opencode: `edit` asks (write, edit, apply_patch) bring the tool's own diff, whose absolute headers become
  project-relative; `bash` asks show the tool call's full command line (the ask's patterns are only its parsed
  commands) and the session's directory; anything else its title.
- ACP (Codex, Cursor, AgentKit, custom agents): the request's `diff` content becomes the diff; an `execute` call shows
  `rawInput.command` (an array is joined) and `rawInput.cwd`, else its title without backticks and the session's
  directory; anything else its title and text.
- Claude Code: Edit and MultiEdit are applied to the file as it is now to make the diff (the strings alone when the
  file cannot be read or the text is not in it), Write diffs against the current file (empty when new), Bash shows
  its command and the session's directory.

Tests: opencode's bash ask previews the command and directory (AHQ-04) and a write previews `notes/plan.txt` with no
temp path in the diff (AHQ-17); ACP previews "Delete everything", `npm test` in `<cwd>/pkg` from raw input, and an
AgentKit-style proposal's diff of `src/fixed.txt` (AHQ-15, AHQ-16); Claude Code previews an Edit of a real file as
`-one +two` with context, a new file whole, and a Bash command (`claude-code.test.ts`); `preview.test.ts` checks that
only a leading root leaves the headers and that a long diff is cut and flagged.
