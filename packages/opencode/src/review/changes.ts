// Spicy review: Cursor-style accept/reject of the edits agent sessions make.
//
// Every file a session touches gets an accepted baseline: its bytes before the agent first touched it,
// stored as a blob in the project's snapshot object store (the shadow git under
// Global.Path.data/snapshot, see src/snapshot; one ref keeps those blobs out of its 7-day gc). Pending
// hunks are always diff(baseline, working tree). Accept moves the baseline forward; reject rewrites
// exactly that region of the working tree and refuses when the file no longer matches. The
// repository's index, commits and branches are never touched.
//
// State is one JSON document per worktree (["review", projectID, hash(worktree)]): file -> baseline,
// changeset -> decisions, and a bounded undo list. A pending file belongs to the changeset of the
// session that touched it last, so every pending hunk is listed exactly once.
//
// OpenCode sessions are observed through their patch parts (one per step, carrying the step-start
// snapshot); Agent HQ sessions of external providers through `observeAgent`, which the Agent HQ
// session manager calls with every batch of events.
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { EventV2 } from "@opencode-ai/core/event"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Review } from "@opencode-ai/schema/review"
import { diffArrays } from "diff"
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { SessionStatus } from "@/session/status"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"

const UNDO_LIMIT = 100
const LOG_LIMIT = 50
// Larger files, binary files and files that are not UTF-8 are reviewed as one whole-file hunk.
const TEXT_LIMIT = 1024 * 1024
const DIFF_TIMEOUT = 2_000
const KEEP_REF = "refs/opencode/review"
const ACTIVE = new Set<AgentHQ.AgentSessionStatus>(["starting", "thinking", "working", "needs_approval", "blocked"])

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Review.NotFoundError", {
  message: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Review.ConflictError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export interface Filter {
  readonly ownerKind?: Review.Owner["kind"]
  readonly ownerID?: string
  readonly agentID?: string
}

type Failure = NotFoundError | ConflictError

