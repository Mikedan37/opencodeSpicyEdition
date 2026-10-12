// Agent HQ orchestration: tasks with dependencies, a git worktree per isolated task, agent-to-agent messages
// with loop limits, and a review gate. Integration is never automatic: a task that finishes its work waits in
// `review` until the human approves it, and approving merges only into a project with no uncommitted changes.
//
// Process-global like the session manager. Providers stay behind AgentSessions: nothing here depends on how a
// provider runs or keeps its own work.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Queue, Schema, Scope, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { AgentProvider } from "./provider"
import { AgentRegistry } from "./registry"
import { AgentSessions } from "./session"
import { AgentStore } from "./store"

// Loop limits for agent-to-agent exchanges; a limit stops the exchange with a stated reason.
const MAX_HOPS = 6
const MAX_TASK_MESSAGES = 20
const RATE_LIMIT = 10
const RATE_WINDOW = 60_000
const SUMMARY_LIMIT = 4_000
const WAITING = new Set<AgentHQ.TaskStatus>(["pending", "ready", "blocked"])
const STARTABLE = new Set<AgentHQ.TaskStatus>(["ready", "failed", "cancelled"])
const WORKING = "The agent is still working; review again when it finishes"
const CHANGED = "The task changed since you reviewed it; review again"

export const CreateTaskInput = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  assignee: AgentHQ.AgentID,
  dependsOn: Schema.optional(Schema.Array(AgentHQ.TaskID)),
  isolated: Schema.optional(Schema.Boolean),
})
export type CreateTaskInput = typeof CreateTaskInput.Type

// `null` clears the description.
export const UpdateTaskInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(AgentHQ.AgentID),
  dependsOn: Schema.optional(Schema.Array(AgentHQ.TaskID)),
  isolated: Schema.optional(Schema.Boolean),
})
export type UpdateTaskInput = typeof UpdateTaskInput.Type

// The branch commit the human reviewed (`TaskReview.head`); a task with a worktree merges only that commit.
export const ApproveInput = Schema.Struct({ head: Schema.optional(Schema.String) })
export type ApproveInput = typeof ApproveInput.Type

export const SendInput = Schema.Struct({
  from: Schema.optional(Schema.Union([AgentHQ.AgentID, Schema.Literals(["user", "system"])])),
  to: AgentHQ.AgentID,
  text: Schema.String,
  taskID: Schema.optional(AgentHQ.TaskID),
  evidenceIDs: Schema.optional(Schema.Array(Schema.String)),
  relay: Schema.optional(Schema.Boolean),
})
export type SendInput = typeof SendInput.Type

type NotFound = AgentProvider.NotFoundError
type Invalid = AgentProvider.InvalidInputError
type Conflict = AgentProvider.ConflictError

export interface Interface {
  readonly list: () => Effect.Effect<AgentHQ.Task[]>
  readonly get: (id: AgentHQ.TaskID) => Effect.Effect<AgentHQ.Task, NotFound>
  readonly create: (input: CreateTaskInput) => Effect.Effect<AgentHQ.Task, NotFound | Invalid>
  readonly update: (
    id: AgentHQ.TaskID,
    input: UpdateTaskInput,
  ) => Effect.Effect<AgentHQ.Task, NotFound | Invalid | Conflict>
  readonly remove: (id: AgentHQ.TaskID) => Effect.Effect<void, NotFound | Conflict>
  readonly start: (
    id: AgentHQ.TaskID,
  ) => Effect.Effect<
    AgentHQ.Task,
    NotFound | Conflict | AgentProvider.UnsupportedError | AgentProvider.ProviderError | Invalid
  >
  readonly cancel: (id: AgentHQ.TaskID) => Effect.Effect<AgentHQ.Task, NotFound>
  readonly review: (id: AgentHQ.TaskID) => Effect.Effect<AgentHQ.TaskReview, NotFound>
  readonly approve: (id: AgentHQ.TaskID, head?: string) => Effect.Effect<AgentHQ.Task, NotFound | Conflict>
  readonly messages: (filter: {
    readonly taskID?: AgentHQ.TaskID
    readonly agentID?: AgentHQ.AgentID
  }) => Effect.Effect<AgentHQ.AgentMessage[]>
  readonly send: (input: SendInput) => Effect.Effect<AgentHQ.AgentMessage, NotFound | Invalid>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentHQOrchestrator") {}

const decodeTask = Schema.decodeUnknownOption(AgentHQ.Task)
const decodeMessage = Schema.decodeUnknownOption(AgentHQ.AgentMessage)
const taskKey = (id: string) => ["agenthq", "task", id]
const messageKey = (id: string) => ["agenthq", "message", id]

interface Delivery {
  readonly from: AgentHQ.AgentMessage["from"]
  readonly to: AgentHQ.AgentID
  readonly text: string
  readonly taskID?: AgentHQ.TaskID
  readonly evidenceIDs: readonly string[]
  readonly kind: AgentHQ.AgentMessage["kind"]
  readonly inReplyTo?: AgentHQ.AgentMessageID
  readonly hops: number
  readonly relay: boolean
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const records = yield* AgentStore.Service
    const bridge = yield* EventV2Bridge.Service
    const events = yield* EventV2.Service
    const registry = yield* AgentRegistry.Service
    const sessions = yield* AgentSessions.Service
    const store = yield* InstanceStore.Service
    const worktrees = yield* Worktree.Service
    const proc = yield* AppProcess.Service
    const scope = yield* Scope.Scope
    // ponytail: one lock for all task state; per-task locks if task volume makes it contended.
    const lock = Semaphore.makeUnsafe(1)
    const bySession = new Map<string, AgentHQ.TaskID>()
    // ponytail: pending relays live in memory; an exchange in flight during a restart is not resumed.
    const relays = new Map<string, { readonly message: AgentHQ.AgentMessage; readonly after: number }>()

