import { batch, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import {
  errorText,
  WorkbenchRequestError,
  type MessageDraft,
  type TaskDraft,
  type WorkbenchClient,
} from "@/workbench/client"

type Task = AgentHQ.Task
type Message = AgentHQ.AgentMessage

// Statuses the server accepts an edit in (409 otherwise), and the ones Start works from once dependencies are done.
export const EDITABLE: ReadonlySet<AgentHQ.TaskStatus> = new Set(["pending", "ready", "blocked", "failed", "cancelled"])
export const STARTABLE: ReadonlySet<AgentHQ.TaskStatus> = new Set(["ready", "failed", "cancelled"])
export const CANCELLABLE: ReadonlySet<AgentHQ.TaskStatus> = new Set([
  "pending",
  "ready",
  "running",
  "review",
  "blocked",
])

export type ReviewState = { status: "loading" | "ready" | "failed"; review?: AgentHQ.TaskReview; error?: string }
export type MessageFilter = { taskID: string } | { agentID: string }

// Tasks in dependency order, each after the tasks it waits on; a task's dependents follow it right away, so a chain
// reads top to bottom, indented by its longest dependency path. Tasks the server lists out of order (or a cycle it
// refused to create) still appear, unindented.
// ponytail: quadratic in the number of tasks; fine for a team's list, index dependents if lists grow to thousands.
export function taskTree(tasks: readonly Task[]) {
  const known = new Map(tasks.map((task) => [task.id as string, task]))
  const depths = new Map<string, number>()
  const depth = (task: Task, seen: Set<string> = new Set()): number => {
    const cached = depths.get(task.id)
    if (cached !== undefined) return cached
    seen.add(task.id)
    const value = task.dependsOn.reduce((max, id) => {
      const dependency = known.get(id)
      return dependency && !seen.has(id) ? Math.max(max, depth(dependency, seen) + 1) : max
    }, 0)
    depths.set(task.id, value)
    return value
  }
  const out: { task: Task; depth: number }[] = []
  const placed = new Set<string>()
  const visit = (task: Task) => {
    if (placed.has(task.id) || task.dependsOn.some((id) => known.has(id) && !placed.has(id))) return
    placed.add(task.id)
    out.push({ task, depth: depth(task) })
    tasks.filter((next) => next.dependsOn.includes(task.id)).forEach(visit)
  }
  tasks.forEach(visit)
  tasks.filter((task) => !placed.has(task.id)).forEach((task) => out.push({ task, depth: 0 }))
  return out
}

export const threadKey = (filter: MessageFilter) =>
  "taskID" in filter ? `task:${filter.taskID}` : `agent:${filter.agentID}`

export function inThread(message: Message, filter: MessageFilter) {
  if ("taskID" in filter) return message.taskID === filter.taskID
  return message.from === filter.agentID || message.to === filter.agentID
}

type Client = Pick<
  WorkbenchClient,
  | "tasks"
  | "createTask"
  | "updateTask"
  | "removeTask"
  | "startTask"
  | "cancelTask"
  | "taskReview"
  | "approveTask"
  | "messages"
  | "sendMessage"
>

// Orchestrator tasks and agent messages from agenthq.task.* / agenthq.message events plus the routes. Nothing here
// approves on its own: approve() runs only from the user's click.
export function createTasksState(client: Client) {
  const [state, setState] = createStore({
    tasks: [] as Task[],
    list: "idle" as "idle" | "loading" | "ready" | "unavailable" | "failed",
    error: undefined as string | undefined,
    messages: {} as Record<string, Message>,
    threads: {} as Record<string, "loading" | "ready" | "failed">,
    reviews: {} as Record<string, ReviewState>,
    // The action in flight per task, so its buttons wait.
    busy: {} as Record<string, string | undefined>,
  })
  const at = (id: string) => state.tasks.findIndex((task) => task.id === id)
  const find = (id: string | undefined) => (id ? state.tasks.find((task) => task.id === id) : undefined)

  function upsert(task: Task) {
    const index = at(task.id)
    if (index === -1) return setState("tasks", (list) => [...list, task].toSorted((a, b) => a.createdAt - b.createdAt))
    const previous = state.tasks[index]!
    // A route reply can be older than an event that already arrived.
    if (previous.updatedAt > task.updatedAt) return
    const status = previous.status
    batch(() => {
      setState("tasks", index, reconcile(task))
      // A dry run describes one review; any status change makes it stale.
      if (status !== task.status)
        setState(
          "reviews",
          produce((reviews) => void delete reviews[task.id]),
        )
    })
  }

  function remove(id: string) {
    batch(() => {
      setState("tasks", (list) => list.filter((task) => task.id !== id))
      setState(
        "reviews",
        produce((reviews) => void delete reviews[id]),
      )
    })
  }

  function load() {
    if (state.list === "loading") return Promise.resolve()
    setState({ list: "loading", error: undefined })
    return client.tasks().then(
      (list) =>
        batch(() => {
          // Events that arrived during the request are newer; the list fills in the rest.
          for (const task of list) upsert(task)
          setState("list", "ready")
        }),
      (error: unknown) =>
        setState({
          list: error instanceof WorkbenchRequestError && error.kind === "unavailable" ? "unavailable" : "failed",
          error: errorText(error),
        }),
    )
  }

  // Runs a task action once at a time; the reply updates the task (its event usually got there first).
  function act(id: string, name: string, request: () => Promise<Task>) {
    if (state.busy[id]) return Promise.resolve(undefined)
    setState("busy", id, name)
    return request()
      .then((task) => {
        upsert(task)
        return task
      })
      .finally(() => setState("busy", id, undefined))
  }

  const review = (id: string) =>
    untrack(() => {
      if (state.reviews[id]?.status === "loading") return Promise.resolve()
      setState("reviews", id, { status: "loading", review: undefined, error: undefined })
      return client.taskReview(id).then(
        (result) => setState("reviews", id, { status: "ready", review: result }),
        (error: unknown) => setState("reviews", id, { status: "failed", error: errorText(error) }),
      )
    })

  function upsertMessage(message: Message) {
    setState("messages", message.id, reconcile(message))
  }

  // One request per thread unless it failed; events keep it current afterwards.
  const loadThread = (filter: MessageFilter) =>
    untrack(() => {
      const key = threadKey(filter)
      if (state.threads[key] === "loading" || state.threads[key] === "ready") return Promise.resolve()
      setState("threads", key, "loading")
      return client.messages(filter).then(
        (list) =>
          batch(() => {
            for (const message of list) upsertMessage(message)
            setState("threads", key, "ready")
          }),
        () => setState("threads", key, "failed"),
      )
    })

  const thread = (filter: MessageFilter) =>
    Object.values(state.messages)
      .filter((message) => inThread(message, filter))
      .toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id))

  return {
    state,
    find,
    tree: () => taskTree(state.tasks),
    upsert,
    remove,
    load,
    create: (draft: TaskDraft) =>
      client.createTask(draft).then((task) => {
        upsert(task)
        return task
      }),
    update: (id: string, draft: Partial<TaskDraft>) => act(id, "update", () => client.updateTask(id, draft)),
    delete: (id: string) => client.removeTask(id).then(() => remove(id)),
    start: (id: string) => act(id, "start", () => client.startTask(id)),
    cancel: (id: string) => act(id, "cancel", () => client.cancelTask(id)),
    review,
    // Merges the reviewed commit of the task's branch into the project. Only ever called from the user's Approve
    // click, with the `head` of the review the user is looking at.
    approve: (id: string, head?: string) => act(id, "approve", () => client.approveTask(id, head)),
    upsertMessage,
    loadThread,
    thread,
    send: (draft: MessageDraft) => client.sendMessage(draft).then((message) => (upsertMessage(message), message)),
  }
}

export type TasksState = ReturnType<typeof createTasksState>
