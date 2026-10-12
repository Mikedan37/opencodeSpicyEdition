import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Spicy Agent HQ tasks: the Tasks view of the Agents tab over mocked orchestration routes and injected events.
const directory = "/work/team"
const projectID = "proj_team"
const sessionID = "ses_team_host"
const title = "Team host"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

test("tasks: create with dependencies, start, review gate, approve refusal and merge, messages", async ({ page }) => {
  const mock = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="agents"]').click()
  await page.locator('[data-agenthq-view="tasks"]').click()
  const view = page.locator('[data-component="agenthq-tasks"]')
  await expect(view).toContainText("No tasks yet")

  // Create a task for Ada in its own worktree, then one for Bob that waits on it
  await view.locator('[data-action="task-new"]').click()
  const dialog = page.locator('[data-component="task-dialog"]')
  await dialog.locator('input[name="title"]').fill("Parse config")
  await dialog.locator('textarea[name="description"]').fill("Read config.toml")
  await expect(dialog.locator('select[name="assignee"]')).toHaveValue("agt_ada")
  await expect(dialog.locator('input[name="isolated"]')).toBeChecked()
  await dialog.getByRole("button", { name: "Create task" }).click()
  await expect(dialog).toBeHidden()
  expect(mock.posts.at(-1)).toEqual({
    path: "/agenthq/tasks",
    body: {
      title: "Parse config",
      assignee: "agt_ada",
      dependsOn: [],
      isolated: true,
      description: "Read config.toml",
    },
  })

  await view.locator('[data-action="task-new"]').click()
  await dialog.locator('input[name="title"]').fill("Write docs")
  await dialog.locator('select[name="assignee"]').selectOption("agt_bob")
  await dialog.locator('[data-depends-on="tsk_1"]').check()
  await dialog.locator('input[name="isolated"]').uncheck()
  await dialog.getByRole("button", { name: "Create task" }).click()
  await expect(dialog).toBeHidden()
  expect(mock.posts.at(-1)?.body).toEqual({
    title: "Write docs",
    assignee: "agt_bob",
    dependsOn: ["tsk_1"],
    isolated: false,
  })

  // Dependency order with indentation, chips and the waiting reason
  const rows = view.locator("button[data-task]")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute("data-task", "tsk_1")
  await expect(rows.nth(1)).toHaveAttribute("data-task", "tsk_2")
  await expect(rows.nth(1)).toHaveCSS("padding-left", "28px")
  await expect(rows.nth(1).locator('[data-dependency="tsk_1"]')).toHaveText("Parse config")
  await expect(rows.nth(1).locator('[data-slot="task-reason"]')).toHaveText('Waiting on "Parse config"')
  await rows.nth(1).click()
  const detail = view.locator('[data-component="agenthq-task"]')
  await expect(detail.locator('[data-action="task-start"]')).toHaveCount(0)

  // A refused edit keeps the dialog open with the server's words
  await rows.nth(0).click()
  await detail.locator('[data-action="task-edit"]').click()
  await dialog.locator('[data-depends-on="tsk_2"]').check()
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog.locator('[data-slot="task-dialog-error"]')).toHaveText(
    "Dependency cycle: Parse config → Write docs → Parse config",
  )
  await dialog.getByRole("button", { name: "Cancel" }).click()

  // Start: the worktree and the session appear; the session opens in Ada's workspace
  await detail.locator('[data-action="task-start"]').click()
  await expect.poll(() => mock.posts.at(-1)?.path).toBe("/agenthq/tasks/tsk_1/start")
  await expect(detail).toContainText("task-calm-river-1a2b")
  // The task's agent asks for a permission: the task says so and its session opens from there; coming back keeps
  // the task selected
  mock.emit({
    type: "agenthq.session.updated",
    properties: {
      session: {
        id: "ags_task",
        agentID: "agt_ada",
        provider: "opencode",
        taskID: "tsk_1",
        status: "needs_approval",
        pendingPermissions: 1,
        createdAt: 2,
        updatedAt: 3,
      },
    },
  })
  await expect(rows.nth(0).locator('[data-slot="task-approval"]')).toHaveText("Waiting for your approval")
  await detail.locator('[data-slot="task-approval"] button').click()
  const workspace = page.locator('[data-component="agenthq-workspace"]')
  await expect(workspace.locator('[data-session="ags_task"]')).toHaveAttribute("aria-current", "true")
  await workspace.getByRole("button", { name: "Back to agents" }).click()
  await expect(view).toBeVisible()
  await expect(detail).toHaveAttribute("data-task", "tsk_1")

  // Review: the dry run comes first; a dirty project disables Approve and says why
  mock.emit(
    taskEvent(mock.tasks.tsk_1!, {
      status: "review",
      result: { summary: "Parsed **the config**", evidenceIDs: [], sessionID: "ags_task" },
    }),
  )
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveText("Agents1")
  const gate = detail.locator('[data-component="agenthq-review"]')
  await expect(gate.locator('[data-slot="review-merge"]')).toHaveText("Approve merges task-calm-river-1a2b into main:")
  await expect(gate.locator('[data-slot="review-files"]')).toContainText("src/config.ts+12−3")
  await expect(gate.locator('[data-slot="review-commits"]')).toContainText("Ada (Agent HQ): Parse config")
  await expect(gate.locator('[data-slot="review-refusal"]')).toHaveText(
    "the project has uncommitted changes to tracked files",
  )
  await expect(gate.locator('[data-action="task-approve"]')).toBeDisabled()
  await expect(detail.locator("strong")).toHaveText("the config")
  expect(mock.approvals).toBe(0)

  // Check again after cleaning up; the merge itself is refused with the server's words, then succeeds
  mock.reviewClean = true
  await gate.locator('[data-action="task-review-refresh"]').click()
  await expect(gate.locator('[data-action="task-approve"]')).toBeEnabled()
  expect(mock.approvals).toBe(0)
  mock.approveRefusal = "merge failed: CONFLICT (content): Merge conflict in src/config.ts"
  await gate.locator('[data-action="task-approve"]').click()
  await expect(gate.locator('[data-slot="approve-refusal"]')).toHaveText(
    "merge failed: CONFLICT (content): Merge conflict in src/config.ts",
  )
  mock.approveRefusal = undefined
  await gate.locator('[data-action="task-approve"]').click()
  await expect(rows.nth(0).locator("[data-task-status]")).toHaveAttribute("data-task-status", "done")
  await expect(detail.locator('[data-slot="task-workspace"]')).toHaveText("Merged; its worktree is removed")
  expect(mock.approvals).toBe(2)
  mock.emit(taskEvent(mock.tasks.tsk_2!, { status: "ready", reason: undefined }))
  await expect(rows.nth(1).locator("[data-task-status]")).toHaveAttribute("data-task-status", "ready")
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveText("Agents")

  // Messages per task: from you, and from one agent to another with relay; a stopped exchange says why
  await rows.nth(1).click()
  const thread = detail.locator('[data-component="agenthq-messages"]')
  await expect(thread.locator('select[name="to"]')).toHaveValue("agt_bob")
  await thread.getByRole("textbox", { name: "Message" }).fill("Use the parsed keys")
  await thread.locator('[data-action="message-send"]').click()
  await expect(thread.locator("[data-message]")).toHaveCount(1)
  expect(mock.posts.at(-1)).toEqual({
    path: "/agenthq/messages",
    body: { to: "agt_bob", text: "Use the parsed keys", taskID: "tsk_2" },
  })
  await thread.locator('select[name="from"]').selectOption("agt_ada")
  await thread.locator('input[name="relay"]').check()
  await thread.getByRole("textbox", { name: "Message" }).fill("Which keys do you need?")
  await thread.locator('[data-action="message-send"]').click()
  await expect(thread.locator("[data-message]")).toHaveCount(2)
  expect(mock.posts.at(-1)?.body).toEqual({
    to: "agt_bob",
    text: "Which keys do you need?",
    from: "agt_ada",
    relay: true,
    taskID: "tsk_2",
  })
  mock.emit({
    type: "agenthq.message",
    properties: {
      message: message("amg_9", {
        from: "agt_bob",
        to: "agt_ada",
        text: "The same keys again",
        taskID: "tsk_2",
        hops: 7,
        delivery: "failed",
        reason: "Stopped: the exchange reached the 6-reply limit",
      }),
    },
  })
  await expect(thread.locator('[data-message="amg_9"] [data-slot="message-reason"]')).toHaveText(
    "Stopped: the exchange reached the 6-reply limit",
  )

  // Per agent: Bob's workspace lists the messages he sent or received
  await page.locator('[data-agenthq-view="agents"]').click()
  await page.locator('[data-component="agenthq-card"][data-agent="agt_bob"]').click()
  await workspace.locator('[data-action="agent-messages"]').click()
  await expect(workspace.locator("[data-message]")).toHaveCount(4)
  await expect.poll(() => mock.threads).toContain("agentID=agt_bob")

  // Start then cancel the second task; deleting the first is refused while it is depended on
  await workspace.getByRole("button", { name: "Back to agents" }).click()
  await page.locator('[data-agenthq-view="tasks"]').click()
  await rows.nth(1).click()
  await detail.locator('[data-action="task-start"]').click()
  await expect(detail.locator('[data-action="task-cancel"]')).toBeVisible()
  await detail.locator('[data-action="task-cancel"]').click()
  await expect(rows.nth(1).locator("[data-task-status]")).toHaveAttribute("data-task-status", "cancelled")
  await rows.nth(0).click()
  await detail.locator('[data-action="task-delete"]').click()
  await detail.locator('[data-action="task-delete"]').click()
  await expect(page.getByText("task tsk_2 depends on it")).toBeVisible()
  await expect(rows).toHaveCount(2)
})