    const conflict = (message: string) => new AgentProvider.ConflictError({ message })
    const missing = (id: string) => new AgentProvider.NotFoundError({ message: `Task not found: ${id}` })

    // ---------------------------------------------------------------- storage

    const where = (agentID: AgentHQ.AgentID) =>
      registry.get(agentID).pipe(
        Effect.map((agent) => AgentRegistry.location(agent.projectDirectory)),
        Effect.orElseSucceed(() => ({})),
      )

    const readTask = Effect.fnUntraced(function* (id: string) {
      return yield* records.find(taskKey(id), decodeTask)
    })

    const get = Effect.fn("AgentHQOrchestrator.get")(function* (id: AgentHQ.TaskID) {
      const task = yield* readTask(id)
      if (Option.isNone(task)) return yield* missing(id)
      return task.value
    })

    const list = Effect.fn("AgentHQOrchestrator.list")(function* () {
      const ids = yield* records.list(["agenthq", "task"])
      const found = yield* Effect.forEach(ids, readTask, { concurrency: 8 })
      return found.flatMap((item) => Option.toArray(item)).toSorted((a, b) => a.createdAt - b.createdAt)
    })

    const save = Effect.fnUntraced(function* (task: AgentHQ.Task) {
      yield* records.write(taskKey(task.id), task).pipe(Effect.orDie)
      yield* bridge.publish(AgentHQ.Event.TaskUpdated, { task }, yield* where(task.assignee))
      return task
    })

    const messages = Effect.fn("AgentHQOrchestrator.messages")(function* (filter: {
      readonly taskID?: AgentHQ.TaskID
      readonly agentID?: AgentHQ.AgentID
    }) {
      // ponytail: scans every message; index by task and agent when message volume grows.
      const ids = yield* records.list(["agenthq", "message"])
      const found = yield* Effect.forEach(ids, (id) => records.find(messageKey(id), decodeMessage), { concurrency: 8 })
      return found
        .flatMap((item) => Option.toArray(item))
        .filter((item) => !filter.taskID || item.taskID === filter.taskID)
        .filter((item) => !filter.agentID || item.to === filter.agentID || item.from === filter.agentID)
        .toSorted((a, b) => a.at - b.at)
    })

    const saveMessage = Effect.fnUntraced(function* (message: AgentHQ.AgentMessage) {
      yield* records.write(messageKey(message.id), message).pipe(Effect.orDie)
      yield* bridge.publish(AgentHQ.Event.MessageEvent, { message }, yield* where(message.to))
      return message
    })

    // ---------------------------------------------------------------- git

