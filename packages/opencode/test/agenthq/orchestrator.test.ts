import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentOrchestrator } from "../../src/agenthq/orchestrator"
import { AgentRegistry } from "../../src/agenthq/registry"
import { AgentSessions } from "../../src/agenthq/session"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Storage } from "../../src/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const app = AppNodeBuilder.build(
  LayerNode.group([
    AgentRegistry.node,
    AgentSessions.node,
    AgentOrchestrator.node,
    SessionProjector.node,
    InstanceStore.node,
    Storage.node,
    Database.node,
    EventV2.node,
    AppProcess.node,
    CrossSpawnSpawner.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ],
)

const it = testEffect(Layer.mergeAll(app, TestLLMServer.layer))

/** A git project whose model is the fake server; `shared.txt` is committed. */
const project = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  yield* llm.reset
  const dir = yield* tmpdirScoped({
    git: true,
    config: { ...testProviderConfig(llm.url), model: "test/test-model", small_model: "test/test-model" },
  })
  yield* Effect.promise(async () => {
    await fs.writeFile(path.join(dir, "shared.txt"), "base\n")
    await $`git add shared.txt opencode.json && git commit -q -m base`.cwd(dir).quiet()
  })
  return { llm, dir }
})

const agent = (dir: string, name: string) =>
  AgentRegistry.Service.use((registry) =>
    registry.create({
      name,
      avatar: { kind: "initials", value: name.slice(0, 1) },
      provider: "opencode",
      projectDirectory: dir,
    }),
  )

const waitTask = (id: AgentHQ.TaskID, status: AgentHQ.TaskStatus) =>
  pollWithTimeout(
    AgentOrchestrator.Service.use((orchestrator) => orchestrator.get(id)).pipe(
      Effect.map((task) => (task.status === status ? task : undefined)),
    ),
    `task never became ${status}`,
    "30 seconds",
  )

/** Plays the human: allows the next permission request of a session. */
const allowNext = (sessionID: AgentHQ.AgentSessionID) =>
  Effect.gen(function* () {
    const sessions = yield* AgentSessions.Service
    const request = yield* pollWithTimeout(
      sessions
        .get(sessionID)
        .pipe(
          Effect.map((detail) =>
            detail.history.flatMap((item) => (item.event.type === "permission.requested" ? [item.event] : [])).at(-1),
          ),
        ),
      "no permission was requested",
      "30 seconds",
    )
    yield* sessions.respond(sessionID, request.requestID, "once")
  })

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const git = (dir: string, command: string) =>
  Effect.promise(() => $`sh -c ${command}`.cwd(dir).quiet().text()).pipe(Effect.map((text) => text.trim()))