function agent(id: string, name: string) {
  return {
    id,
    name,
    avatar: { kind: "preset", value: id === "agt_ada" ? "fox" : "owl", color: "orange" },
    provider: "opencode",
    projectDirectory: directory,
    createdAt: 1,
    updatedAt: 1,
  }
}

type Task = Record<string, unknown> & { id: string; title: string; status: string; updatedAt: number }

// An event newer than anything the routes returned for this task.
function taskEvent(task: Task, patch: Record<string, unknown>) {
  Object.assign(task, patch, { updatedAt: task.updatedAt + 1 })
  return { type: "agenthq.task.updated", properties: { task: { ...task } } }
}

function message(id: string, patch: Record<string, unknown>) {
  return {
    id,
    from: "user",
    to: "agt_bob",
    text: "",
    evidenceIDs: [],
    at: Number(id.replace(/\D/g, "")),
    delivery: "delivered",
    kind: "user",
    hops: 0,
    relay: false,
    ...patch,
  }
}

async function setup(page: Page) {
  const pending: { directory: string; payload: unknown }[] = []
  let clock = 10
  const mock = {
    tasks: {} as Record<string, Task>,
    posts: [] as { path: string; body: unknown }[],
    threads: [] as string[],
    approvals: 0,
    reviewClean: false,
    approveRefusal: undefined as string | undefined,
    emit(...items: Record<string, unknown>[]) {
      pending.push(...items.map((item) => ({ directory, payload: { id: `evt_${Math.random()}`, ...item } })))
    },
  }
  const messages: Record<string, unknown>[] = [
    message("amg_1", { from: "agt_bob", to: "agt_ada", text: "Earlier note", kind: "agent" }),
  ]

  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "team",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    events: () => pending.splice(0),
  })

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })

  await page.route(`${server}/agenthq/**`, (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const body = request.postDataJSON() as Record<string, unknown> | null
    if (method === "POST" || method === "PATCH") mock.posts.push({ path, body })
    if (path === "/agenthq/providers")
      return json(route, [
        {
          id: "opencode",
          name: "OpenCode",
          available: true,
          auth: "ok",
          capabilities: {
            streaming: true,
            toolEvents: true,
            permissionRequests: true,
            cancel: true,
            resume: false,
            models: true,
            mcpTools: false,
          },
        },
      ])
    if (path === "/agenthq/agents") return json(route, [agent("agt_ada", "Ada"), agent("agt_bob", "Bob")])
    if (path === "/agenthq/agents/agt_ada/sessions")
      return json(route, [
        {
          id: "ags_task",
          agentID: "agt_ada",
          provider: "opencode",
          title: "Parse config",
          taskID: "tsk_1",
          status: "working",
          pendingPermissions: 0,
          createdAt: 2,
          updatedAt: 2,
        },
      ])
    if (path.match(/^\/agenthq\/agents\/[^/]+\/sessions$/)) return json(route, [])
    if (path === "/agenthq/sessions/ags_task")
      return json(route, {
        session: {
          id: "ags_task",
          agentID: "agt_ada",
          provider: "opencode",
          status: "working",
          pendingPermissions: 0,
          createdAt: 2,
          updatedAt: 2,
        },
        history: [],
      })
    if (path === "/agenthq/tasks" && method === "GET") return json(route, Object.values(mock.tasks))
    if (path === "/agenthq/tasks" && method === "POST") {
      const id = `tsk_${Object.keys(mock.tasks).length + 1}`
      const dependsOn = (body?.dependsOn as string[]) ?? []
      const waiting = dependsOn.map((dep) => mock.tasks[dep]).filter((task) => task && task.status !== "done")
      const task: Task = {
        id,
        title: String(body?.title),
        ...(body?.description ? { description: body.description } : {}),
        assignee: body?.assignee,
        dependsOn,
        status: waiting.length ? "pending" : "ready",
        ...(waiting.length ? { reason: `Waiting on ${waiting.map((dep) => `"${dep!.title}"`).join(", ")}` } : {}),
        isolated: !!body?.isolated,
        createdAt: clock++,
        updatedAt: clock,
      }
      mock.tasks[id] = task
      return json(route, task)
    }
    const match = path.match(/^\/agenthq\/tasks\/(tsk_\d+)(?:\/(\w+))?$/)
    const task = match ? mock.tasks[match[1]!] : undefined
    if (match && task) {
      const action = match[2]
      clock++
      if (!action && method === "PATCH")
        return json(
          route,
          { _tag: "BadRequest", message: "Dependency cycle: Parse config → Write docs → Parse config" },
          400,
        )
      if (!action && method === "DELETE")
        return json(route, { _tag: "ConflictError", message: `task tsk_2 depends on it` }, 409)
      if (action === "start")
        return json(
          route,
          Object.assign(task, {
            status: "running",
            updatedAt: clock,
            reason: undefined,
            ...(task.isolated
              ? { worktree: { path: "/data/worktree/proj_team/task-calm-river-1a2b", branch: "task-calm-river-1a2b" } }
              : {}),
            result: { evidenceIDs: [], sessionID: task.id === "tsk_1" ? "ags_task" : "ags_other" },
          }),
        )
      if (action === "cancel") return json(route, Object.assign(task, { status: "cancelled", updatedAt: clock }))
      if (action === "review")
        return json(route, {
          taskID: task.id,
          branch: "task-calm-river-1a2b",
          base: "main",
          commits: [{ sha: "0123456789abcdef", subject: "Ada (Agent HQ): Parse config" }],
          files: [{ path: "src/config.ts", additions: 12, deletions: 3 }],
          clean: mock.reviewClean,
          mergeable: true,
          ...(mock.reviewClean ? {} : { reason: "the project has uncommitted changes to tracked files" }),
        })
      if (action === "approve") {
        mock.approvals++
        if (mock.approveRefusal) return json(route, { _tag: "ConflictError", message: mock.approveRefusal }, 409)
        return json(route, Object.assign(task, { status: "done", updatedAt: clock, worktree: undefined }))
      }
    }
    if (path === "/agenthq/messages" && method === "GET") {
      mock.threads.push(url.searchParams.toString().replace(/&?directory=[^&]*/, ""))
      return json(route, messages)
    }
    if (path === "/agenthq/messages" && method === "POST") {
      const sent = message(`amg_${clock++}`, {
        ...body,
        from: body?.from ?? "user",
        kind: body?.from ? "agent" : "user",
        relay: !!body?.relay,
      })
      messages.push(sent)
      return json(route, sent)
    }
    return json(route, { message: path }, 404)
  })

  // Opening the bottom panel starts a terminal.
  const ptyID = "pty_team"
  const pty = { id: ptyID, title: "Terminal 1", command: "zsh", args: [], cwd: directory, status: "running", pid: 1 }
  const location = { directory, project: { id: projectID, directory } }
  await page.route("**/api/pty*", (route) => json(route, { location, data: pty }))
  await page.route(`**/api/pty/${ptyID}*`, (route) => json(route, { location, data: pty }))
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyID}/connect`), () => undefined)

  await page.addInitScript(
    (input) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: input.directory, expanded: true }] },
          lastProject: { local: input.directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server: input.server, sessionId: input.sessionID }]),
      )
    },
    { directory, server, sessionID },
  )

  return mock
}