export interface Interface {
  /** Changesets of the current instance's worktree that list at least one file, newest first. */
  readonly list: (filter?: Filter) => Effect.Effect<Review.ChangeSet[]>
  readonly get: (id: Review.ChangeSetID) => Effect.Effect<Review.ChangeSet, NotFoundError>
  /** Both sides of a file and its pending hunks, from one read (the UI's diff source). */
  readonly content: (id: Review.ChangeSetID, file: string) => Effect.Effect<Review.Content, NotFoundError>
  readonly hunk: (
    id: Review.ChangeSetID,
    hunkID: string,
    action: Review.Action,
  ) => Effect.Effect<Review.ChangeSet, Failure>
  readonly file: (
    id: Review.ChangeSetID,
    file: string,
    action: Review.Action,
  ) => Effect.Effect<Review.ChangeSet, Failure>
  readonly all: (id: Review.ChangeSetID, action: Review.Action) => Effect.Effect<Review.ChangeSet, Failure>
  /** Restores the content a file had before its last reject in this changeset. */
  readonly undo: (id: Review.ChangeSetID, file: string) => Effect.Effect<Review.ChangeSet, Failure>
  /** Agent HQ hook: snapshots each turn of an external provider's session and records the files it changed. */
  readonly observeAgent: (
    session: AgentHQ.AgentSessionInfo,
    agent: AgentHQ.AgentIdentity,
    envelopes: readonly AgentHQ.AgentEventEnvelope[],
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReviewChanges") {}

interface Where {
  readonly projectID: string
  readonly worktree: string
  readonly directory: string
}

// ---------------------------------------------------------------- stored document

interface Entry {
  base: string | null // blob of the accepted content; null: the file did not exist
  owner: string // changeset of the session that touched the file last
  settled: boolean // decided down to the baseline; the next agent touch starts from a fresh baseline
}

interface Decided {
  accepted: number
  rejected: number
  status: Review.File["status"]
  log?: Review.DecidedHunk[] // newest last, at most LOG_LIMIT
}

interface Stored {
  owner: Review.Owner
  agentID?: string
  directory: string
  updatedAt: number
  decided: Record<string, Decided>
}

interface UndoRecord {
  changeset: string
  path: string
  before: string | null // blob of the content before the reject
  after: string | null // git blob id of the content the reject wrote (not stored)
  hunks: number
}

interface Doc {
  files: Record<string, Entry>
  changesets: Record<string, Stored>
  undo: UndoRecord[]
}

interface Block {
  readonly oldIndex: number
  readonly newIndex: number
  readonly removed: string[]
  readonly added: string[]
}

interface Inspected {
  readonly path: string
  readonly entry: Entry
  readonly status: Review.File["status"]
  readonly binary: boolean
  readonly before: Uint8Array | null
  readonly after: Uint8Array | null
  readonly lines?: { readonly before: string[]; readonly after: string[]; readonly blocks: Block[] } // modified text
  readonly hunks: Review.Hunk[]
  readonly additions: number
  readonly deletions: number
}

interface Turn {
  readonly where: Where
  readonly tree: string
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const appProcess = yield* AppProcess.Service
    const fs = yield* FSUtil.Service
    const store = yield* InstanceStore.Service
    const snapshot = yield* Snapshot.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const busy = new Set<string>() // opencode sessions mid-turn
    const turns = new Map<string, Turn>() // Agent HQ sessions mid-turn, with their turn-start snapshot

    // ---------------------------------------------------------------- snapshot object store

    const git = (where: Where, args: string[], stdin?: string | Uint8Array) =>
      appProcess
        .run(
          ChildProcess.make(
            "git",
            ["-c", "core.autocrlf=false", "--git-dir", gitdir(where), "--work-tree", where.worktree, ...args],
            { cwd: where.worktree, extendEnv: true },
          ),
          stdin === undefined ? undefined : { stdin },
        )
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout : undefined)),
          Effect.orElseSucceed(() => undefined),
        )

    const readBlob = (where: Where, sha: string) => git(where, ["cat-file", "blob", sha])

    const writeBlob = (where: Where, bytes: Uint8Array) =>
      git(where, ["hash-object", "-w", "--no-filters", "--stdin"], bytes).pipe(
        Effect.map((out) => out?.toString("utf8").trim() || undefined),
      )

    // Baselines of files first touched after `tree` was captured, as working-tree bytes (eol and
    // other attributes applied): blob id, or null when the file did not exist. Paths that are not
    // regular files are left out. Undefined when the tree is gone.
    const baselines = Effect.fnUntraced(function* (where: Where, tree: string, files: string[]) {
      const listing = yield* git(where, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", tree, "--", ...files])
      if (!listing) return undefined
      const modes = new Map(
        listing
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map((line) => [line.slice(line.indexOf("\t") + 1), line.split(" ")[0]] as const),
      )
      const result = new Map<string, string | null>()
      for (const file of files) {
        const mode = modes.get(file)
        if (mode === undefined) {
          result.set(file, null)
          continue
        }
        if (mode !== "100644" && mode !== "100755") continue
        const bytes = yield* git(where, ["cat-file", "--filters", `${tree}:${file}`])
        const sha = bytes ? yield* writeBlob(where, bytes) : undefined
        if (sha) result.set(file, sha)
      }
      return result
    })

    // One ref to a tree of every blob the document needs, so the snapshot store's gc keeps them.
    const keep = Effect.fnUntraced(function* (where: Where, doc: Doc) {
      const blobs = new Set(
        [...Object.values(doc.files).map((entry) => entry.base), ...doc.undo.map((item) => item.before)].filter(
          (sha): sha is string => !!sha,
        ),
      )
      if (!blobs.size) return yield* git(where, ["update-ref", "-d", KEEP_REF])
      const tree = yield* git(where, ["mktree", "-z"], [...blobs].map((sha) => `100644 blob ${sha}\t${sha}\0`).join(""))
      if (!tree) return yield* Effect.logWarning("review: could not pin baselines", { worktree: where.worktree })
      return yield* git(where, ["update-ref", KEEP_REF, tree.toString("utf8").trim()])
    })

    // ---------------------------------------------------------------- working tree

    // Bytes of a working-tree file: null when it is missing, undefined when it is not a regular file.
    const current = Effect.fnUntraced(function* (file: string) {
      if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null
      return yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => undefined))
    })

    const inspect = Effect.fnUntraced(function* (where: Where, file: string, entry: Entry) {
      if (entry.settled) return undefined
      const before = entry.base === null ? null : yield* readBlob(where, entry.base)
      const after = yield* current(path.join(where.worktree, file))
      if (before === undefined) {
        yield* Effect.logWarning("review: baseline is missing", { file, base: entry.base })
        return undefined
      }
      if (after === undefined || same(before, after)) return undefined
      return compare(file, entry, before, after)
    })

    const inspectOwned = (where: Where, doc: Doc, id: string) =>
      Effect.forEach(
        Object.entries(doc.files).filter((item) => item[1].owner === id),
        (item) => inspect(where, item[0], item[1]),
        { concurrency: 8 },
      ).pipe(Effect.map((items) => items.filter((item): item is Inspected => item !== undefined)))

    // ---------------------------------------------------------------- document

    const load = (where: Where) =>
      storage.read<Doc>(key(where)).pipe(Effect.orElseSucceed((): Doc => ({ files: {}, changesets: {}, undo: [] })))

    const lock = (where: Where) => locks.withLock(key(where).join("/"))

    // ponytail: every view re-reads baselines and files (one git spawn per pending file); add a blob cache if lists get slow.
    const view = Effect.fnUntraced(function* (where: Where, doc: Doc, id: string) {
      const stored = doc.changesets[id]
      const pending = new Map((yield* inspectOwned(where, doc, id)).map((item) => [item.path, item]))
      const files = [...new Set([...pending.keys(), ...Object.keys(stored.decided)])].toSorted().map((file) =>
        present(
          file,
          pending.get(file),
          stored.decided[file],
          doc.undo.some((item) => item.changeset === id && item.path === file),
        ),
      )
      const decided = Object.values(stored.decided)
      return {
        id: Review.ChangeSetID.make(id),
        owner: stored.owner,
        ...(stored.agentID ? { agentID: stored.agentID } : {}),
        files,
        counts: {
          files: files.filter((item) => item.hunks.length).length,
          pending: sum(files.map((item) => item.hunks.length)),
          accepted: sum(decided.map((item) => item.accepted)),
          rejected: sum(decided.map((item) => item.rejected)),
          additions: sum(files.map((item) => item.additions)),
          deletions: sum(files.map((item) => item.deletions)),
        },
        updatedAt: stored.updatedAt,
      } satisfies Review.ChangeSet
    })

    // Persists the document, pins its blobs and publishes the given changesets.
    const commit = Effect.fnUntraced(function* (where: Where, doc: Doc, ids: Iterable<string>) {
      yield* storage.write(key(where), doc).pipe(Effect.orDie)
      yield* keep(where, doc)
      return yield* Effect.forEach(
        [...new Set(ids)].filter((id) => doc.changesets[id]),
        (id) =>
          Effect.gen(function* () {
            const changeset = yield* view(where, doc, id)
            yield* events.publish(Review.Event.ChangeSetUpdated, { changeset }, at(doc.changesets[id].directory))
            return changeset
          }),
      )
    })

    // ---------------------------------------------------------------- recording

    const record = Effect.fnUntraced(function* (
      where: Where,
      owner: Review.Owner,
      agentID: string | undefined,
      tree: string,
      changed: readonly string[],
    ) {
      const files = [
        ...new Set(
          changed.map((file) =>
            path.relative(where.worktree, path.resolve(where.directory, file)).replaceAll("\\", "/"),
          ),
        ),
      ].filter(
        (file) => file && file !== ".." && !file.startsWith("../") && !path.isAbsolute(file) && !file.includes("\n"),
      )
      if (!files.length) return
      const id = changesetID(owner)
      yield* lock(where)(
        Effect.gen(function* () {
          const doc = yield* load(where)
          // A settled file starts over from the step's snapshot: edits the human made after deciding it
          // are theirs, not the agent's.
          const fresh = files.filter((file) => doc.files[file]?.settled ?? true)
          const bases = fresh.length ? yield* baselines(where, tree, fresh) : new Map<string, string | null>()
          if (!bases) return yield* Effect.logWarning("review: snapshot is gone", { tree, worktree: where.worktree })
          const touched = new Set<string>()
          for (const file of files) {
            const entry = doc.files[file]
            if (entry && !entry.settled) {
              touched.add(entry.owner)
              entry.owner = id
              touched.add(id)
              continue
            }
            const base = bases.get(file)
            if (base === undefined) continue
            doc.files[file] = { base, owner: id, settled: false }
            touched.add(id)
          }
          if (!touched.size) return
          const stored = (doc.changesets[id] ??= {
            owner,
            ...(agentID ? { agentID } : {}),
            directory: where.directory,
            updatedAt: 0,
            decided: {},
          })
          stored.updatedAt = Date.now()
          yield* commit(where, doc, touched)
        }),
      )
    })

    const forget = Effect.fnUntraced(function* (where: Where, id: string) {
      yield* lock(where)(
        Effect.gen(function* () {
          const doc = yield* load(where)
          const stored = doc.changesets[id]
          if (!stored) return
          // The session's pending edits stay in the working tree; they are just no longer under review.
          doc.changesets = Object.fromEntries(Object.entries(doc.changesets).filter((item) => item[0] !== id))
          doc.files = Object.fromEntries(Object.entries(doc.files).filter((item) => item[1].owner !== id))
          doc.undo = doc.undo.filter((item) => item.changeset !== id)
          yield* storage.write(key(where), doc).pipe(Effect.orDie)
          yield* keep(where, doc)
          yield* events.publish(
            Review.Event.ChangeSetRemoved,
            { id: Review.ChangeSetID.make(id) },
            at(stored.directory),
          )
        }),
      )
    })

    // Patches are recorded in publish order by one worker, so a file's first step sets its baseline.
    const work = yield* Queue.unbounded<Effect.Effect<void>>()
    yield* Queue.take(work).pipe(
      Effect.flatten,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logError("review update failed", { cause }),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
    // One ordered stream, so a turn's last patch is always seen before its session turns idle.
    yield* events.all().pipe(
      Stream.runForEach((event) => {
        if (is(SessionStatus.Event.Status, event)) {
          if (event.data.status.type === "idle") busy.delete(event.data.sessionID)
          else busy.add(event.data.sessionID)
          return Effect.void
        }
        const where = locate(event.location)
        if (!where) return Effect.void
        // Only a running turn writes patches; forks and imports re-publish old ones, which are history.
        if (is(SessionV1.Event.PartUpdated, event)) {
          const part = event.data.part
          if (part.type !== "patch" || !busy.has(part.sessionID)) return Effect.void
          const owner = { kind: "opencode-session" as const, id: part.sessionID }
          return Queue.offer(work, record(where, owner, undefined, part.hash, part.files))
        }
        if (is(SessionV1.Event.Deleted, event))
          return Queue.offer(work, forget(where, changesetID({ kind: "opencode-session", id: event.data.sessionID })))
        return Effect.void
      }),
      Effect.forkScoped,
    )

    // ---------------------------------------------------------------- decisions

    const editing = (stored: Stored) =>
      stored.owner.kind === "opencode-session" ? busy.has(stored.owner.id) : turns.has(stored.owner.id)

    const idle = (stored: Stored) =>
      editing(stored) ? Effect.fail(new ConflictError({ message: "agent is still editing" })) : Effect.void

    // Applies one decision. `block` picks one hunk of a modified text file; without it the whole file
    // is decided.
    const decide = Effect.fnUntraced(function* (
      where: Where,
      doc: Doc,
      id: string,
      item: Inspected,
      action: Review.Action,
      index?: number,
    ) {
      const stored = doc.changesets[id]
      // `index` picks one hunk; whole-file items (added, deleted, binary) have no blocks and decide as a file.
      const block = index === undefined ? undefined : item.lines?.blocks[index]
      const hunks = index === undefined ? item.hunks : item.hunks.slice(index, index + 1)
      const count = hunks.length
      if (action === "accept") {
        const next =
          block && item.lines
            ? splice(item.lines.before, block.oldIndex, block.removed.length, block.added)
            : item.after
        const base = next === null ? null : yield* writeBlob(where, next)
        if (base === undefined)
          return yield* new ConflictError({ message: "could not store the accepted content", path: item.path })
        item.entry.base = base
        // Accepting while the agent still works must not let its next step reset the baseline.
        item.entry.settled = same(next, item.after) && !editing(stored)
      }
      if (action === "reject") {
        const next =
          block && item.lines
            ? splice(item.lines.after, block.newIndex, block.added.length, block.removed)
            : item.before
        yield* rewrite(where, doc, id, item, next, count)
        item.entry.settled = same(next, item.before)
      }
      const decided = (stored.decided[item.path] ??= { accepted: 0, rejected: 0, status: item.status })
      decided.status = item.status
      if (action === "accept") decided.accepted += count
      if (action === "reject") decided.rejected += count
      const at = Date.now()
      const state = action === "accept" ? ("accepted" as const) : ("rejected" as const)
      decided.log = [...(decided.log ?? []), ...hunks.map((hunk) => ({ ...hunk, state, at }))].slice(-LOG_LIMIT)
    })

    // Writes `next` over a file whose hunks were computed from `item.after`, never over anything else.
    const rewrite = Effect.fnUntraced(function* (
      where: Where,
      doc: Doc,
      id: string,
      item: Inspected,
      next: Uint8Array | null,
      hunks: number,
    ) {
      const abs = path.join(where.worktree, item.path)
      const now = yield* current(abs)
      if (now === undefined || !same(now, item.after))
        return yield* new ConflictError({ message: "the file changed while it was being reviewed", path: item.path })
      const before = item.after === null ? null : yield* writeBlob(where, item.after)
      if (before === undefined)
        return yield* new ConflictError({ message: "could not store the content for undo", path: item.path })
      yield* put(abs, next, item.path)
      doc.undo.push({ changeset: id, path: item.path, before, after: blobID(next), hunks })
      doc.undo.splice(0, Math.max(0, doc.undo.length - UNDO_LIMIT))
    })

    const put = (file: string, content: Uint8Array | null, label: string) =>
      (content === null ? fs.remove(file) : fs.writeWithDirs(file, content)).pipe(
        Effect.mapError(
          (error) => new ConflictError({ message: `could not write ${label}: ${error.message}`, path: label }),
        ),
      )

    // Runs one decision under the worktree lock. Whatever it changed is persisted and published, even
    // when it fails part-way (reject all), and the failure is still reported.
    const mutate = (
      id: Review.ChangeSetID,
      body: (where: Where, doc: Doc, stored: Stored) => Effect.Effect<void, Failure>,
    ) =>
      Effect.gen(function* () {
        const where = yield* here
        return yield* lock(where)(
          Effect.gen(function* () {
            const doc = yield* load(where)
            const stored = doc.changesets[id]
            if (!stored) return yield* new NotFoundError({ message: `Changeset not found: ${id}` })
            const before = JSON.stringify(doc)
            const exit = yield* body(where, doc, stored).pipe(Effect.exit)
            if (JSON.stringify(doc) === before) {
              if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
              return yield* view(where, doc, id)
            }
            stored.updatedAt = Date.now()
            const [changeset] = yield* commit(where, doc, [id])
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
            return changeset
          }),
        )
      })

    // ---------------------------------------------------------------- operations

    const list = Effect.fn("ReviewChanges.list")(function* (filter: Filter = {}) {
      const where = yield* here
      const doc = yield* load(where)
      const ids = Object.entries(doc.changesets)
        .filter(
          (item) =>
            (!filter.ownerKind || item[1].owner.kind === filter.ownerKind) &&
            (!filter.ownerID || item[1].owner.id === filter.ownerID) &&
            (!filter.agentID || item[1].agentID === filter.agentID),
        )
        .map((item) => item[0])
      const views = yield* Effect.forEach(ids, (id) => view(where, doc, id), { concurrency: 4 })
      return views.filter((item) => item.files.length).toSorted((a, b) => b.updatedAt - a.updatedAt)
    })

    const get = Effect.fn("ReviewChanges.get")(function* (id: Review.ChangeSetID) {
      const where = yield* here
      const doc = yield* load(where)
      if (!doc.changesets[id]) return yield* new NotFoundError({ message: `Changeset not found: ${id}` })
      return yield* view(where, doc, id)
    })

    const content = Effect.fn("ReviewChanges.content")(function* (id: Review.ChangeSetID, target: string) {
      const where = yield* here
      const doc = yield* load(where)
      const stored = doc.changesets[id]
      if (!stored) return yield* new NotFoundError({ message: `Changeset not found: ${id}` })
      const entry = doc.files[target]
      if (!entry || (entry.owner !== id && !stored.decided[target]))
        return yield* new NotFoundError({ message: `File not in changeset ${id}: ${target}` })
      const item = entry.owner === id ? yield* inspect(where, target, entry) : undefined
      if (!item) return { path: target, binary: false, hunks: [] } satisfies Review.Content
      const before = item.binary || item.before === null ? undefined : text(item.before)
      const after = item.binary || item.after === null ? undefined : text(item.after)
      return {
        path: target,
        binary: item.binary,
        hunks: item.hunks,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      } satisfies Review.Content
    })

    const hunk = Effect.fn("ReviewChanges.hunk")(function* (
      id: Review.ChangeSetID,
      hunkID: string,
      action: Review.Action,
    ) {
      return yield* mutate(id, (where, doc, stored) =>
        Effect.gen(function* () {
          if (action === "reject") yield* idle(stored)
          const items = yield* inspectOwned(where, doc, id)
          const item = items.find((candidate) => candidate.hunks.some((h) => h.id === hunkID))
          if (!item)
            return yield* new ConflictError({
              message: `hunk ${hunkID} no longer matches the working tree; reload the changeset`,
            })
          const index = item.hunks.findIndex((h) => h.id === hunkID)
          yield* decide(where, doc, id, item, action, index)
        }),
      )
    })

    const file = Effect.fn("ReviewChanges.file")(function* (
      id: Review.ChangeSetID,
      target: string,
      action: Review.Action,
    ) {
      return yield* mutate(id, (where, doc, stored) =>
        Effect.gen(function* () {
          if (action === "reject") yield* idle(stored)
          const entry = doc.files[target]
          if (entry?.owner !== id) {
            if (stored.decided[target]) return
            return yield* new NotFoundError({ message: `File not in changeset ${id}: ${target}` })
          }
          const item = yield* inspect(where, target, entry)
          if (item) yield* decide(where, doc, id, item, action)
        }),
      )
    })

    const all = Effect.fn("ReviewChanges.all")(function* (id: Review.ChangeSetID, action: Review.Action) {
      return yield* mutate(id, (where, doc, stored) =>
        Effect.gen(function* () {
          if (action === "reject") yield* idle(stored)
          const items = yield* inspectOwned(where, doc, id)
          const exits = yield* Effect.forEach(items, (item) => decide(where, doc, id, item, action).pipe(Effect.exit))
          const failed = items.filter((_, index) => Exit.isFailure(exits[index])).map((item) => item.path)
          if (failed.length)
            return yield* new ConflictError({
              message: `${failed.length} file(s) could not be ${action === "accept" ? "accepted" : "rejected"}: ${failed.join(", ")}`,
            })
        }),
      )
    })

    const undo = Effect.fn("ReviewChanges.undo")(function* (id: Review.ChangeSetID, target: string) {
      return yield* mutate(id, (where, doc, stored) =>
        Effect.gen(function* () {
          yield* idle(stored)
          const index = doc.undo.findLastIndex((item) => item.changeset === id && item.path === target)
          const last = doc.undo[index]
          if (!last) return yield* new ConflictError({ message: "nothing to undo", path: target })
          const abs = path.join(where.worktree, target)
          const now = yield* current(abs)
          if (now === undefined || blobID(now) !== last.after)
            return yield* new ConflictError({ message: "the file changed since the reject", path: target })
          const content = last.before === null ? null : yield* readBlob(where, last.before)
          if (content === undefined)
            return yield* new ConflictError({
              message: "the content before the reject is no longer stored",
              path: target,
            })
          yield* put(abs, content, target)
          doc.undo.splice(index, 1)
          const decided = stored.decided[target]
          if (decided) {
            decided.rejected = Math.max(0, decided.rejected - last.hunks)
            decided.log = dropLastRejects(decided.log ?? [], last.hunks)
          }
          const entry = doc.files[target]
          if (entry) entry.settled = blobID(content) === entry.base
        }),
      )
    })

    // ---------------------------------------------------------------- Agent HQ

    const finish = Effect.fnUntraced(function* (
      session: AgentHQ.AgentSessionInfo,
      owner: Review.Owner,
      directory: string,
    ) {
      const turn = turns.get(session.id)
      if (!turn) return
      turns.delete(session.id)
      const patch = yield* store.provide({ directory }, snapshot.patch(turn.tree))
      yield* record(turn.where, owner, session.agentID, turn.tree, patch.files)
    })

    const observeAgent = Effect.fn("ReviewChanges.observeAgent")(
      function* (
        session: AgentHQ.AgentSessionInfo,
        agent: AgentHQ.AgentIdentity,
        envelopes: readonly AgentHQ.AgentEventEnvelope[],
      ) {
        // OpenCode sessions are reviewed through their own patch parts.
        if (session.provider === "opencode") return
        const owner: Review.Owner = { kind: "agenthq-session", id: session.id }
        const directory = agent.workingDirectory ?? agent.projectDirectory
        for (const envelope of envelopes) {
          const event = envelope.event
          if (event.type === "message" && event.role === "user") {
            yield* finish(session, owner, directory)
            const turn = yield* store.provide(
              { directory },
              Effect.gen(function* () {
                const ctx = yield* InstanceState.context
                const tree = yield* snapshot.track()
                if (!tree) return undefined
                return {
                  where: { projectID: ctx.project.id, worktree: ctx.worktree, directory: ctx.directory },
                  tree,
                }
              }),
            )
            if (turn) turns.set(session.id, turn)
          }
          const turn = turns.get(session.id)
          if (event.type === "file.changed" && turn)
            yield* record(turn.where, owner, session.agentID, turn.tree, [event.path])
          if (event.type === "turn.completed" || (event.type === "status" && !ACTIVE.has(event.status)))
            yield* finish(session, owner, directory)
        }
      },
      // Review must never break the Agent HQ event pipeline.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logWarning("review: agent observation failed", { cause }),
      ),
    )

    return Service.of({ list, get, content, hunk, file, all, undo, observeAgent })
  }),
)