    const git = (cwd: string, args: string[]) =>
      proc.run(ChildProcess.make("git", args, { cwd, stdin: "ignore" })).pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          // `raw` keeps porcelain status columns, which a trim would eat on the first line.
          raw: result.stdout.toString("utf8"),
          out: result.stdout.toString("utf8").trim(),
          err: result.stderr.toString("utf8").trim(),
        })),
        Effect.orElseSucceed(() => ({ code: 1, raw: "", out: "", err: "git could not run" })),
      )

    /** Commit whatever the agent left in its worktree, on its own branch. Not an integration step. */
    const snapshot = Effect.fnUntraced(function* (task: AgentHQ.Task) {
      if (!task.worktree) return
      const changes = yield* git(task.worktree.path, ["status", "--porcelain"])
      if (!changes.out) return
      yield* git(task.worktree.path, ["add", "-A"])
      const agent = yield* registry.get(task.assignee).pipe(Effect.option)
      const name = Option.match(agent, { onNone: () => "Agent HQ", onSome: (item) => `${item.name} (Agent HQ)` })
      const committed = yield* git(task.worktree.path, [
        "-c",
        `user.name=${name}`,
        "-c",
        "user.email=agenthq@opencode.local",
        "commit",
        "--quiet",
        "-m",
        task.title,
      ])
      if (committed.code !== 0)
        return yield* conflict(`could not commit the task's changes: ${committed.err || committed.out}`)
    })

    /** The commit a task's branch points at, or "" when it is gone. */
    const tip = (project: string, branch: string) =>
      git(project, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]).pipe(Effect.map((result) => result.out))

    /** The task's session is mid-turn or waits on a permission, so its work may still change. */
    const working = Effect.fnUntraced(function* (task: AgentHQ.Task) {
      const sessionID = task.result?.sessionID
      if (!sessionID) return false
      const detail = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(detail)) return false
      const info = detail.value.session
      return AgentSessions.ACTIVE.has(info.status) || info.pendingPermissions > 0
    })

    const provision = Effect.fnUntraced(function* (task: AgentHQ.Task, agent: AgentHQ.AgentIdentity) {
      return yield* store.provide(
        { directory: agent.projectDirectory },
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          if (ctx.project.vcs !== "git") return yield* conflict("isolated tasks need a git project")
          const name = branchName(task.title)
          const info = { name, branch: name, directory: path.join(Global.Path.data, "worktree", ctx.project.id, name) }
          // The worktree module checks files out in the background and announces it on the global bus.
          const ready = yield* Deferred.make<void, Conflict>()
          const listener = (event: GlobalEvent) => {
            if (event.directory !== info.directory || !event.payload || typeof event.payload !== "object") return
            if (event.payload.type === Worktree.Event.Ready.type) Deferred.doneUnsafe(ready, Exit.void)
            if (event.payload.type === Worktree.Event.Failed.type)
              Deferred.doneUnsafe(
                ready,
                Exit.fail(conflict(`worktree setup failed: ${String(event.payload.properties?.message)}`)),
              )
          }
          GlobalBus.on("event", listener)
          yield* Effect.gen(function* () {
            yield* worktrees
              .createFromInfo(info)
              .pipe(Effect.mapError((error) => conflict(`could not create a worktree: ${error.message}`)))
            yield* Deferred.await(ready).pipe(
              Effect.timeoutOrElse({
                duration: "60 seconds",
                orElse: () => Effect.fail(conflict("the worktree was not ready within 60 seconds")),
              }),
            )
          }).pipe(Effect.ensuring(Effect.sync(() => GlobalBus.off("event", listener))))
          return { path: info.directory, branch: name }
        }),
      )
    })

    // ---------------------------------------------------------------- task graph

    /** Re-derive waiting tasks until nothing changes (a failure propagates down dependency chains). */
    const settle = Effect.fnUntraced(function* () {
      for (const _ of Array.from({ length: 50 })) {
        const all = yield* list()
        const byID = new Map<string, AgentHQ.Task>(all.map((task) => [task.id, task]))
        const changed = all.flatMap((task) => {
          if (!WAITING.has(task.status)) return []
          const next = derive(task, byID)
          if (next.status === task.status && next.reason === task.reason) return []
          return [{ ...task, ...next, updatedAt: Date.now() }]
        })
        if (changed.length === 0) return
        yield* Effect.forEach(changed, save, { discard: true })
      }
    })

    const create = Effect.fn("AgentHQOrchestrator.create")(function* (input: CreateTaskInput) {
      const title = input.title.trim()
      if (!title) return yield* new AgentProvider.InvalidInputError({ message: "title must not be empty" })
      yield* registry.get(input.assignee)
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const byID = new Map<string, AgentHQ.Task>((yield* list()).map((task) => [task.id, task]))
          const dependsOn = [...new Set(input.dependsOn ?? [])]
          const unknown = dependsOn.find((id) => !byID.has(id))
          if (unknown) return yield* new AgentProvider.InvalidInputError({ message: `Unknown dependency: ${unknown}` })
          const now = Date.now()
          const draft: AgentHQ.Task = {
            id: AgentHQ.TaskID.create(),
            title,
            ...(input.description ? { description: input.description } : {}),
            assignee: input.assignee,
            dependsOn,
            status: "pending",
            isolated: input.isolated ?? false,
            createdAt: now,
            updatedAt: now,
          }
          return yield* save({ ...draft, ...derive(draft, byID) })
        }),
      )
    })

    const update = Effect.fn("AgentHQOrchestrator.update")(function* (id: AgentHQ.TaskID, input: UpdateTaskInput) {
      if (input.assignee) yield* registry.get(input.assignee)
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const byID = new Map<string, AgentHQ.Task>((yield* list()).map((task) => [task.id, task]))
          const task = byID.get(id)
          if (!task) return yield* missing(id)
          if (!WAITING.has(task.status) && task.status !== "failed" && task.status !== "cancelled")
            return yield* conflict(`A ${task.status} task cannot be edited`)
          const title = input.title?.trim()
          if (input.title !== undefined && !title)
            return yield* new AgentProvider.InvalidInputError({ message: "title must not be empty" })
          const dependsOn = input.dependsOn ? [...new Set(input.dependsOn)] : task.dependsOn
          const unknown = dependsOn.find((item) => !byID.has(item))
          if (unknown) return yield* new AgentProvider.InvalidInputError({ message: `Unknown dependency: ${unknown}` })
          const loop = cycle(id, dependsOn, byID)
          if (loop)
            return yield* new AgentProvider.InvalidInputError({
              message: `Dependency cycle: ${loop.map((item) => byID.get(item)?.title ?? item).join(" → ")}`,
            })
          const next: AgentHQ.Task = {
            ...task,
            ...(title ? { title } : {}),
            description: input.description === null ? undefined : input.description || task.description,
            ...(input.assignee ? { assignee: input.assignee } : {}),
            ...(input.isolated !== undefined ? { isolated: input.isolated } : {}),
            dependsOn,
            updatedAt: Date.now(),
          }
          const saved = yield* save(WAITING.has(next.status) ? { ...next, ...derive(next, byID) } : next)
          yield* settle()
          return saved
        }),
      )
    })

    const remove = Effect.fn("AgentHQOrchestrator.remove")(function* (id: AgentHQ.TaskID) {
      const task = yield* lock.withPermit(
        Effect.gen(function* () {
          const all = yield* list()
          const task = all.find((item) => item.id === id)
          if (!task) return yield* missing(id)
          const dependent = all.find((item) => item.dependsOn.includes(id))
          if (dependent) return yield* conflict(`Task "${dependent.title}" depends on it`)
          yield* records.remove(taskKey(id)).pipe(Effect.orDie)
          yield* bridge.publish(AgentHQ.Event.TaskRemoved, { id }, yield* where(task.assignee))
          return task
        }),
      )
      const session = task.result?.sessionID
      if (task.status === "running" && session) yield* sessions.cancel(session).pipe(Effect.ignore)
      if (session) bySession.delete(session)
      if (task.worktree) {
        const worktree = task.worktree.path
        yield* registry.get(task.assignee).pipe(
          Effect.flatMap((agent) =>
            store.provide({ directory: agent.projectDirectory }, worktrees.remove({ directory: worktree })),
          ),
          Effect.ignore,
        )
      }
    })

    // ---------------------------------------------------------------- running

    const start = Effect.fn("AgentHQOrchestrator.start")(function* (id: AgentHQ.TaskID) {
      yield* ready
      const claimed = yield* lock.withPermit(
        Effect.gen(function* () {
          const byID = new Map<string, AgentHQ.Task>((yield* list()).map((task) => [task.id, task]))
          const task = byID.get(id)
          if (!task) return yield* missing(id)
          if (!STARTABLE.has(task.status) && !WAITING.has(task.status)) return yield* conflict(`Task is ${task.status}`)
          const gate = derive(task, byID)
          if (gate.status !== "ready") return yield* conflict(gate.reason ?? "Dependencies are not done")
          return { task: yield* save({ ...task, status: "running", reason: undefined, updatedAt: Date.now() }), byID }
        }),
      )
      const task = claimed.task
      const failed = (error: { readonly message: string }) =>
        lock.withPermit(
          readTask(id).pipe(
            Effect.flatMap((current) =>
              Option.isSome(current) && current.value.status === "running"
                ? save({ ...current.value, status: "failed", reason: error.message, updatedAt: Date.now() })
                : Effect.void,
            ),
            Effect.andThen(settle()),
          ),
        )
      // Worktree and session setup run outside the lock; a failure leaves the task failed with the reason.
      return yield* Effect.gen(function* () {
        const agent = yield* registry.get(task.assignee)
        const worktree = task.isolated ? (task.worktree ?? (yield* provision(task, agent))) : undefined
        const session = yield* sessions.start(task.assignee, {
          title: task.title,
          taskID: task.id,
          ...(worktree ? { workingDirectory: worktree.path } : {}),
        })
        bySession.set(session.id, task.id)
        const running = yield* lock.withPermit(
          save({
            ...task,
            ...(worktree ? { worktree } : {}),
            result: { evidenceIDs: task.result?.evidenceIDs ?? [], sessionID: session.id },
            updatedAt: Date.now(),
          }),
        )
        yield* sessions.send(session.id, brief(running, claimed.byID))
        return running
      }).pipe(Effect.tapError(failed))
    })

    const cancel = Effect.fn("AgentHQOrchestrator.cancel")(function* (id: AgentHQ.TaskID) {
      const outcome = yield* lock.withPermit(
        Effect.gen(function* () {
          const task = yield* get(id)
          if (task.status === "done" || task.status === "cancelled") return { task, running: false }
          const cancelled = yield* save({
            ...task,
            status: "cancelled",
            reason: "Cancelled by the user",
            updatedAt: Date.now(),
          })
          yield* settle()
          return { task: cancelled, running: task.status === "running" }
        }),
      )
      const session = outcome.task.result?.sessionID
      if (outcome.running && session) yield* sessions.cancel(session).pipe(Effect.ignore)
      return outcome.task
    })

    // ---------------------------------------------------------------- review gate

    const review = Effect.fn("AgentHQOrchestrator.review")(function* (id: AgentHQ.TaskID) {
      const task = yield* get(id)
      const waiting = task.status !== "review" ? `Task is ${task.status}` : (yield* working(task)) ? WORKING : undefined
      if (!task.worktree)
        return {
          taskID: id,
          commits: [],
          files: [],
          clean: true,
          mergeable: !waiting,
          ...(waiting ? { reason: waiting } : {}),
        }
      const project = Option.getOrUndefined(yield* registry.get(task.assignee).pipe(Effect.option))?.projectDirectory
      if (!project)
        return {
          taskID: id,
          branch: task.worktree.branch,
          commits: [],
          files: [],
          clean: false,
          mergeable: false,
          reason: "The assignee no longer exists",
        }
      // Approving merges whatever the agent left in its worktree too, so the review commits it first (never mid-turn)
      // and describes exactly the commit it reports as `head`.
      const saved = waiting ? undefined : yield* lock.withPermit(snapshot(task)).pipe(Effect.result)
      const unsaved = saved?._tag === "Failure" ? saved.failure.message : undefined
      const branch = task.worktree.branch
      const head = yield* tip(project, branch)
      const base = (yield* git(project, ["rev-parse", "--abbrev-ref", "HEAD"])).out
      const commits = (yield* git(project, ["log", "--format=%H%x09%s", `HEAD..${head}`])).out
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ sha: line.split("\t")[0] ?? "", subject: line.split("\t").slice(1).join("\t") }))
      const files = (yield* git(project, ["diff", "--numstat", `HEAD...${head}`])).out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [added, deleted, ...name] = line.split("\t")
          return { path: name.join("\t"), additions: Number(added) || 0, deletions: Number(deleted) || 0 }
        })
      const dirty = (yield* git(project, ["status", "--porcelain", "--untracked-files=no"])).raw
      const merge = yield* git(project, ["merge-tree", "--write-tree", "--name-only", "HEAD", head])
      const conflicts = merge.code === 1 ? conflicted(merge.out) : []
      const reason =
        waiting ??
        unsaved ??
        (dirty.trim() ? `The project has uncommitted changes: ${names(dirty).join(", ")}` : undefined) ??
        (conflicts.length > 0 ? `Merging conflicts in ${conflicts.join(", ")}` : undefined) ??
        (merge.code > 1 ? `The merge check failed: ${merge.err || merge.out}` : undefined)
      return {
        taskID: id,
        branch,
        ...(head ? { head } : {}),
        base,
        commits,
        files,
        clean: !dirty.trim(),
        mergeable: !waiting && !unsaved && !dirty.trim() && merge.code === 0,
        ...(reason ? { reason } : {}),
      }
    })

    // Merges exactly the commit the human reviewed: never while the agent works, never after the branch moved on.
    const approve = Effect.fn("AgentHQOrchestrator.approve")(function* (id: AgentHQ.TaskID, head?: string) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const task = yield* get(id)
          if (task.status !== "review")
            return yield* conflict(`Task is ${task.status}; only a task in review can be approved`)
          if (yield* working(task)) return yield* conflict(WORKING)
          if (task.worktree) {
            const agent = yield* registry
              .get(task.assignee)
              .pipe(Effect.mapError(() => conflict("The assignee no longer exists")))
            const project = agent.projectDirectory
            yield* snapshot(task)
            if (!head || (yield* tip(project, task.worktree.branch)) !== head) return yield* conflict(CHANGED)
            const dirty = (yield* git(project, ["status", "--porcelain", "--untracked-files=no"])).raw
            if (dirty.trim())
              return yield* conflict(
                `The project has uncommitted changes (${names(dirty).join(", ")}); commit or stash them before approving`,
              )
            // The reviewed commit itself, not the branch name: nothing that lands can be newer than the review.
            const merged = yield* git(project, [
              "merge",
              "--no-ff",
              "--no-edit",
              "-m",
              `Merge task: ${task.title}`,
              head,
            ])
            if (merged.code !== 0) {
              yield* git(project, ["merge", "--abort"])
              return yield* conflict(`The merge failed and was aborted: ${merged.out || merged.err}`)
            }
            // The branch is merged; its worktree and branch are no longer needed.
            const worktree = task.worktree.path
            yield* store.provide({ directory: project }, worktrees.remove({ directory: worktree })).pipe(Effect.ignore)
          }
          const done = yield* save({
            ...task,
            status: "done",
            worktree: undefined,
            reason: undefined,
            updatedAt: Date.now(),
          })
          yield* settle()
          return done
        }),
      )
    })

    // ---------------------------------------------------------------- messages

    const send = Effect.fn("AgentHQOrchestrator.send")(function* (input: SendInput) {
      const from = input.from ?? "user"
      if (!input.text.trim()) return yield* new AgentProvider.InvalidInputError({ message: "text must not be empty" })
      return yield* deliver({
        from,
        to: input.to,
        text: input.text,
        ...(input.taskID ? { taskID: input.taskID } : {}),
        evidenceIDs: input.evidenceIDs ?? [],
        kind: from === "user" ? "user" : from === "system" ? "system" : "agent",
        hops: 0,
        relay: input.relay ?? false,
      })
    })

    const deliver = Effect.fnUntraced(function* (spec: Delivery) {
      const recipient = yield* registry.get(spec.to)
      const sender = spec.from === "user" || spec.from === "system" ? undefined : yield* registry.get(spec.from)
      const task = spec.taskID ? yield* get(spec.taskID) : undefined
      const reason = limit(spec, yield* messages({}), Date.now())
      const message: AgentHQ.AgentMessage = {
        id: AgentHQ.AgentMessageID.create(),
        from: spec.from,
        to: spec.to,
        ...(spec.taskID ? { taskID: spec.taskID } : {}),
        text: spec.text,
        evidenceIDs: [...spec.evidenceIDs],
        at: Date.now(),
        delivery: reason ? "failed" : "queued",
        kind: spec.kind,
        ...(spec.inReplyTo ? { inReplyTo: spec.inReplyTo } : {}),
        hops: spec.hops,
        relay: spec.relay && !reason,
        ...(reason ? { reason } : {}),
      }
      yield* saveMessage(message)
      if (reason) return message
      const outcome = yield* Effect.gen(function* () {
        const target = yield* destination(recipient.id, task)
        const after = (yield* sessions.get(target)).history.at(-1)?.seq ?? -1
        yield* sessions.send(target, format(message, sender, task))
        return { target, after }
      }).pipe(Effect.result)
      if (outcome._tag === "Failure")
        return yield* saveMessage({ ...message, delivery: "failed", reason: outcome.failure.message })
      const delivered = yield* saveMessage({ ...message, delivery: "delivered", sessionID: outcome.success.target })
      if (delivered.relay && sender)
        relays.set(outcome.success.target, { message: delivered, after: outcome.success.after })
      return delivered
    })

    /** The recipient's session for this message: the task's session, else its newest, else a new one. */
    const destination = Effect.fnUntraced(function* (to: AgentHQ.AgentID, task: AgentHQ.Task | undefined) {
      if (task?.assignee === to && task.result?.sessionID) return task.result.sessionID
      const existing = (yield* sessions.list(to)).at(-1)
      if (existing) return existing.id
      return (yield* sessions.start(to, { title: "Messages", ...(task ? { taskID: task.id } : {}) })).id
    })

    // ---------------------------------------------------------------- reacting to sessions

    const finished = Effect.fnUntraced(function* (taskID: AgentHQ.TaskID, sessionID: AgentHQ.AgentSessionID) {
      const summary = lastAnswer((yield* sessions.get(sessionID)).history, -1)
      yield* lock.withPermit(
        Effect.gen(function* () {
          const current = yield* readTask(taskID)
          if (Option.isNone(current) || current.value.result?.sessionID !== sessionID) return
          const task = current.value
          if (task.status !== "running" && task.status !== "review" && task.status !== "failed") return
          const committed = yield* snapshot(task).pipe(Effect.result)
          yield* save({
            ...task,
            status: "review",
            reason: committed._tag === "Failure" ? committed.failure.message : undefined,
            result: {
              evidenceIDs: task.result?.evidenceIDs ?? [],
              sessionID,
              ...(summary ? { summary: summary.slice(0, SUMMARY_LIMIT) } : {}),
            },
            updatedAt: Date.now(),
          })
        }),
      )
    })

    const stopped = Effect.fnUntraced(function* (
      taskID: AgentHQ.TaskID,
      sessionID: AgentHQ.AgentSessionID,
      status: AgentHQ.AgentSessionStatus,
    ) {
      const error = Option.getOrUndefined(yield* sessions.get(sessionID).pipe(Effect.option))?.session.error
      yield* lock.withPermit(
        Effect.gen(function* () {
          const current = yield* readTask(taskID)
          if (Option.isNone(current) || current.value.result?.sessionID !== sessionID) return
          if (current.value.status !== "running") return
          yield* save({
            ...current.value,
            status: status === "cancelled" ? "cancelled" : "failed",
            reason:
              status === "cancelled"
                ? "The task's session was cancelled"
                : status === "interrupted"
                  ? "The task's session was interrupted; send it a message or start the task again"
                  : (error ?? `The task's session is ${status}`),
            updatedAt: Date.now(),
          })
          yield* settle()
        }),
      )
    })

    const reply = Effect.fnUntraced(function* (
      relay: { readonly message: AgentHQ.AgentMessage; readonly after: number },
      sessionID: AgentHQ.AgentSessionID,
    ) {
      const original = relay.message
      if (original.from === "user" || original.from === "system") return
      const text = lastAnswer((yield* sessions.get(sessionID)).history, relay.after)
      if (!text) return
      yield* deliver({
        from: original.to,
        to: original.from,
        text,
        ...(original.taskID ? { taskID: original.taskID } : {}),
        evidenceIDs: [],
        kind: "agent",
        inReplyTo: original.id,
        hops: original.hops + 1,
        relay: true,
      })
    })

    const react = Effect.fnUntraced(function* (envelope: AgentHQ.AgentEventEnvelope) {
      const event = envelope.event
      const taskID = bySession.get(envelope.sessionID)
      if (event.type === "turn.completed") {
        if (taskID) yield* finished(taskID, envelope.sessionID)
        const relay = relays.get(envelope.sessionID)
        if (!relay) return
        relays.delete(envelope.sessionID)
        yield* reply(relay, envelope.sessionID)
        return
      }
      if (event.type !== "status") return
      if (!["failed", "disconnected", "cancelled", "interrupted"].includes(event.status)) return
      relays.delete(envelope.sessionID)
      if (taskID) yield* stopped(taskID, envelope.sessionID, event.status)
    })

    // Session events reach the orchestrator through the bus, one at a time, off the publisher's fiber.
    const inbox = yield* Queue.unbounded<AgentHQ.AgentEventEnvelope>()
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (is(AgentHQ.Event.SessionEvent, event)) Queue.offerUnsafe(inbox, event.data.envelope)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* Queue.take(inbox).pipe(
      Effect.flatMap(react),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logError("agenthq orchestrator reaction failed", { cause }),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    )

    // After a restart: map task sessions again and fail tasks whose session did not survive.
    const ready = yield* Effect.cached(
      Effect.gen(function* () {
        const all = yield* list()
        yield* Effect.forEach(
          all,
          (task) =>
            Effect.gen(function* () {
              const session = task.result?.sessionID
              if (!session || (task.status !== "running" && task.status !== "review" && task.status !== "failed"))
                return
              bySession.set(session, task.id)
              if (task.status !== "running") return
              const status = Option.getOrUndefined(yield* sessions.get(session).pipe(Effect.option))?.session.status
              if (status && ["failed", "disconnected", "cancelled", "interrupted"].includes(status))
                yield* stopped(task.id, session, status)
            }),
          { discard: true },
        )
      }),
    )

    const withReady =
      <A extends unknown[], B, E>(fn: (...args: A) => Effect.Effect<B, E>) =>
      (...args: A) =>
        ready.pipe(Effect.andThen(fn(...args)))

    return Service.of({
      list: withReady(list),
      get: withReady(get),
      create: withReady(create),
      update: withReady(update),
      remove: withReady(remove),
      start,
      cancel: withReady(cancel),
      review: withReady(review),
      approve: withReady(approve),
      messages: withReady(messages),
      send: withReady(send),
    })
  }),
)

