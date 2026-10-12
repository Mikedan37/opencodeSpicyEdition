import { describe, expect, test } from "bun:test"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { WorkbenchRequestError } from "@/workbench/client"
import { createTasksState, taskTree } from "./tasks"

const task = (id: string, patch: Partial<AgentHQ.Task> = {}): AgentHQ.Task =>
  ({
    id,
    title: id,
    assignee: "agt_ada",
    dependsOn: [],
    status: "ready",
    isolated: false,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    updatedAt: 1,
    ...patch,
  }) as AgentHQ.Task

const message = (id: string, patch: Partial<AgentHQ.AgentMessage> = {}): AgentHQ.AgentMessage =>
  ({
    id,
    from: "user",
    to: "agt_ada",
    text: id,
    evidenceIDs: [],
    at: Number(id.replace(/\D/g, "")) || 1,
    delivery: "delivered",
    kind: "user",
    hops: 0,
    relay: false,
    ...patch,
  }) as AgentHQ.AgentMessage

const fail = () => Promise.reject(new WorkbenchRequestError("failed", "unexpected"))
function setup(overrides: Record<string, (...args: any[]) => Promise<unknown>> = {}) {
  const calls: { name: string; args: unknown[] }[] = []
  const names = [
    "tasks",
    "createTask",
    "updateTask",
    "removeTask",
    "startTask",
    "cancelTask",
    "taskReview",
    "approveTask",
    "messages",
    "sendMessage",
  ]
  const client = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) => {
        calls.push({ name, args })
        return (overrides[name] ?? fail)(...args)
      },
    ]),
  ) as unknown as Parameters<typeof createTasksState>[0]
  return { tasks: createTasksState(client), calls }
}

describe("task tree", () => {
  test("a chain reads top to bottom, indented by its longest dependency path", () => {
    const tree = taskTree([
      task("tsk_1"),
      task("tsk_2"),
      task("tsk_3", { dependsOn: ["tsk_1"] as AgentHQ.TaskID[] }),
      task("tsk_4", { dependsOn: ["tsk_3", "tsk_2"] as AgentHQ.TaskID[] }),
      task("tsk_5", { dependsOn: ["tsk_9"] as AgentHQ.TaskID[] }),
    ])
    expect(tree.map((item) => `${item.task.id}:${item.depth}`)).toEqual([
      "tsk_1:0",
      "tsk_3:1",
      "tsk_2:0",
      "tsk_4:2",
      "tsk_5:0",
    ])
  })

  test("a cycle the server would refuse still lists every task", () => {
    const tree = taskTree([
      task("tsk_1", { dependsOn: ["tsk_2"] as AgentHQ.TaskID[] }),
      task("tsk_2", { dependsOn: ["tsk_1"] as AgentHQ.TaskID[] }),
    ])
    expect(tree.map((item) => String(item.task.id)).toSorted()).toEqual(["tsk_1", "tsk_2"])
  })
})

describe("tasks", () => {
  test("events and the list merge by id; an older reply never replaces a newer event", async () => {
    const { tasks } = setup({
      tasks: () => Promise.resolve([task("tsk_1", { status: "pending", updatedAt: 1 }), task("tsk_2")]),
    })
    tasks.upsert(task("tsk_1", { status: "running", updatedAt: 5 }))
    await tasks.load()
    expect(tasks.state.tasks.map((item) => [String(item.id), item.status])).toEqual([
      ["tsk_1", "running"],
      ["tsk_2", "ready"],
    ])
    expect(tasks.state.list).toBe("ready")
    tasks.remove("tsk_2")
    expect(tasks.state.tasks).toHaveLength(1)

    const missing = setup({ tasks: () => Promise.reject(new WorkbenchRequestError("unavailable", "404")) })
    await missing.tasks.load()
    expect(missing.tasks.state.list).toBe("unavailable")
  })

  test("actions run one at a time and keep the server's refusal", async () => {
    let release!: (value: AgentHQ.Task) => void
    const { tasks, calls } = setup({
      startTask: () => new Promise<AgentHQ.Task>((resolve) => (release = resolve)),
      approveTask: () =>
        Promise.reject(new WorkbenchRequestError("failed", "the project has uncommitted changes to tracked files")),
    })
    tasks.upsert(task("tsk_1"))
    const first = tasks.start("tsk_1")
    await tasks.start("tsk_1")
    expect(tasks.state.busy.tsk_1).toBe("start")
    release(task("tsk_1", { status: "running", updatedAt: 2 }))
    await first
    expect(tasks.find("tsk_1")?.status).toBe("running")
    expect(calls.filter((call) => call.name === "startTask")).toHaveLength(1)
    expect(tasks.state.busy.tsk_1).toBeUndefined()

    await expect(tasks.approve("tsk_1", "c0ffee")).rejects.toThrow(
      "the project has uncommitted changes to tracked files",
    )
    // Approve carries the head of the review the user looked at.
    expect(calls.find((call) => call.name === "approveTask")?.args).toEqual(["tsk_1", "c0ffee"])
  })

  test("the dry run is kept per task and dropped when the task's status changes", async () => {
    const review = {
      taskID: "tsk_1",
      branch: "task-calm-river-1a2b",
      base: "main",
      commits: [{ sha: "abc", subject: "Ada (Agent HQ): task" }],
      files: [{ path: "a.ts", additions: 2, deletions: 1 }],
      clean: false,
      mergeable: true,
      reason: "the project has uncommitted changes to tracked files",
    } as unknown as AgentHQ.TaskReview
    const { tasks, calls } = setup({ taskReview: () => Promise.resolve(review) })
    tasks.upsert(task("tsk_1", { status: "review", updatedAt: 1 }))
    await tasks.review("tsk_1")
    expect(tasks.state.reviews.tsk_1).toMatchObject({ status: "ready", review: { clean: false } })
    tasks.upsert(task("tsk_1", { status: "review", updatedAt: 2 }))
    expect(tasks.state.reviews.tsk_1?.status).toBe("ready")
    tasks.upsert(task("tsk_1", { status: "done", updatedAt: 3 }))
    expect(tasks.state.reviews.tsk_1).toBeUndefined()
    expect(calls.filter((call) => call.name === "taskReview")).toHaveLength(1)
  })

  test("threads load once, merge events by id and read in order", async () => {
    const { tasks, calls } = setup({
      messages: () => Promise.resolve([message("amg_2", { taskID: "tsk_1" as AgentHQ.TaskID })]),
      sendMessage: (draft: { text: string }) =>
        Promise.resolve(message("amg_5", { text: draft.text, taskID: "tsk_1" as AgentHQ.TaskID })),
    })
    tasks.upsertMessage(message("amg_3", { taskID: "tsk_1" as AgentHQ.TaskID, from: "agt_bob" as AgentHQ.AgentID }))
    tasks.upsertMessage(message("amg_4", { to: "agt_bob" as AgentHQ.AgentID }))
    await tasks.loadThread({ taskID: "tsk_1" })
    await tasks.loadThread({ taskID: "tsk_1" })
    expect(calls.filter((call) => call.name === "messages")).toHaveLength(1)
    await tasks.send({ to: "agt_ada", text: "hello", taskID: "tsk_1" })
    expect(tasks.thread({ taskID: "tsk_1" }).map((item) => String(item.id))).toEqual(["amg_2", "amg_3", "amg_5"])
    expect(tasks.thread({ agentID: "agt_bob" }).map((item) => String(item.id))).toEqual(["amg_3", "amg_4"])
  })
})
