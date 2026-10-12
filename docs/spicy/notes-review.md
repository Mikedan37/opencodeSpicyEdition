# Review backend notes (`spicy-review`)

Cursor-style review of agent edits: every agent session's file changes become a **changeset**; the human
accepts or rejects each hunk, each file, or everything, and can undo a reject. Server side only (store,
diff, apply/revert, routes, events). Contract: `packages/schema/src/review.ts` (new).

## Design

- **Baseline per file.** A file's baseline is its bytes before the agent first touched it. Pending hunks are
  always `diff(baseline, working tree)`, recomputed on every read, so they show whatever is on disk now.
  Accept moves the baseline forward (to the baseline plus that hunk, or to the current file); reject
  rewrites exactly that region of the working tree (or the whole file) back to the baseline.
- **Where baselines live.** Blobs in the project's existing snapshot object store (the shadow git at
  `Global.Path.data/snapshot/<projectID>/<hash(worktree)>`, `src/snapshot`). The JSON store keeps only blob
  ids and metadata. The snapshot store runs `git gc --prune=7.days` hourly, so review pins every blob it
  needs with one ref (`refs/opencode/review` → a tree of those blobs), rebuilt on each change. Initial
  baselines are read with `git cat-file --filters`, so eol/`text` attributes are undone and the bytes
  match the working tree exactly (a `*.bat eol=crlf` file is not "changed" by normalisation).
- **OpenCode sessions** (the app, the TUI, OpenCode Native, Agent HQ's OpenCode provider): the review
  service subscribes to the event bus. Each step's `patch` part (`session/processor.ts`, step finish and
  cleanup) names the files the step changed and the step-start snapshot; a file's baseline is its content in
  the first such snapshot. One ordered subscription (`EventV2.all()`) also tracks `session.status`, and a
  patch only counts while its session is busy: `Session.fork` and imports re-publish old patch parts, which
  are history (REV-07). `session.deleted` removes the session's changeset.
- **Agent HQ sessions of external providers** (`claude-code`, `cursor`, `codex`): the session manager calls
  `ReviewChanges.observeAgent(info, agent, envelopes)` for every recorded batch (one marked line in
  `agenthq/session.ts`). A user `message` starts a turn and takes a snapshot of the identity's working
  directory (`workingDirectory ?? projectDirectory`) before the provider sees the prompt; `file.changed`
  records that file at once; `turn.completed` or any non-active status diffs the turn-start snapshot, which
  also finds files the provider did not report. OpenCode-provider sessions are skipped here (their opencode
  session is reviewed through its patch parts; `owner.id` = `AgentSessionInfo.providerSessionID`).
- **One document per worktree**, key `["review", projectID, sha1(worktree)]`:
  `files: { path → { base: blobID | null, owner: changesetID, settled } }`,
  `changesets: { id → { owner, agentID?, directory, updatedAt, decided: { path → { accepted, rejected, status } } } }`,
  `undo: [{ changeset, path, before: blobID | null, after: blobID | null, hunks }]` (last 100). One lock per
  worktree. A pending file belongs to the changeset of the session that touched it **last**, so a pending
  hunk is listed exactly once even when two sessions edit the same file.
- **Settled files.** A file decided down to its baseline is `settled`; when an agent touches it again its
  baseline restarts from that step's snapshot, so edits the human made after deciding are not shown as the
  agent's. Accepting while the owner is still editing does not settle the file (its next step would
  otherwise reset the baseline).
- **Hunks** are contiguous changed line regions (`diffArrays` over lines that keep their terminators, so
  joins are byte-exact, CRLF and "no newline at end of file" included). A hunk id is
  `sha1(path, removed lines, added lines, repeat index)[0..16]`: stable while that change exists, even when
  other hunks of the file are decided. Added files, deleted files and files that are not line-diffable
  (binary, not UTF-8, over 1 MB, or a diff over 2 s) are one whole-file hunk.
- **Never clobber.** Reject recomputes the hunks from the file on disk and acts only on the hunk with that
  id (else 409); just before writing it re-reads the file and refuses (409) if it changed meanwhile. Reject
  and undo are refused with 409 `agent is still editing` while the owning session is mid-turn (opencode:
  `session.status` busy/retry; Agent HQ: between turn start and turn end). Only regular files are reviewed
  (symlinks, submodules and directories are skipped). The repository's index, commits and branches are
  never touched; git runs only against the shadow store.
- **Undo** restores the content a file had before its last reject in that changeset, only when the file
  still holds exactly what the reject wrote (else 409).