/** Where a waiting task stands given its dependencies. */
function derive(
  task: AgentHQ.Task,
  byID: ReadonlyMap<string, AgentHQ.Task>,
): { status: AgentHQ.TaskStatus; reason: string | undefined } {
  const deps = task.dependsOn.map((id) => ({ id, task: byID.get(id) }))
  const lost = deps.find((item) => !item.task)
  if (lost) return { status: "blocked", reason: `Dependency ${lost.id} no longer exists` }
  const broken = deps.find((item) => ["failed", "cancelled", "blocked"].includes(item.task!.status))
  if (broken) return { status: "blocked", reason: `Dependency "${broken.task!.title}" is ${broken.task!.status}` }
  const open = deps.filter((item) => item.task!.status !== "done")
  if (open.length === 0) return { status: "ready", reason: undefined }
  return { status: "pending", reason: `Waiting on ${open.map((item) => `"${item.task!.title}"`).join(", ")}` }
}

/** The cycle that `id` depending on `dependsOn` would close, as a path from `id` back to `id`. */
function cycle(id: string, dependsOn: readonly string[], byID: ReadonlyMap<string, AgentHQ.Task>) {
  const visit = (current: string, trail: string[]): string[] | undefined => {
    if (current === id) return [...trail, current]
    if (trail.includes(current)) return undefined
    const next = byID.get(current)?.dependsOn ?? []
    return next.reduce<string[] | undefined>((found, item) => found ?? visit(item, [...trail, current]), undefined)
  }
  return dependsOn.reduce<string[] | undefined>((found, item) => found ?? visit(item, [id]), undefined)
}