const here = Effect.map(
  InstanceState.context,
  (ctx): Where => ({ projectID: ctx.project.id, worktree: ctx.worktree, directory: ctx.directory }),
)

// The snapshot store of a worktree (same path as src/snapshot).
function gitdir(where: Where) {
  return path.join(Global.Path.data, "snapshot", where.projectID, Hash.fast(where.worktree))
}

function key(where: Where) {
  return ["review", where.projectID, Hash.fast(where.worktree)]
}

function changesetID(owner: Review.Owner) {
  return `chg_${owner.id}`
}

function at(directory: string) {
  return { location: { directory: AbsolutePath.make(directory) } }
}

function is<D extends EventV2.Definition>(definition: D, event: EventV2.Payload): event is EventV2.Payload<D> {
  return event.type === definition.type
}

// Events published from an instance carry its project; others are not reviewable.
function locate(location: Location.Ref | undefined): Where | undefined {
  if (!(location instanceof Location.Info)) return undefined
  return { projectID: location.project.id, worktree: location.project.directory, directory: location.directory }
}

function compare(file: string, entry: Entry, before: Uint8Array | null, after: Uint8Array | null): Inspected {
  const status = before === null ? "added" : after === null ? "deleted" : "modified"
  const left = text(before)
  const right = text(after)
  const split = left === undefined || right === undefined ? undefined : { before: lines(left), after: lines(right) }
  const found = split ? blocks(split.before, split.after) : undefined
  const seen = new Map<string, number>()
  return {
    path: file,
    entry,
    status,
    binary: !found,
    before,
    after,
    lines: split && found && status === "modified" ? { ...split, blocks: found } : undefined,
    hunks: found?.length
      ? found.map((block) => hunkOf(file, block, seen))
      : [
          {
            id: Hash.fast(`${file}\0${entry.base}\0${blobID(after)}`).slice(0, 16),
            oldStart: 0,
            oldLines: 0,
            newStart: 0,
            newLines: 0,
            patch: "",
          },
        ],
    additions: sum(found?.map((block) => block.added.length) ?? []),
    deletions: sum(found?.map((block) => block.removed.length) ?? []),
  }
}