## Routes

Instance routes (`?directory=` or `x-opencode-directory`, server auth like every instance group), group
`ReviewApi` (`server/routes/instance/httpapi/groups/review.ts`, `handlers/review.ts`). Every mutation
returns the changeset after the decision and publishes `review.changeset.updated`.

| Method | Path                                            | Body                                                                                 | 200                                                            | Errors   |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------- |
| GET    | `/review/changesets`                            | query `ownerKind?` (`opencode-session` \| `agenthq-session`), `ownerID?`, `agentID?` | `ChangeSet[]` with at least one file, newest `updatedAt` first |          |
| GET    | `/review/changesets/:changesetID`               |                                                                                      | `ChangeSet`                                                    | 404      |
| GET    | `/review/changesets/:changesetID/content`       | query `path`                                                                         | `Content`                                                      | 404      |
| POST   | `/review/changesets/:changesetID/hunks/:hunkID` | `{ "action": "accept" \| "reject" }`                                                 | `ChangeSet`                                                    | 404, 409 |
| POST   | `/review/changesets/:changesetID/files`         | `{ "path": "src/a.ts", "action": "accept" \| "reject" }`                             | `ChangeSet`                                                    | 404, 409 |
| POST   | `/review/changesets/:changesetID/all`           | `{ "action": "accept" \| "reject" }`                                                 | `ChangeSet`                                                    | 404, 409 |
| POST   | `/review/changesets/:changesetID/undo`          | `{ "path": "src/a.ts" }`                                                             | `ChangeSet`                                                    | 404, 409 |

- `changesetID` is `chg_` + the owner's session id (`chg_ses_…`, `chg_ags_…`); anything else is a 400.
  Clients can treat it as opaque and filter by owner instead.
- `path` is the file's `path` from the changeset (worktree-relative, `/`). A path the changeset has decided
  but no longer has pending (or that another session took over) is a 200 no-op.
- `files`/`all` act on every pending hunk of the file(s); deciding something already decided is a no-op.
- `all` with `reject` applies what it can; if some file fails (changed while rejecting) the others stay
  rejected, the update is published, and the response is 409 naming the files.
- `content` returns both sides of one file byte for byte with the pending hunks of the same read (the app
  diffs `before`/`after` and pins the hunk actions with `hunks`). Use it instead of `/file/content`, which
  trims the text (a leading blank line or the final newline would shift every hunk). For a file with
  nothing pending it returns `{ path, binary: false, hunks: [] }`.

Error bodies (exact):

```json
404 {"name":"NotFoundError","data":{"message":"Changeset not found: chg_missing"}}
404 {"name":"NotFoundError","data":{"message":"File not in changeset chg_ses_x: nope.txt"}}
409 {"_tag":"ConflictError","message":"hunk 2c635c5c0ccaa665 no longer matches the working tree; reload the changeset"}
409 {"_tag":"ConflictError","message":"agent is still editing"}
409 {"_tag":"ConflictError","message":"the file changed while it was being reviewed","resource":"a.txt"}
409 {"_tag":"ConflictError","message":"nothing to undo","resource":"new.txt"}
409 {"_tag":"ConflictError","message":"the file changed since the reject","resource":"new.txt"}
409 {"_tag":"ConflictError","message":"1 file(s) could not be rejected: a.txt"}
400 schema decode error (unknown action, malformed changesetID)
```

### `ChangeSet` (JSON)

```json
{
  "id": "chg_ses_ed0d576e1ffeFsVUIqqXVy1Naz",
  "owner": { "kind": "opencode-session", "id": "ses_ed0d576e1ffeFsVUIqqXVy1Naz" },
  "agentID": "agt_…",
  "files": [
    {
      "path": "a.txt",
      "status": "modified",
      "binary": false,
      "additions": 1,
      "deletions": 1,
      "hunks": [
        {
          "id": "2c635c5c0ccaa665",
          "oldStart": 9,
          "oldLines": 1,
          "newStart": 9,
          "newLines": 1,
          "patch": "@@ -9,1 +9,1 @@\n-nine\n+NINE\n"
        }
      ],
      "state": "partial",
      "undoable": false,
      "accepted": 1,
      "rejected": 0,
      "decided": [
        {
          "id": "8a1f0c2d3e4b5a69",
          "oldStart": 2,
          "oldLines": 1,
          "newStart": 2,
          "newLines": 1,
          "patch": "@@ -2,1 +2,1 @@\n-two\n+TWO\n",
          "state": "accepted",
          "at": 1791792680000
        }
      ]
    }
  ],
  "counts": { "files": 1, "pending": 1, "accepted": 1, "rejected": 0, "additions": 1, "deletions": 1 },
  "updatedAt": 1791792681101
}
```

