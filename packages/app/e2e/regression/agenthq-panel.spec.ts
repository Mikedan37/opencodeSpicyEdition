import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Spicy Workbench: Agent HQ and Problems tabs in the bottom panel, driven by injected agenthq.* / workbench.* events.
const directory = "C:/OpenCode/AgentHQ"
const projectID = "proj_agenthq"
const sessionID = "ses_agenthq_host"
const title = "Agent HQ host"
const ptyID = "pty_agenthq"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const agentSession = "ags_parser"

test.use({ viewport: { width: 1440, height: 900 } })

test("agent hq streams, asks for permission, resyncs on a seq gap; problems open files", async ({ page }) => {
  const mock = await setup(page)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()

  // Roster: provider chip, status pill from the session list
  await page.locator('[data-workbench-tab="agents"]').click()
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveAttribute("aria-selected", "true")
  const card = page.locator('[data-component="agenthq-card"][data-agent="agt_ada"]')
  await expect(card).toContainText("Ada")
  await expect(card).toContainText("OpenCode")
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "working")

  // Workspace: history loads once
  await card.click()
  const workspace = page.locator('[data-component="agenthq-workspace"]')
  await expect(workspace.locator('[data-row="message"][data-role="user"]')).toContainText("Fix the parser bug")
  expect(mock.historyRequests()).toBe(1)

  // Streaming deltas land in one assistant message
  mock.emit(
    envelope(1, { type: "message.delta", messageID: "a1", text: "Looking" }),
    envelope(2, { type: "message.delta", messageID: "a1", text: " at" }),
    envelope(3, { type: "message.delta", messageID: "a1", text: " it" }),
    envelope(4, { type: "tool", callID: "c1", tool: "bash", state: "running", title: "bun test parser" }),
    envelope(5, {
      type: "permission.requested",
      requestID: "perm_1",
      title: "Run bun test parser",
      tool: "bash",
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "reject", label: "Reject", kind: "reject_once" },
      ],
    }),
  )
  await expect(workspace.locator('[data-row="message"][data-role="assistant"]')).toContainText("Looking at it")
  await expect(workspace.locator('[data-row="tool"][data-state="running"]')).toContainText("bun test parser")

  // Permission: nothing is answered until the user clicks, and the card resolves only on the server's event
  const permission = workspace.locator('[data-row="permission"][data-request="perm_1"]')
  await expect(permission).toContainText("Run bun test parser")
  expect(mock.answers).toEqual([])
  await permission.locator('[data-option="allow"]').click()
  await expect.poll(() => mock.answers).toEqual([{ requestID: "perm_1", body: { optionID: "allow" } }])
  await expect(permission.locator('[data-option="reject"]')).toBeDisabled()
  mock.emit(envelope(6, { type: "permission.resolved", requestID: "perm_1", outcome: "allowed" }))
  await expect(permission).toContainText("Allowed")

  // A gap (7 and 8 never arrive) triggers one history reload that fills it in
  mock.history.push(
    envelope(7, { type: "message.delta", messageID: "a1", text: ", found" }),
    envelope(8, { type: "message.delta", messageID: "a1", text: " the bug" }),
    envelope(9, { type: "turn.completed", stopReason: "end_turn" }),
  )
  mock.emit(envelope(9, { type: "turn.completed", stopReason: "end_turn" }))
  await expect.poll(() => mock.historyRequests()).toBe(2)
  await expect(workspace.locator('[data-row="message"][data-role="assistant"]')).toContainText(
    "Looking at it, found the bug",
  )
  await expect(workspace.locator('[data-row="turn"]')).toContainText("end_turn")

  // The complete message replaces the streamed text and renders as Markdown (code highlighted, unsafe links dropped)
  mock.emit(
    envelope(10, {
      type: "message",
      messageID: "a1",
      role: "assistant",
      text: "Found **the bug**:\n\n```ts\nconst fixed = true\n```\n\n[docs](https://example.com) [bad](javascript:alert(1))",
    }),
  )
  const reply = workspace.locator('[data-row="message"][data-role="assistant"]')
  await expect(reply.locator("strong")).toHaveText("the bug")
  await expect(reply.locator('[data-component="markdown-code"]')).toContainText("const fixed = true")
  await expect(reply.locator('a[href="https://example.com"]')).toHaveAttribute("target", "_blank")
  await expect(reply.locator("a", { hasText: "bad" })).not.toHaveAttribute("href", /.*/)

  // Attention: a session waiting for approval badges the card and the tab
  await workspace.getByRole("button", { name: "Back to agents" }).click()
  mock.emit({
    type: "agenthq.session.updated",
    properties: { session: { ...sessionInfo, status: "needs_approval", pendingPermissions: 1, updatedAt: 3 } },
  })
  await expect(card.locator('[data-attention="needs_approval"]')).toBeVisible()
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveText("Agents1")

  // Problems: grouped by file, counts in the tab, refetch on workbench.problems.updated
  await expect(page.locator('[data-workbench-tab="problems"]')).toHaveText("Problems2")
  await page.locator('[data-workbench-tab="problems"]').click()
  const problems = page.locator('[data-component="workbench-problems"]')
  await expect(problems.locator('[data-row="file"]')).toContainText("parser.ts")
  await expect(problems.locator('[data-row="problem"]')).toHaveCount(2)
  await expect(problems.locator('[data-problem="p_stale"]')).toContainText("Stale")
  await problems.locator('[data-severity="warning"]').click()
  await expect(problems.locator('[data-row="problem"]')).toHaveCount(1)
  const before = mock.problemRequests()
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: counts(1, 1) } })
  await expect.poll(() => mock.problemRequests()).toBe(before + 1)

  // The selected tab is persisted per project and survives the panel remounting
  await page.locator('[data-workbench-tab="agents"]').click()
  await page.reload()
  await expectSessionTitle(page, title)
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-component="workbench-panel"][data-tab="agents"]')).toBeVisible()

  // Terminal focus hands the tab bar back to the terminal
  await page.keyboard.press("Control+Backquote")
  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()
  await expect(page.locator('[data-component="workbench-panel"]')).toHaveCount(0)
})