function present(
  file: string,
  item: Inspected | undefined,
  decided: Decided | undefined,
  undoable: boolean,
): Review.File {
  const accepted = decided?.accepted ?? 0
  const rejected = decided?.rejected ?? 0
  const hunks = item?.hunks ?? []
  return {
    path: file,
    status: item?.status ?? decided?.status ?? "modified",
    binary: item?.binary ?? false,
    additions: item?.additions ?? 0,
    deletions: item?.deletions ?? 0,
    hunks,
    state: hunks.length
      ? accepted + rejected
        ? "partial"
        : "pending"
      : rejected && !accepted
        ? "rejected"
        : "accepted",
    undoable,
    accepted,
    rejected,
    decided: decided?.log ?? [],
  }
}

// Undo restores the content before a file's last reject, so that reject's hunks leave the log.
function dropLastRejects(log: Review.DecidedHunk[], count: number) {
  const indexes = log.flatMap((item, index) => (item.state === "rejected" ? [index] : [])).slice(-count)
  return log.filter((_, index) => !indexes.includes(index))
}

// UTF-8 text that round-trips byte for byte, or undefined.
function text(bytes: Uint8Array | null) {
  if (bytes === null) return ""
  if (bytes.length > TEXT_LIMIT || bytes.includes(0)) return undefined
  const value = Buffer.from(bytes).toString("utf8")
  return Buffer.from(value, "utf8").equals(bytes) ? value : undefined
}