- `agentID` only for `agenthq-session` owners (omitted otherwise).
- `status`: `added` (no baseline), `deleted` (missing on disk), `modified`. For a file with nothing pending
  it is the status at its last decision.
- `hunks`: pending hunks only, in file order. Line numbers follow unified diff (1-based; a side with 0 lines
  names the line before the change). `patch` has the `@@` header and `-`/`+` lines without context, with
  `\ No newline at end of file` where it applies; it is `""` for binary files and for empty added/deleted
  files. Context lines come from the file itself (existing file routes).
- `state`: `pending` (hunks, nothing decided yet), `partial` (hunks left, some decided), `accepted`
  (nothing pending, at least one hunk accepted), `rejected` (nothing pending, only rejects).
- `undoable`: `POST …/undo` with this path can restore the content before this file's last reject.
- `accepted`/`rejected`: hunks of this file decided so far. `decided`: the latest decided hunks (at most 50,
  oldest first), each the hunk as it was when decided plus `state` (`accepted`/`rejected`) and `at`; an undo
  drops the rejects it reverts.
- `counts`: `files` = files with pending hunks, `pending` = pending hunks, `accepted`/`rejected` = hunks
  decided so far, `additions`/`deletions` = pending lines.

### `Content` (JSON)

```json
{
  "path": "a.txt",
  "binary": false,
  "before": "one\ntwo\n…",
  "after": "one\nTWO\n…",
  "hunks": [{ "id": "8a1f0c2d3e4b5a69", "oldStart": 2, "oldLines": 1, "newStart": 2, "newLines": 1, "patch": "…" }]
}
```

`before` is omitted for an added file, `after` for a deleted one, both for binary files.

## Events

