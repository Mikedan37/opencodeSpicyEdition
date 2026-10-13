import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Review } from "@opencode-ai/schema/review"
import { Effect, Exit, Layer, Scope } from "effect"
import path from "path"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { ReviewChanges } from "../../src/review/changes"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

// REV-01..05 drive real OpenCode sessions (fake model) through the real server routes; REV-06 drives
// the Agent HQ hook directly because no external provider adapter exists yet.

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const support = Layer.mergeAll(
  testStateLayer,
  LayerNode.compile(FSUtil.node),
  LayerNode.compile(CrossSpawnSpawner.node),
  TestLLMServer.layer,
)
const it = testEffect(Layer.mergeAll(support, httpApiLayer))
const bare = testEffect(support)

const TEN = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
const EDITED = TEN.replace("two", "TWO").replace("nine", "NINE")

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})
const decide = (action: Review.Action, extra: Record<string, unknown> = {}) => json("POST", { action, ...extra })

const read = (dir: string, name: string) => Effect.promise(() => Bun.file(path.join(dir, name)).text())
const exists = (dir: string, name: string) => Effect.promise(() => Bun.file(path.join(dir, name)).exists())

// A git project whose model is the fake server, plus a client for its routes.
const project = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.reset
    // The main chat asks before edits and bash; these tests are about reviewing them, so the project allows them.
    const dir = yield* tmpdirScoped({
      git: true,
      config: { ...testProviderConfig(llm.url), permission: { edit: "allow", bash: "allow" } },
    })
    yield* Effect.promise(() =>
      Promise.all(Object.entries(files).map((item) => Bun.write(path.join(dir, item[0]), item[1]))),
    )
    const call = <T = unknown>(route: string, init?: RequestInit) =>
      Effect.gen(function* () {
        const response = yield* requestInDirectory(route, dir, init)
        const text = yield* response.text
        return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
      })
    const changesets = call<Review.ChangeSet[]>("/review/changesets").pipe(Effect.map((result) => result.body))
    const waitFor = (ready: (list: Review.ChangeSet[]) => boolean, message: string) =>
      pollWithTimeout(changesets.pipe(Effect.map((list) => (ready(list) ? list : undefined))), message, "15 seconds")
    const session = call<{ id: string }>("/session", json("POST", {})).pipe(Effect.map((result) => result.body.id))
    const prompt = (sessionID: string, route = "message") =>
      call(
        `/session/${sessionID}/${route}`,
        json("POST", {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "change the files" }],
        }),
      )
    return { llm, dir, call, changesets, waitFor, session, prompt }
  })

/** Every review.* event the app would receive, in order. */
const capture = Effect.gen(function* () {
  const seen: GlobalEvent[] = []
  const on = (event: GlobalEvent) => {
    if (String(event.payload?.type).startsWith("review.")) seen.push(event)
  }
  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
  return seen
})

const fileOf = (changeset: Review.ChangeSet | undefined, name: string) =>
  changeset?.files.find((item) => item.path === name)