describe("agenthq orchestration", () => {
  it.live("tasks start only when their dependencies are done", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const orchestrator = yield* AgentOrchestrator.Service
      const sessions = yield* AgentSessions.Service
      const writer = yield* agent(dir, "Writer")
      const first = yield* orchestrator.create({ title: "Write notes", assignee: writer.id })
      const second = yield* orchestrator.create({ title: "Review notes", assignee: writer.id, dependsOn: [first.id] })
      expect(first.status).toBe("ready")
      expect(second).toMatchObject({ status: "pending", reason: 'Waiting on "Write notes"' })

      const early = yield* orchestrator.start(second.id).pipe(Effect.flip)
      expect(early).toMatchObject({ _tag: "AgentHQ.ConflictError", message: 'Waiting on "Write notes"' })

      yield* llm.text("notes written")
      yield* orchestrator.start(first.id)
      const reviewed = yield* waitTask(first.id, "review")
      expect(reviewed.result?.summary).toBe("notes written")
      // Review is not done: the dependent still waits.
      expect((yield* orchestrator.get(second.id)).status).toBe("pending")

      yield* orchestrator.approve(first.id)
      yield* waitTask(second.id, "ready")
      yield* llm.text("notes reviewed")
      const running = yield* orchestrator.start(second.id)
      yield* waitTask(second.id, "review")
      const brief = (yield* sessions.get(running.result!.sessionID!)).history.flatMap((item) =>
        item.event.type === "message" && item.event.role === "user" ? [item.event.text] : [],
      )[0]
      expect(brief).toContain("Task: Review notes")
      expect(brief).toContain("- Write notes: notes written")
    }),
  )

  it.live("dependency cycles and unknown dependencies are rejected", () =>
    Effect.gen(function* () {
      const { dir } = yield* project
      const orchestrator = yield* AgentOrchestrator.Service
      const owner = yield* agent(dir, "Owner")
      const a = yield* orchestrator.create({ title: "A", assignee: owner.id })
      const b = yield* orchestrator.create({ title: "B", assignee: owner.id, dependsOn: [a.id] })
      const c = yield* orchestrator.create({ title: "C", assignee: owner.id, dependsOn: [b.id] })

      const loop = yield* orchestrator.update(a.id, { dependsOn: [c.id] }).pipe(Effect.flip)
      expect(loop).toMatchObject({ _tag: "AgentHQ.InvalidInputError", message: "Dependency cycle: A → C → B → A" })
      const self = yield* orchestrator.update(a.id, { dependsOn: [a.id] }).pipe(Effect.flip)
      expect(self).toMatchObject({ _tag: "AgentHQ.InvalidInputError", message: "Dependency cycle: A → A" })
      const unknown = yield* orchestrator
        .create({ title: "D", assignee: owner.id, dependsOn: [AgentHQ.TaskID.create()] })
        .pipe(Effect.flip)
      expect(unknown._tag).toBe("AgentHQ.InvalidInputError")
      expect((yield* orchestrator.get(a.id)).dependsOn).toEqual([])
    }),
  )

  it.live("isolated tasks edit their own worktrees, and nothing merges until the human approves", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const orchestrator = yield* AgentOrchestrator.Service
      const editor = yield* agent(dir, "Editor")
      const one = yield* orchestrator.create({ title: "Edit one", assignee: editor.id, isolated: true })
      const two = yield* orchestrator.create({ title: "Edit two", assignee: editor.id, isolated: true })

      for (const [task, content] of [
        [one, "one\n"],
        [two, "two\n"],
      ] as const) {
        yield* llm.push(reply().tool("write", { filePath: "shared.txt", content }))
        yield* llm.push(reply().text(`wrote ${content.trim()}`).stop())
        const running = yield* orchestrator.start(task.id)
        expect(running.worktree?.branch).toMatch(/^task-[a-z0-9-]+$/)
        yield* allowNext(running.result!.sessionID!)
        yield* waitTask(task.id, "review")
      }

      const first = yield* orchestrator.get(one.id)
      const second = yield* orchestrator.get(two.id)
      expect(first.worktree!.path).not.toBe(second.worktree!.path)
      expect(yield* read(path.join(first.worktree!.path, "shared.txt"))).toBe("one\n")
      expect(yield* read(path.join(second.worktree!.path, "shared.txt"))).toBe("two\n")
      expect(yield* read(path.join(dir, "shared.txt"))).toBe("base\n")

      const preview = yield* orchestrator.review(one.id)
      expect(preview).toMatchObject({
        branch: first.worktree!.branch,
        clean: true,
        mergeable: true,
        files: [{ path: "shared.txt", additions: 1, deletions: 1 }],
      })
      expect(preview.commits.map((commit) => commit.subject)).toEqual(["Edit one"])
      expect(preview.head).toBe(yield* git(dir, `git rev-parse ${first.worktree!.branch}`))
      expect(yield* read(path.join(dir, "shared.txt"))).toBe("base\n")

      // A project with uncommitted changes is refused, untouched.
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "shared.txt"), "local edit\n"))
      const dirty = yield* orchestrator.approve(one.id, preview.head).pipe(Effect.flip)
      expect(dirty._tag).toBe("AgentHQ.ConflictError")
      expect(dirty.message).toContain("uncommitted changes (shared.txt)")
      expect((yield* orchestrator.get(one.id)).status).toBe("review")
      yield* git(dir, "git checkout -- shared.txt")

      const approved = yield* orchestrator.approve(one.id, preview.head)
      expect(approved.status).toBe("done")
      // The record no longer points at the removed worktree.
      expect(approved.worktree).toBeUndefined()
      expect((yield* orchestrator.get(one.id)).worktree).toBeUndefined()
      expect(yield* read(path.join(dir, "shared.txt"))).toBe("one\n")
      expect(yield* git(dir, "git log -1 --format=%s")).toBe("Merge task: Edit one")
      expect(yield* git(dir, "git rev-parse HEAD^2")).toBe(preview.head!)
      expect(
        yield* Effect.promise(() =>
          fs.stat(first.worktree!.path).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)

      // The second branch now conflicts: the dry run says so and approving refuses and aborts.
      const conflicting = yield* orchestrator.review(two.id)
      expect(conflicting).toMatchObject({ mergeable: false, reason: "Merging conflicts in shared.txt" })
      const conflict = yield* orchestrator.approve(two.id, conflicting.head).pipe(Effect.flip)
      expect(conflict._tag).toBe("AgentHQ.ConflictError")
      expect(conflict.message).toContain("The merge failed and was aborted")
      expect(yield* git(dir, "git status --porcelain --untracked-files=no")).toBe("")
      expect(yield* read(path.join(dir, "shared.txt"))).toBe("one\n")
      expect((yield* orchestrator.get(two.id)).status).toBe("review")
    }),
  )

  it.live("approve merges exactly the reviewed commit: never mid-turn, never after the branch moved on", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const orchestrator = yield* AgentOrchestrator.Service
      const sessions = yield* AgentSessions.Service
      const editor = yield* agent(dir, "Editor")
      const task = yield* orchestrator.create({ title: "Edit", assignee: editor.id, isolated: true })
      yield* llm.push(reply().tool("write", { filePath: "shared.txt", content: "one\n" }))
      yield* llm.push(reply().text("wrote one").stop())
      const sessionID = (yield* orchestrator.start(task.id)).result!.sessionID!
      yield* allowNext(sessionID)
      yield* waitTask(task.id, "review")
      const reviewed = yield* orchestrator.review(task.id)
      expect(reviewed).toMatchObject({ mergeable: true, head: expect.stringMatching(/^[0-9a-f]{40}$/) })

      // A message to the task in review starts another turn in its session. While it runs, nothing is approved.
      yield* llm.push(reply().tool("write", { filePath: "extra.txt", content: "extra\n" }))
      yield* llm.push(reply().text("wrote extra").stop())
      yield* orchestrator.send({ to: editor.id, taskID: task.id, text: "Also add extra.txt" })
      yield* pollWithTimeout(
        sessions
          .get(sessionID)
          .pipe(Effect.map((detail) => (detail.session.pendingPermissions > 0 ? true : undefined))),
        "the second turn never asked for permission",
        "30 seconds",
      )
      const busy = yield* orchestrator.approve(task.id, reviewed.head).pipe(Effect.flip)
      expect(busy).toMatchObject({
        _tag: "AgentHQ.ConflictError",
        message: "The agent is still working; review again when it finishes",
      })
      expect(yield* orchestrator.review(task.id)).toMatchObject({
        mergeable: false,
        reason: "The agent is still working; review again when it finishes",
      })

      // The turn adds a commit after the human's review: the reviewed commit no longer approves, nothing merges.
      yield* allowNext(sessionID)
      yield* pollWithTimeout(
        sessions
          .get(sessionID)
          .pipe(
            Effect.map((detail) =>
              detail.history.filter((item) => item.event.type === "turn.completed").length > 1 ? true : undefined,
            ),
          ),
        "the second turn never completed",
        "30 seconds",
      )
      const stale = yield* orchestrator.approve(task.id, reviewed.head).pipe(Effect.flip)
      expect(stale).toMatchObject({
        _tag: "AgentHQ.ConflictError",
        message: "The task changed since you reviewed it; review again",
      })
      expect(yield* git(dir, "git log -1 --format=%s")).toBe("base")
      expect(yield* read(path.join(dir, "shared.txt"))).toBe("base\n")
      expect((yield* orchestrator.get(task.id)).status).toBe("review")

      // Reviewed again, approving merges exactly that commit and the record forgets the removed worktree.
      const again = yield* orchestrator.review(task.id)
      expect(again.head).not.toBe(reviewed.head)
      expect(again.files.map((file) => file.path).toSorted()).toEqual(["extra.txt", "shared.txt"])
      const approved = yield* orchestrator.approve(task.id, again.head)
      expect(approved).toMatchObject({ status: "done" })
      expect(approved.worktree).toBeUndefined()
      expect(yield* git(dir, "git rev-parse HEAD^2")).toBe(again.head!)
      expect(yield* read(path.join(dir, "extra.txt"))).toBe("extra\n")
    }),
  )

  it.live("an agent-to-agent exchange stops at the hop limit with a reason", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const orchestrator = yield* AgentOrchestrator.Service
      const alpha = yield* agent(dir, "Alpha")
      const beta = yield* agent(dir, "Beta")
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, index) => `reply ${index + 1}`),
        (text) => llm.push(reply().text(text).stop()),
        { discard: true },
      )

      const opened = yield* orchestrator.send({ from: alpha.id, to: beta.id, text: "let's talk", relay: true })
      expect(opened).toMatchObject({ delivery: "delivered", hops: 0, relay: true })
      const stop = yield* pollWithTimeout(
        orchestrator
          .messages({})
          .pipe(Effect.map((list) => list.find((item) => item.delivery === "failed" && item.from !== "user"))),
        "the exchange never stopped",
        "60 seconds",
      )
      expect(stop).toMatchObject({ hops: 7, reason: "Stopped: the exchange reached the 6-reply limit", relay: false })
      const calls = (yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title")).length
      expect(calls).toBe(7)

      // Deterministic: nothing more happens after the stop.
      yield* Effect.sleep("500 millis")
      const thread = (yield* orchestrator.messages({ agentID: alpha.id })).filter((item) => item.from !== "user")
      expect(thread.map((item) => item.hops)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(thread.slice(0, 7).every((item) => item.delivery === "delivered")).toBe(true)
      expect(thread.map((item) => item.from)).toEqual([
        alpha.id,
        beta.id,
        alpha.id,
        beta.id,
        alpha.id,
        beta.id,
        alpha.id,
        beta.id,
      ])
      expect((yield* llm.inputs).filter((input) => !JSON.stringify(input).includes("Generate a title"))).toHaveLength(7)
    }),
  )

  it.live("cancelling a running task stops its session and blocks its dependents", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const orchestrator = yield* AgentOrchestrator.Service
      const sessions = yield* AgentSessions.Service
      const worker = yield* agent(dir, "Worker")
      const task = yield* orchestrator.create({ title: "Long job", assignee: worker.id })
      const after = yield* orchestrator.create({ title: "Follow-up", assignee: worker.id, dependsOn: [task.id] })

      yield* llm.push(reply().hang())
      const running = yield* orchestrator.start(task.id)
      yield* pollWithTimeout(
        llm.inputs.pipe(
          Effect.map((inputs) =>
            inputs.some((input) => !JSON.stringify(input).includes("Generate a title")) ? true : undefined,
          ),
        ),
        "the task never reached the model",
      )
      const cancelled = yield* orchestrator.cancel(task.id)
      expect(cancelled).toMatchObject({ status: "cancelled", reason: "Cancelled by the user" })
      const session = yield* pollWithTimeout(
        sessions
          .get(running.result!.sessionID!)
          .pipe(Effect.map((detail) => (detail.session.status === "cancelled" ? detail.session : undefined))),
        "the task's session was not cancelled",
      )
      expect(session.taskID).toBe(task.id)
      expect(yield* orchestrator.get(after.id)).toMatchObject({
        status: "blocked",
        reason: 'Dependency "Long job" is cancelled',
      })
      yield* Effect.sleep("300 millis")
      expect((yield* orchestrator.get(task.id)).status).toBe("cancelled")
    }),
  )
})