Registered in `featureDefinitions` (`packages/schema/src/event-manifest.ts`), published through
`EventV2Bridge` with `location.directory` = the directory the session ran in (opencode: its instance
directory; Agent HQ: the identity's working directory), so they reach `/event?directory=…` and the global
stream with that directory.

| Type                       | Data                                           | When                                                                                     |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `review.changeset.updated` | `{ changeset: ChangeSet }` (same shape as GET) | a step or turn recorded files, a file moved to another changeset, any accept/reject/undo |
| `review.changeset.removed` | `{ id }`                                       | the owning opencode session was deleted                                                  |

Hunks change whenever the file changes on disk, but the server only publishes on the moments above; a UI
that shows a file the user is editing should refetch on its own file events.

## Files

New: `packages/schema/src/review.ts`, `packages/opencode/src/review/changes.ts` (`ReviewChanges` service),
`packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/review.ts`,
`packages/opencode/test/review/review.test.ts`, `packages/opencode/test/server/httpapi-exercise/review.ts`.

Upstream-owned files touched (each line marked `spicy:`; please add to `SPICY.md`):

| File                                                             | Change                                                                                                       | Why                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `packages/schema/src/event-manifest.ts`                          | import `Review`; `...Review.Event.Definitions` in `featureDefinitions` (2 lines)                             | publish the events                                                                     |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | import + `.addHttpApi(ReviewApi)` (2 lines)                                                                  | compose the group                                                                      |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | import + `reviewHandlers` in `instanceApiRoutes`; import + `ReviewChanges.node` in the `app` group (4 lines) | serve the routes and start the service (its event subscription runs from server start) |
| `packages/opencode/test/server/httpapi-exercise/index.ts`        | import + `...reviewScenarios` (2 lines)                                                                      | `test:httpapi --fail-on-missing`                                                       |

Spicy-owned file touched: `packages/opencode/src/agenthq/session.ts` (import, `yield* ReviewChanges.Service`,
`review.observeAgent(...)` at the end of `record`, `ReviewChanges.node` in deps; 4 marked lines).

No upstream session, snapshot or processor code changed: the service reuses the snapshot store and the
patch parts the processor already writes. The snapshot store path is duplicated in `gitdir()` (comment
points at `src/snapshot`); REV-05 reads baselines from it, so a drift fails tests. No new dependency (`diff`
is already one).

## Tests

`packages/opencode/test/review/review.test.ts`: REV-01..05, REV-07 and REV-08 run real OpenCode sessions with the
fake model (`test/lib/llm-server.ts`) through the real server routes in temp git repos; REV-06 drives the
Agent HQ hook directly (no external adapter exists yet).

| ID     | Scenario                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REV-01 | session edits a file (two hunks) and adds one → one changeset, exact hunks/patches/counts; accept hunk 1 + reject hunk 2 → the file holds exactly hunk 1; `review.changeset.updated` reaches GlobalBus with the project directory and equals the response |
| REV-02 | added + deleted (bash `rm`) + modified files; reject added → deleted, reject deleted → restored; undo → change back, second undo → 409; accept all; reject all after that is a no-op; deleting the session → `review.changeset.removed` + 404             |
| REV-03 | the human edits the hunk's lines after listing → 409, file untouched; unknown file / changeset → 404; bad action / id → 400                                                                                                                               |
| REV-04 | next turn hangs in the model → reject hunk/file/all → 409 `agent is still editing`, file untouched; after abort the reject goes through                                                                                                                   |
| REV-05 | server restart (second app lifetime) → identical changesets; rejecting a hunk reads the persisted baseline                                                                                                                                                |
| REV-06 | external provider turn: snapshot at the user message; reported `file.changed` shows up live with `agentID`; reject mid-turn → 409; turn end finds the unreported file; reject all restores both; OpenCode-provider sessions are ignored by the hook       |
| REV-07 | forking a session re-publishes its patch parts → no fork changeset, the accepted file is not re-baselined (fails without the busy gate)                                                                                                                   |
| REV-08 | the content route: both sides byte for byte (a leading blank line and the final newline survive) with the hunks of the same read; unknown path → 404; nothing pending → no sides                                                                          |

`test:httpapi` scenarios for all seven routes (seeded document + shadow store; list, get, accept file,
reject all, undo → 200; stale hunk → 409).

Results (from `packages/opencode`, 2026-10-12; first round, before the UI work):

| Command                                                                                                                   | Result                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test --timeout 60000 test/review`                                                                                    | 7 pass, 0 fail (5 consecutive runs green)                                                                                                                                                                                  |
| `bun test --timeout 60000 test/lsp test/workbench test/agenthq test/tool test/session test/server test/agent test/review` | 1250 pass, 9 skip, 1 todo, 1 fail: `httpapi-v2-pty` "retains exited sessions" (20 s PTY timeout at load average ~30 from parallel agents; passes alone, 2/2; the flake notes-problems.md describes). Baseline 1244 + 7 new |
| `bun run test:httpapi` (coverage, auth, effect)                                                                           | 226 pass, 0 fail, 0 skip, 0 missing in each mode, exit 0                                                                                                                                                                   |
| `bun run typecheck` (opencode, schema)                                                                                    | clean                                                                                                                                                                                                                      |
| `bun run generate` (packages/client)                                                                                      | no diff                                                                                                                                                                                                                    |

Second round (with the UI additions: decided log, `content` route), on `spicy-ide` fe1c8528b + this work:
`bun test --timeout 60000 test/agenthq test/session test/server test/workbench test/review` 891 pass, 12 skip,
1 todo, 0 fail; `test/review` 8 pass; `bun run test:httpapi` 256 pass, 0 fail, 0 missing in each mode;
`bun run typecheck` clean in opencode, schema, session-ui and app.

## Gaps and limits

- Only git projects with snapshots enabled (`snapshot !== false`); otherwise there are no changesets.
- Only the V1 prompt loop (`SessionPrompt` + processor) is observed; that is what the app, TUI, OpenCode
  Native and Agent HQ use. The V2 core runner (`packages/core/src/session/runner`) is not.
- The snapshot cannot tell agent edits from edits the human makes in the same file _during_ a step; those
  show up as the agent's hunks (visible, never silently reverted).
- A file the human edits after accepting part of it, while hunks are still pending, mixes both into the
  pending diff (no three-way merge).
- Rejecting a deleted file restores its content with the default file mode (the exec bit is not kept).
- `agenthq-session` changesets are not removed when the Agent HQ identity or session is deleted; the hook
  path is only exercised by REV-06 until an external adapter lands. Turn state is in memory: a turn
  interrupted by a restart keeps the files it reported, unreported ones are missed.
- `agentID` is not filled for Agent HQ sessions on the OpenCode provider; map them with
  `ownerID = providerSessionID`.
- Subagent (`task`) sessions are sessions of their own, so their edits form their own changesets
  (`owner.id` = the child session id); a UI that wants one list per conversation groups by `parentID`.
- Settled changesets stay listed (with their final states) until their session is deleted.
- Each view re-reads baselines and files (one `git cat-file` per pending file); events carry the full
  changeset. Both are fine at session scale; a blob cache and summary events are the upgrade path.
- Two opencode processes sharing one data directory each keep their own in-memory busy state.
- Pre-existing on `spicy-ide` (not changed here): `packages/schema/test/event-manifest.test.ts` and
  `packages/opencode/test/event-manifest.test.ts` assert upstream event counts (55/85, 88) that the wave-1
  events already broke; review adds two events (now 71 server / 101 latest).
- The legacy JS SDK was not regenerated (same as the other wave-1 groups); regenerate once after
  integration.

## App UI: Agent changes review (wave 2)

Built on the routes above, in the app's new layout (the default). Two places, one state
(`packages/app/src/review/context.tsx`, per workspace, mounted next to the Workbench providers):

- **Review panel, "Agent changes" mode** (the panel's change-mode dropdown, next to Git / Branch / Last turn).
  The file list groups files by changeset, one per agent session, headed by the agent's name: the Agent HQ
  identity (name and avatar) for Agent HQ sessions on any provider (an `agenthq-session` owner's `agentID`, or
  the Agent HQ session whose `providerSessionID` is the opencode session), "OpenCode" plus the session title
  otherwise. The header shows Pending / Accepted / Rejected hunk counts with Accept all and Reject all; each file
  row shows its pending hunk count and state. The preview is the file's diff (the panel's diff style and expand
  mode apply) with a bar under every pending hunk (Pending, Accept, Reject), the file's actions (Open file,
  Accept file, Reject file, Undo reject) and "Reviewed changes": every decided hunk with its state and patch.
- **File view**: a file with pending agent changes opens as an inline unified diff of the whole file
  (removed lines red, added green) with the same hunk bars, under a sticky review bar: agent, pending count,
  previous / next changed file ("File n of m"), Accept file, Reject file, Undo reject. With nothing pending
  the file view renders exactly as before (the seam is one wrapper; the review code is a lazy chunk).
- **Content**: diffs come from `GET …/content` (exact text and the hunks of the same read), refetched when
  the changeset, its listed hunk ids or the open file's text change.
- **Live**: `review.changeset.updated` / `.removed` from the workspace event stream; a decision also applies
  its reply. A copy with an older `updatedAt` never replaces a newer one. One decision per file at a time.
- **409s** are explained inline (file or changeset level) until the next decision or Dismiss, and the
  changesets reload: "You edited these lines since. Showing the current changes.", "The agent is still
  editing. Try again when it finishes.", "The file changed while you were reviewing it. …", "There is nothing
  to undo for this file.", "The file changed after the reject, so the reject can't be undone.", "Some files
  could not be updated: …". Other failures show "The review could not be updated: …".
- **Keyboard** (app command system, category Review, rebindable like every command): Next agent change
  `alt+F5`, Previous `shift+alt+F5` (VS Code's next/previous change), Accept agent change `mod+shift+Y`,
  Reject agent change `mod+shift+K`; Accept / Reject agent changes in file and Review agent changes (opens the
  panel in this mode) have no default key. They act on the focused hunk: showing a file focuses its first
  hunk, clicking a bar focuses it, and next/previous cross files (the panel selects the file; an active file
  view opens the next file's tab). The spicy-ui `EDITABLE_KEYBIND_IDS` seam is not needed: these shortcuts
  have modifiers, which the command system already lets through inside text inputs.

### Files

Fork-owned: `packages/app/src/review/{model.ts,model.test.ts,context.tsx,view.tsx}`,
`packages/app/e2e/regression/review-agent-changes.spec.ts`; additions to `packages/app/src/workbench/client.ts`
(review routes; `WorkbenchRequestError.status`) and `packages/app/src/workbench/en.ts` (`review.*` copy).
Backend additions for the UI: `File.accepted` / `rejected` / `decided` and `GET …/content` (`Review.Content`),
with REV-01/02/08 and a `test:httpapi` scenario.

Upstream-owned files touched (each edit marked `spicy:`; please add to `SPICY.md`):

| File                                           | Change                                                                                                                                                                                                                | Why                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `packages/app/src/pages/session.tsx`           | import; `ChangeMode` + `"agent"`; `<ReviewProvider>` inside `<WorkbenchProviders>`; `useReview()`; `"agent"` option (new layout); its label; `reviewDiffs` branch; `<Show>` picking `ReviewChangesPanel` for the mode | the mode, state and panel  |
| `packages/app/src/context/layout.tsx`          | `ReviewChangeMode` + `"agent"`; persisted mode accepts it                                                                                                                                                             | remember the mode          |
| `packages/app/src/pages/session/file-tabs.tsx` | import; `<ReviewFileGate>` around the new-layout file render                                                                                                                                                          | inline review in file view |

No edits to `session-ui`, `review-panel-v2.tsx`, `workbench/panel.tsx`, `terminal-panel-v2.tsx` or keybind
code: the agent mode reuses the `SessionReviewV2` / `SessionReviewV2Sidebar` shells, the panel state and the
pierre `File` component.

### UI tests

| Test                                                                                                                                                                                                                                        | Result                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun test --conditions=solid --preload ./happydom.ts ./src/review` (app)                                                                                                                                                                    | 10 pass: hunk anchors, 409 reasons, path ownership, file stepping, agent naming for both owner kinds; state: load, events, older copies ignored, coalesced reloads, unavailable server, one decision per file, 409 → explained + reload, other failures → explained only |
| `e2e/regression/review-agent-changes.spec.ts` (real server, fake model)                                                                                                                                                                     | pass, 3/3 with `--repeat-each=3 --workers=1`                                                                                                                                                                                                                             |
| existing e2e: review-open-file, review-tab-switch, review-state-persistence, review-line-comment, review-image-flash, review-terminal-stacked, file-browser-sidebar-tab-switch, open-file-expand-folder, terminal-tab-switch, agenthq-panel | 17 pass                                                                                                                                                                                                                                                                  |
| app `bun run test:unit`                                                                                                                                                                                                                     | 508 pass / 23 fail / 16 errors; baseline on this commit 498 / 23 / 16 (+10 new); the same failing tests (`jsxDEV` on bun 1.4.3)                                                                                                                                          |
| app `bun run typecheck`                                                                                                                                                                                                                     | clean                                                                                                                                                                                                                                                                    |

The e2e starts `opencode serve` from this checkout (isolated XDG dirs, port `PLAYWRIGHT_SERVER_PORT`, so the
app's default server is that one too) and an OpenAI-compatible stub that scripts the model: a session writes
two hunks in `a.txt` and one in `b.txt`; an Agent HQ agent "Ada" (OpenCode provider) writes `c.txt` after the
test answers its permission request (nothing is auto-approved). It checks: two changesets named "Ada" and
"OpenCode"; both files pending; two inline hunk bars; accepting the focused hunk with `mod+shift+Y`; editing the
second hunk's line on disk, then rejecting the listed hunk → inline "You edited these lines since" and the
current hunk shown; rejecting that → `a.txt` holds exactly the accepted change; opening `b.txt` from the
preview → review bar and inline hunk in the file view; rejecting it there → `b.txt` restored; row states
accepted / rejected. Run from `packages/app`:

```sh
PLAYWRIGHT_PORT=3318 PLAYWRIGHT_SERVER_PORT=4318 bunx playwright test e2e/regression/review-agent-changes.spec.ts
```

(The emulated "Desktop Chrome" device reports `navigator.platform = "Win32"`, so the spec presses `Control+…`.)
Screenshots: `packages/app/e2e/test-results/<test>/1-review-panel.png` … `5-all-reviewed.png` (gitignored).

Benchmarks (AGENTS.md rule; production builds; `first-navigation`, `session-tab-switch`, `review-pane-scaling`):
interleaved pairs with only the three upstream seams reverted vs applied, machine load average 25–48 from other
agents. Session tab switching and the review pane differ in both directions within run-to-run noise (e.g. v2
closed cold first paint 18.9 → 19.1 ms, review pane 1000 files 214.7 → 195.4 ms). First navigation, 6
samples each: 38.5 → 38.1, 35.8 → 36.0, 48.8 → 48.5 ms (stable destination). A non-interleaved earlier pair
looked slower, which the interleaved runs did not reproduce.

### UI gaps

- New layout only: the old layout (and mobile) has no "Agent changes" mode; the option is hidden there.
- Line comments are not offered in the agent diff or the inline file diff.
- Hunk bars sit at the server's hunk positions; pierre computes its own diff of the same texts, so in an
  ambiguous case a bar can sit next to a differently grouped change (the decision still targets the right
  hunk).
- The review panel picks up edits made outside the app only with the next changeset update or 409; the file
  view refetches when its text changes.
- A path outside the open directory (an instance opened on a worktree subfolder) cannot open a file tab.
- Agent names come from the Agent HQ roster loaded in this window; an identity it doesn't know shows as
  "OpenCode".