// Lines keep their terminators, so joining them restores the exact bytes.
function lines(value: string) {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

// Contiguous changed regions, each one hunk.
function blocks(before: string[], after: string[]) {
  const changes = diffArrays(before, after, { timeout: DIFF_TIMEOUT })
  if (!changes) return undefined
  const out: Block[] = []
  const cursor = { old: 0, new: 0, open: false }
  for (const change of changes) {
    if (!change.added && !change.removed) {
      cursor.old += change.value.length
      cursor.new += change.value.length
      cursor.open = false
      continue
    }
    if (!cursor.open) out.push({ oldIndex: cursor.old, newIndex: cursor.new, removed: [], added: [] })
    cursor.open = true
    const block = out[out.length - 1]
    if (change.removed) {
      block.removed.push(...change.value)
      cursor.old += change.value.length
      continue
    }
    block.added.push(...change.value)
    cursor.new += change.value.length
  }
  return out
}

function hunkOf(file: string, block: Block, seen: Map<string, number>): Review.Hunk {
  const change = `${block.removed.join("")}\0${block.added.join("")}`
  const repeat = seen.get(change) ?? 0
  seen.set(change, repeat + 1)
  const oldStart = block.removed.length ? block.oldIndex + 1 : block.oldIndex
  const newStart = block.added.length ? block.newIndex + 1 : block.newIndex
  const body = [...block.removed.map((line) => "-" + line), ...block.added.map((line) => "+" + line)]
    .map((line) => (line.endsWith("\n") ? line : `${line}\n\\ No newline at end of file\n`))
    .join("")
  return {
    id: Hash.fast(`${file}\0${change}\0${repeat}`).slice(0, 16),
    oldStart,
    oldLines: block.removed.length,
    newStart,
    newLines: block.added.length,
    patch: `@@ -${oldStart},${block.removed.length} +${newStart},${block.added.length} @@\n${body}`,
  }
}

function splice(list: string[], index: number, count: number, insert: string[]) {
  return Buffer.from([...list.slice(0, index), ...insert, ...list.slice(index + count)].join(""), "utf8")
}

// The id git gives a blob with these bytes.
function blobID(bytes: Uint8Array | null) {
  if (bytes === null) return null
  return Hash.fast(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
}

function same(a: Uint8Array | null, b: Uint8Array | null) {
  if (a === null || b === null) return a === b
  return Buffer.from(a).equals(b)
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Storage.node, EventV2Bridge.node, AppProcess.node, FSUtil.node, InstanceStore.node, Snapshot.node],
})

export * as ReviewChanges from "./changes"