function limit(spec: Delivery, all: readonly AgentHQ.AgentMessage[], now: number) {
  if (spec.hops > MAX_HOPS) return `Stopped: the exchange reached the ${MAX_HOPS}-reply limit`
  if (spec.taskID && all.filter((item) => item.taskID === spec.taskID).length >= MAX_TASK_MESSAGES)
    return `Stopped: task ${spec.taskID} reached its ${MAX_TASK_MESSAGES}-message limit`
  if (
    spec.from !== "user" &&
    spec.from !== "system" &&
    all.filter((item) => item.from === spec.from && now - item.at < RATE_WINDOW).length >= RATE_LIMIT
  )
    return `Stopped: ${spec.from} sent ${RATE_LIMIT} messages within a minute`
  const answered = spec.inReplyTo ? all.find((item) => item.id === spec.inReplyTo) : undefined
  if (answered && answered.text.trim() === spec.text.trim()) return "Stopped: the reply repeats the message it answers"
  return undefined
}

function brief(task: AgentHQ.Task, byID: ReadonlyMap<string, AgentHQ.Task>) {
  const done = task.dependsOn.flatMap((id) => {
    const dep = byID.get(id)
    return dep ? [`- ${dep.title}${dep.result?.summary ? `: ${dep.result.summary.slice(0, 500)}` : ""}`] : []
  })
  return [
    `Task: ${task.title}`,
    ...(task.description ? ["", task.description] : []),
    ...(done.length > 0 ? ["", "Completed dependencies:", ...done] : []),
    ...(task.worktree
      ? [
          "",
          `You are working in an isolated git worktree on branch ${task.worktree.branch}. Leave your changes in it; a human reviews and merges them.`,
        ]
      : []),
  ].join("\n")
}