describe("review", () => {
  it.live("REV-01 an OpenCode session's edits become one changeset; hunks are accepted and rejected one by one", () =>
    Effect.gen(function* () {
      const seen = yield* capture
      const { llm, dir, call, waitFor, session, prompt } = yield* project({ "a.txt": TEN })
      const id = yield* session
      yield* llm.tool("write", { filePath: "a.txt", content: EDITED })
      yield* llm.tool("write", { filePath: "b.txt", content: "fresh\n" })
      yield* llm.text("done")
      expect((yield* prompt(id)).status).toBe(200)

      const [changeset] = yield* waitFor((list) => list[0]?.files.length === 2, "changeset never listed both files")
      expect(changeset).toMatchObject({
        id: `chg_${id}`,
        owner: { kind: "opencode-session", id },
        counts: { files: 2, pending: 3, accepted: 0, rejected: 0, additions: 3, deletions: 2 },
      })
      const a = fileOf(changeset, "a.txt")!
      expect(a).toMatchObject({ status: "modified", state: "pending", binary: false, undoable: false })
      expect(a.hunks.map((item) => [item.oldStart, item.oldLines, item.newStart, item.newLines, item.patch])).toEqual([
        [2, 1, 2, 1, "@@ -2,1 +2,1 @@\n-two\n+TWO\n"],
        [9, 1, 9, 1, "@@ -9,1 +9,1 @@\n-nine\n+NINE\n"],
      ])
      expect(fileOf(changeset, "b.txt")).toMatchObject({
        status: "added",
        hunks: [{ patch: "@@ -0,0 +1,1 @@\n+fresh\n" }],
      })

      // Accept the first hunk and reject the second: the file keeps exactly the accepted change.
      const accepted = yield* call<Review.ChangeSet>(
        `/review/changesets/${changeset.id}/hunks/${a.hunks[0].id}`,
        decide("accept"),
      )
      expect(accepted.status).toBe(200)
      expect(fileOf(accepted.body, "a.txt")).toMatchObject({ state: "partial", hunks: [{ id: a.hunks[1].id }] })
      expect(yield* read(dir, "a.txt")).toBe(EDITED)
      const rejected = yield* call<Review.ChangeSet>(
        `/review/changesets/${changeset.id}/hunks/${a.hunks[1].id}`,
        decide("reject"),
      )
      expect(rejected.status).toBe(200)
      expect(yield* read(dir, "a.txt")).toBe(TEN.replace("two", "TWO"))
      expect(fileOf(rejected.body, "a.txt")).toMatchObject({
        state: "accepted",
        hunks: [],
        undoable: true,
        accepted: 1,
        rejected: 1,
      })
      // Decided hunks keep their patch and state, in decision order.
      expect(fileOf(rejected.body, "a.txt")?.decided.map((item) => [item.id, item.state, item.patch])).toEqual([
        [a.hunks[0].id, "accepted", "@@ -2,1 +2,1 @@\n-two\n+TWO\n"],
        [a.hunks[1].id, "rejected", "@@ -9,1 +9,1 @@\n-nine\n+NINE\n"],
      ])
      expect(rejected.body.counts).toMatchObject({ files: 1, pending: 1, accepted: 1, rejected: 1 })

      // Every update reached the app with the project directory; the last one is the final state.
      const updates = seen.filter((event) => event.payload.type === Review.Event.ChangeSetUpdated.type)
      expect(updates.length).toBeGreaterThanOrEqual(4)
      expect(updates.every((event) => event.directory === dir)).toBe(true)
      expect(updates.at(-1)?.payload.properties.changeset).toEqual(rejected.body)
    }),
  )

  it.live("REV-02 added and deleted files: reject restores, undo brings the change back, accept all settles", () =>
    Effect.gen(function* () {
      const seen = yield* capture
      const { llm, dir, call, changesets, waitFor, session, prompt } = yield* project({
        "gone.txt": "doomed\n",
        "keep.txt": "keep\n",
      })
      const id = yield* session
      yield* llm.tool("write", { filePath: "new.txt", content: "created\n" })
      yield* llm.tool("bash", { command: "rm gone.txt", description: "Remove a file" })
      yield* llm.tool("write", { filePath: "keep.txt", content: "kept\n" })
      yield* llm.text("done")
      yield* prompt(id)
      const [changeset] = yield* waitFor((list) => list[0]?.files.length === 3, "changeset never listed three files")
      expect(changeset.files.map((item) => [item.path, item.status, item.hunks.map((h) => h.patch)])).toEqual([
        ["gone.txt", "deleted", ["@@ -1,1 +0,0 @@\n-doomed\n"]],
        ["keep.txt", "modified", ["@@ -1,1 +1,1 @@\n-keep\n+kept\n"]],
        ["new.txt", "added", ["@@ -0,0 +1,1 @@\n+created\n"]],
      ])
      const route = `/review/changesets/${changeset.id}`

      // Rejecting an added file deletes it; rejecting a deleted file restores it.
      expect((yield* call(`${route}/files`, decide("reject", { path: "new.txt" }))).status).toBe(200)
      expect(yield* exists(dir, "new.txt")).toBe(false)
      const restored = yield* call<Review.ChangeSet>(`${route}/files`, decide("reject", { path: "gone.txt" }))
      expect(yield* read(dir, "gone.txt")).toBe("doomed\n")
      expect(restored.body.files.map((item) => [item.path, item.state, item.undoable])).toEqual([
        ["gone.txt", "rejected", true],
        ["keep.txt", "pending", false],
        ["new.txt", "rejected", true],
      ])

      // Undo brings the last rejected change back; there is nothing left to undo after that.
      const undone = yield* call<Review.ChangeSet>(`${route}/undo`, json("POST", { path: "new.txt" }))
      expect(undone.status).toBe(200)
      expect(yield* read(dir, "new.txt")).toBe("created\n")
      expect(fileOf(restored.body, "new.txt")?.decided.map((item) => item.state)).toEqual(["rejected"])
      expect(fileOf(undone.body, "new.txt")).toMatchObject({
        state: "pending",
        undoable: false,
        hunks: [{}],
        rejected: 0,
        decided: [],
      })
      expect(yield* call(`${route}/undo`, json("POST", { path: "new.txt" }))).toEqual({
        status: 409,
        body: { _tag: "ConflictError", message: "nothing to undo", resource: "new.txt" },
      })

      // Accept all settles every pending file without touching the working tree.
      const settled = yield* call<Review.ChangeSet>(`${route}/all`, decide("accept"))
      expect(settled.body.counts).toMatchObject({ files: 0, pending: 0, accepted: 2, rejected: 1 })
      expect(settled.body.files.map((item) => [item.path, item.state])).toEqual([
        ["gone.txt", "rejected"],
        ["keep.txt", "accepted"],
        ["new.txt", "accepted"],
      ])
      expect([yield* read(dir, "keep.txt"), yield* read(dir, "new.txt")]).toEqual(["kept\n", "created\n"])
      expect((yield* call<Review.ChangeSet>(`${route}/all`, decide("reject"))).body).toEqual(settled.body)

      // Deleting the session removes its changeset.
      expect((yield* call(`/session/${id}`, { method: "DELETE" })).status).toBe(200)
      const removed = yield* pollWithTimeout(
        Effect.sync(() => seen.find((event) => event.payload.type === Review.Event.ChangeSetRemoved.type)),
        "changeset was not removed",
      )
      expect(removed).toMatchObject({ directory: dir, payload: { properties: { id: changeset.id } } })
      expect(yield* changesets).toEqual([])
      expect((yield* call(route)).status).toBe(404)
    }),
  )

  it.live("REV-03 a hunk that no longer matches the file is refused with 409 and the file is untouched", () =>
    Effect.gen(function* () {
      const { llm, dir, call, waitFor, session, prompt } = yield* project({ "a.txt": TEN })
      const id = yield* session
      yield* llm.tool("write", { filePath: "a.txt", content: TEN.replace("two", "TWO") })
      yield* llm.text("done")
      yield* prompt(id)
      const [changeset] = yield* waitFor((list) => list.length === 1, "changeset never appeared")
      const hunk = changeset.files[0].hunks[0]
      const route = `/review/changesets/${changeset.id}`

      // The human edits the same line after listing: the hunk they saw no longer exists.
      yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), TEN.replace("two", "Two")))
      expect(yield* call(`${route}/hunks/${hunk.id}`, decide("reject"))).toEqual({
        status: 409,
        body: {
          _tag: "ConflictError",
          message: `hunk ${hunk.id} no longer matches the working tree; reload the changeset`,
        },
      })
      expect(yield* read(dir, "a.txt")).toBe(TEN.replace("two", "Two"))

      expect(yield* call(`${route}/files`, decide("reject", { path: "nope.txt" }))).toEqual({
        status: 404,
        body: { name: "NotFoundError", data: { message: `File not in changeset ${changeset.id}: nope.txt` } },
      })
      expect(yield* call("/review/changesets/chg_missing")).toEqual({
        status: 404,
        body: { name: "NotFoundError", data: { message: "Changeset not found: chg_missing" } },
      })
      expect((yield* call(`${route}/all`, json("POST", { action: "maybe" }))).status).toBe(400)
      expect((yield* call("/review/changesets/not-a-changeset")).status).toBe(400)
    }),
  )

  it.live("REV-04 rejecting while the agent is still editing is refused with 409", () =>
    Effect.gen(function* () {
      const { llm, dir, call, waitFor, session, prompt } = yield* project({ "a.txt": TEN })
      const id = yield* session
      yield* llm.tool("write", { filePath: "a.txt", content: EDITED })
      yield* llm.text("done")
      yield* prompt(id)
      const [changeset] = yield* waitFor((list) => list.length === 1, "changeset never appeared")
      const route = `/review/changesets/${changeset.id}`

      // The next turn hangs inside the model call: the session is busy.
      yield* llm.hang
      expect((yield* prompt(id, "prompt_async")).status).toBe(204)
      yield* llm.wait(3)
      const editing = { status: 409, body: { _tag: "ConflictError", message: "agent is still editing" } }
      expect(yield* call(`${route}/files`, decide("reject", { path: "a.txt" }))).toEqual(editing)
      expect(yield* call(`${route}/all`, decide("reject"))).toEqual(editing)
      expect(yield* call(`${route}/hunks/${changeset.files[0].hunks[0].id}`, decide("reject"))).toEqual(editing)
      expect(yield* read(dir, "a.txt")).toBe(EDITED)

      // Once the turn is over the same reject goes through.
      expect((yield* call(`/session/${id}/abort`, { method: "POST" })).status).toBe(200)
      yield* pollWithTimeout(
        call(`${route}/files`, decide("reject", { path: "a.txt" })).pipe(
          Effect.map((result) => (result.status === 200 ? true : undefined)),
        ),
        "reject never went through after the turn ended",
      )
      expect(yield* read(dir, "a.txt")).toBe(TEN)
    }),
  )

  it.live("REV-07 a forked session's copied patches are history: no new changeset, no new baseline", () =>
    Effect.gen(function* () {
      const { llm, call, changesets, waitFor, session, prompt } = yield* project({ "a.txt": TEN })
      const id = yield* session
      yield* llm.tool("write", { filePath: "a.txt", content: TEN.replace("two", "TWO") })
      yield* llm.text("done")
      yield* prompt(id)
      const [first] = yield* waitFor((list) => list.length === 1, "changeset never appeared")
      // Settled files restart from the baseline of the next patch, so a replayed old patch would show
      // the accepted change again.
      expect((yield* call(`/review/changesets/${first.id}/all`, decide("accept"))).status).toBe(200)
      expect((yield* call(`/session/${id}/fork`, json("POST", {}))).status).toBe(200)

      // A later turn of the original session is recorded after the fork's copies: one ordered stream.
      yield* llm.tool("write", { filePath: "b.txt", content: "later\n" })
      yield* llm.text("done")
      yield* prompt(id)
      const [after] = yield* waitFor((list) => list[0]?.files.length === 2, "the later edit never appeared")
      expect((yield* changesets).map((item) => item.id)).toEqual([first.id])
      expect(fileOf(after, "a.txt")).toMatchObject({ state: "accepted", hunks: [] })
      expect(fileOf(after, "b.txt")).toMatchObject({ state: "pending", status: "added" })
    }),
  )

  it.live("REV-08 the content route returns both sides byte for byte with the hunks of the same read", () =>
    Effect.gen(function* () {
      const { llm, call, waitFor, session, prompt } = yield* project({ "c.txt": "\nalpha\nbeta\n" })
      const id = yield* session
      yield* llm.tool("write", { filePath: "c.txt", content: "\nalpha\nBETA\n" })
      yield* llm.text("done")
      yield* prompt(id)
      const [changeset] = yield* waitFor((list) => list.length === 1, "changeset never appeared")
      const route = `/review/changesets/${changeset.id}/content`
      // /file/content trims; this keeps the leading blank line and the final newline, so positions match the hunks.
      expect((yield* call(`${route}?path=c.txt`)).body).toEqual({
        path: "c.txt",
        binary: false,
        before: "\nalpha\nbeta\n",
        after: "\nalpha\nBETA\n",
        hunks: [changeset.files[0].hunks[0]],
      })
      expect(changeset.files[0].hunks[0]).toMatchObject({ newStart: 3, patch: "@@ -3,1 +3,1 @@\n-beta\n+BETA\n" })
      expect((yield* call(`${route}?path=nope.txt`)).status).toBe(404)
      // Once decided there is nothing left to diff.
      yield* call(`/review/changesets/${changeset.id}/files`, decide("accept", { path: "c.txt" }))
      expect((yield* call(`${route}?path=c.txt`)).body).toEqual({ path: "c.txt", binary: false, hunks: [] })
    }),
  )

  bare.live("REV-05 changesets and their baselines survive a server restart", () =>
    Effect.gen(function* () {
      const boot = Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithMemoMap(httpApiLayer, Layer.makeMemoMapUnsafe(), scope)
        return {
          scope,
          run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(context)),
        }
      })
      const { llm, dir, call, changesets, waitFor, session, prompt } = yield* project({ "a.txt": TEN })

      const first = yield* boot
      const id = yield* first.run(session)
      yield* llm.tool("write", { filePath: "a.txt", content: EDITED })
      yield* llm.text("done")
      yield* first.run(prompt(id))
      const before = yield* first.run(waitFor((list) => list.length === 1, "changeset never appeared"))
      yield* Scope.close(first.scope, Exit.void)

      const second = yield* boot
      const after = yield* second.run(changesets)
      expect(after).toEqual(before)
      const hunk = after[0].files[0].hunks[0]
      const result = yield* second.run(
        call<Review.ChangeSet>(`/review/changesets/${after[0].id}/hunks/${hunk.id}`, decide("reject")),
      )
      expect(result.status).toBe(200)
      expect(yield* read(dir, "a.txt")).toBe(TEN.replace("nine", "NINE"))
      yield* Scope.close(second.scope, Exit.void)
    }),
  )
})