const sessionInfo = {
  id: agentSession,
  agentID: "agt_ada",
  provider: "opencode",
  title: "Fix the parser",
  status: "working",
  pendingPermissions: 0,
  createdAt: 1,
  updatedAt: 2,
}

function envelope(seq: number, event: Record<string, unknown>) {
  return { sessionID: agentSession, seq, at: seq, event }
}

function counts(error: number, warning: number) {
  return { error, warning, info: 0, hint: 0 }
}

function problem(id: string, severity: "error" | "warning", line: number, stale = false) {
  return {
    id,
    file: `${directory}/src/parser.ts`,
    range: { start: { line, character: 2 }, end: { line, character: 8 } },
    severity,
    message: `${severity} at ${line + 1}`,
    code: severity === "error" ? 2304 : undefined,
    source: { kind: "typecheck", tool: "tsc", producer: "check:tsc:/repo" },
    observedAt: 1,
    stale,
  }
}

async function setup(page: Page) {
  const pending: unknown[] = []
  const history: Record<string, unknown>[] = [
    envelope(0, { type: "message", messageID: "u1", role: "user", text: "Fix the parser bug" }),
  ]
  const answers: { requestID: string; body: unknown }[] = []
  const calls = { history: 0, problems: 0 }

  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agenthq",
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
    // Each SSE connection drains what the test queued; the client reconnects every 250 ms.
    events: () => pending.splice(0).map((payload) => ({ directory, payload })),
  })

  const json = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })

  // Scoped to the server origin: the Vite dev server also serves /src/agenthq/* and /src/workbench/* modules.
  await page.route(`${server}/agenthq/**`, (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get("directory")).toBe(directory)
    const path = url.pathname
    if (path === "/agenthq/providers")
      return json(route, [
        {
          id: "opencode",
          name: "OpenCode",
          available: true,
          auth: "ok",
          capabilities: capabilities(true),
        },
        {
          id: "cursor",
          name: "Cursor",
          available: false,
          auth: "unknown",
          reason: "cursor-agent 2025.09.12 has no ACP mode",
          capabilities: capabilities(false),
        },
      ])
    if (path === "/agenthq/agents")
      return json(route, [
        {
          id: "agt_ada",
          name: "Ada",
          avatar: { kind: "preset", value: "fox", color: "orange" },
          provider: "opencode",
          specialty: "Parsers",
          projectDirectory: directory,
          createdAt: 1,
          updatedAt: 1,
        },
      ])
    if (path === "/agenthq/agents/agt_ada/sessions") return json(route, [sessionInfo])
    if (path === `/agenthq/sessions/${agentSession}`) {
      calls.history++
      return json(route, { session: sessionInfo, history })
    }
    const answer = path.match(/^\/agenthq\/sessions\/[^/]+\/permissions\/([^/]+)$/)?.[1]
    if (answer) {
      answers.push({ requestID: answer, body: route.request().postDataJSON() })
      return json(route, { accepted: true })
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: path }) })
  })

  await page.route(`${server}/workbench/problems*`, (route) => {
    calls.problems++
    return json(route, {
      problems: [problem("p_error", "error", 4), problem("p_stale", "warning", 9, true)],
      counts: counts(1, 1),
      producers: [],
    })
  })

  await page.route("**/api/pty*", (route) => json(route, { location: ptyLocation(), data: ptyInfo() }))
  await page.route(`**/api/pty/${ptyID}*`, (route) => json(route, { location: ptyLocation(), data: ptyInfo() }))
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyID}/connect`), () => undefined)

  await page.addInitScript(
    (input) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
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

  return {
    history,
    answers,
    historyRequests: () => calls.history,
    problemRequests: () => calls.problems,
    emit(...items: Record<string, unknown>[]) {
      pending.push(
        ...items.map((item) =>
          "seq" in item
            ? { id: `evt_${Math.random()}`, type: "agenthq.session.event", properties: { envelope: item } }
            : { id: `evt_${Math.random()}`, ...item },
        ),
      )
      for (const item of items)
        if ("seq" in item && !history.some((entry) => entry.seq === item.seq)) history.push(item)
    },
  }
}

function capabilities(value: boolean) {
  return {
    streaming: value,
    toolEvents: value,
    permissionRequests: value,
    cancel: value,
    resume: false,
    models: value,
    mcpTools: false,
  }
}

function ptyLocation() {
  return { directory, project: { id: projectID, directory } }
}

function ptyInfo() {
  return { id: ptyID, title: "Terminal 1", command: "cmd.exe", args: [], cwd: directory, status: "running", pid: 1 }
}