function format(
  message: AgentHQ.AgentMessage,
  sender: AgentHQ.AgentIdentity | undefined,
  task: AgentHQ.Task | undefined,
) {
  const from =
    message.from === "user"
      ? "the user"
      : message.from === "system"
        ? "Agent HQ"
        : `${sender?.name ?? "an agent"} (${message.from})`
  return [
    `Message from ${from}${task ? ` about task "${task.title}" (${task.id})` : ""}:`,
    "",
    message.text,
    ...(message.evidenceIDs.length > 0 ? ["", `Evidence: ${message.evidenceIDs.join(", ")}`] : []),
    ...(message.relay ? ["", "Your reply will be passed back to them."] : []),
  ].join("\n")
}

/** The text of the newest assistant message recorded after `after`. */
function lastAnswer(history: readonly AgentHQ.AgentEventEnvelope[], after: number) {
  return history
    .filter((item) => item.seq > after)
    .flatMap((item) => (item.event.type === "message" && item.event.role === "assistant" ? [item.event.text] : []))
    .at(-1)
}

function branchName(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 3)
    .join("-")
  return `task-${slug || "work"}-${crypto.randomUUID().slice(0, 4)}`
}

function names(porcelain: string) {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
}

// `git merge-tree --name-only` lists conflicted paths after the tree id, up to the first blank line.
function conflicted(output: string) {
  const lines = output.split("\n").slice(1)
  const end = lines.indexOf("")
  return lines.slice(0, end === -1 ? undefined : end).filter(Boolean)
}

function is<D extends EventV2.Definition>(definition: D, event: EventV2.Payload): event is EventV2.Payload<D> {
  return event.type === definition.type
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    AgentRegistry.node,
    AgentSessions.node,
    AgentStore.node,
    EventV2Bridge.node,
    EventV2.node,
    InstanceStore.node,
    Worktree.node,
    AppProcess.node,
  ],
})

export * as AgentOrchestrator from "./orchestrator"