// The Agent HQ hook, against the review service itself.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const services = testEffect(
  AppNodeBuilder.build(LayerNode.group([ReviewChanges.node, InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

describe("review: Agent HQ hook", () => {
  services.live(
    "REV-06 an external provider's turn is snapshotted; reported and unreported edits become reviewable",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), TEN))
        const review = yield* ReviewChanges.Service
        const store = yield* InstanceStore.Service
        const inProject = <A, E, R>(effect: Effect.Effect<A, E, R>) => store.provide({ directory: dir }, effect)
        const agent: AgentHQ.AgentIdentity = {
          id: AgentHQ.AgentID.create(),
          name: "Owl",
          avatar: { kind: "preset", value: "owl" },
          provider: "claude-code",
          projectDirectory: dir,
          createdAt: 0,
          updatedAt: 0,
        }
        const session: AgentHQ.AgentSessionInfo = {
          id: AgentHQ.AgentSessionID.create(),
          agentID: agent.id,
          provider: "claude-code",
          status: "working",
          pendingPermissions: 0,
          createdAt: 0,
          updatedAt: 0,
        }
        const observe = (event: AgentHQ.AgentEvent, target = session) =>
          review.observeAgent(target, agent, [{ sessionID: target.id, seq: 0, at: Date.now(), event }])

        // OpenCode sessions are reviewed through their own patch parts, not this hook.
        yield* observe(
          { type: "message", messageID: "m0", role: "user", text: "go" },
          { ...session, provider: "opencode" },
        )
        yield* observe({ type: "file.changed", path: "a.txt" }, { ...session, provider: "opencode" })
        expect(yield* inProject(review.list())).toEqual([])

        yield* observe({ type: "message", messageID: "m1", role: "user", text: "go" })
        // The external agent edits two files but reports only one.
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(dir, "a.txt"), TEN.replace("two", "TWO")),
            Bun.write(path.join(dir, "b.txt"), "from a shell\n"),
          ]),
        )
        yield* observe({ type: "file.changed", path: path.join(dir, "a.txt") })
        const [live] = yield* inProject(review.list())
        expect(live).toMatchObject({
          id: `chg_${session.id}`,
          owner: { kind: "agenthq-session", id: session.id },
          agentID: agent.id,
          files: [{ path: "a.txt", hunks: [{ patch: "@@ -2,1 +2,1 @@\n-two\n+TWO\n" }] }],
        })
        expect(yield* inProject(review.file(live.id, "a.txt", "reject")).pipe(Effect.flip)).toMatchObject({
          _tag: "Review.ConflictError",
          message: "agent is still editing",
        })

        // The turn end diffs the turn-start snapshot, which also finds the unreported file.
        yield* observe({ type: "turn.completed", stopReason: "end_turn" })
        const [done] = yield* inProject(review.list())
        expect(done.files.map((item) => [item.path, item.status])).toEqual([
          ["a.txt", "modified"],
          ["b.txt", "added"],
        ])
        yield* inProject(review.all(done.id, "reject"))
        expect(yield* read(dir, "a.txt")).toBe(TEN)
        expect(yield* exists(dir, "b.txt")).toBe(false)
      }),
  )
})
