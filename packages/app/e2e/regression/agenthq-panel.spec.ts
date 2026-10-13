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
  // UX #15: a normal end is just "Turn completed", without the provider's stop reason
  await expect(workspace.locator('[data-row="turn"]')).toHaveText("Turn completed")

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

  // A cancelled turn ends with a divider, not half a sentence
  mock.emit(
    envelope(11, { type: "message.delta", messageID: "a2", text: "Let me also chec" }),
    envelope(12, { type: "status", status: "cancelled" }),
  )
  await expect(workspace.locator('[data-row="turn"][data-reason="cancelled"]')).toHaveText("Cancelled by you")

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
  // UX #15: the folder is project-relative
  await expect(problems.locator('[data-row="file"]')).toContainText("src/")
  await expect(problems.locator('[data-row="file"]')).not.toContainText(directory)
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

test("output tab streams check runs with colors and file links, and loads earlier runs", async ({ page }) => {
  const mock = await setup(page, {
    runs: {
      list: [runInfo("run_old", "passed", { exitCode: 0, finishedAt: 1_700_000_001_200 })],
      detail: {
        run_old: {
          run: runInfo("run_old", "passed", { exitCode: 0, finishedAt: 1_700_000_001_200 }),
          output: "earlier run output\n",
        },
      },
    },
  })
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()
  await page.locator('[data-workbench-tab="output"]').click()
  const output = page.locator('[data-component="workbench-output"]')

  // History from GET /workbench/runs; output only when the section opens
  const old = output.locator('section[data-run="run_old"]')
  await expect(old).toHaveAttribute("data-status", "passed")
  await expect(old).toContainText("earlier run output")
  expect(mock.runRequests()).toEqual(["/workbench/runs", "/workbench/runs/run_old"])

  // A run streamed live: status, colors, file links, then the final status with exit code
  mock.emit({ type: "workbench.run.updated", properties: { run: runInfo("run_live", "running") } })
  const live = output.locator('section[data-run="run_live"]')
  await expect(live).toHaveAttribute("data-status", "running")
  await expect(page.locator('[data-workbench-tab="output"]')).toHaveText("Output1")
  mock.emit(
    {
      type: "workbench.run.output",
      properties: { runID: "run_live", seq: 0, chunk: "\u001b[31msrc/broken.ts(1,14)\u001b[0m: error TS2322: nope\n" },
    },
    { type: "workbench.run.output", properties: { runID: "run_live", seq: 1, chunk: "Found 1 error.\n" } },
  )
  const link = live.locator('[role="region"] button', { hasText: "src/broken.ts(1,14)" })
  await expect(link).toBeVisible()
  await expect(live.locator('span[style*="--ansi-red"]')).toContainText("src/broken.ts(1,14)")
  await expect(live).toContainText("Found 1 error.")
  mock.emit({
    type: "workbench.run.updated",
    properties: {
      run: runInfo("run_live", "failed", { exitCode: 2, finishedAt: 1_700_000_000_900, counts: counts(1, 0) }),
    },
  })
  await expect(live).toHaveAttribute("data-status", "failed")
  await expect(live.locator("button[aria-expanded]")).toContainText("exit 2")
  await expect(page.locator('[data-workbench-tab="output"]')).toHaveText("Output")

  // Starting checks needs POST /workbench/check; without it the user is told, nothing breaks
  await output.getByRole("button", { name: "Run checks" }).click()
  await expect(page.getByText("This server can't start checks from the app yet.")).toBeVisible()
  expect(mock.checkRequests()).toBe(1)
})

test("agents of other projects stay live; a completion nobody viewed stays flagged across reloads", async ({
  page,
}) => {
  const mock = await setup(page)
  const elsewhere = "C:/OpenCode/Elsewhere"
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()
  await page.locator('[data-workbench-tab="agents"]').click()
  await expect(page.locator('[data-component="agenthq-card"][data-agent="agt_ada"]')).toBeVisible()

  // Events of an agent working in another project arrive with that project's directory
  const bo = agent("agt_bo", "Bo", elsewhere)
  const working = { ...sessionInfo, id: "ags_bo", agentID: "agt_bo", title: "Port the lexer", updatedAt: 5 }
  mock.emitIn(elsewhere, { type: "agenthq.agent.updated", properties: { agent: bo } })
  mock.emitIn(elsewhere, { type: "agenthq.session.updated", properties: { session: working } })
  const card = page.locator('[data-component="agenthq-card"][data-agent="agt_bo"]')
  await expect(card).toContainText("Port the lexer")
  await expect(card).toContainText("Elsewhere")
  await expect(card.locator("[data-status]")).toHaveAttribute("data-status", "working")

  const done = { ...working, status: "completed", updatedAt: 6 }
  mock.emitIn(elsewhere, { type: "agenthq.session.updated", properties: { session: done } })
  await expect(card.locator('[data-attention="completed"]')).toBeVisible()

  // The server now lists Bo; after a reload the completion is still unviewed
  mock.agents.push(bo)
  mock.sessions.agt_bo = [done]
  await page.reload()
  await expectSessionTitle(page, title)
  await expect(card.locator('[data-attention="completed"]')).toBeVisible()

  // Viewing it clears the flag, also after another reload
  await card.click()
  await expect(page.locator('[data-component="agenthq-workspace"]')).toContainText("Bo")
  await page.getByRole("button", { name: "Back to agents" }).click()
  await expect(card.locator("[data-attention]")).toHaveCount(0)
  await page.reload()
  await expectSessionTitle(page, title)
  await expect(card).toBeVisible()
  await expect(card.locator("[data-attention]")).toHaveCount(0)
})

// UI-01: a large problem list stays a bounded window of rows; search and scrolling keep up.
test("UI-01 5,000 problems stay virtualized while searching and scrolling", async ({ page }) => {
  await setup(page)
  const many = Array.from({ length: 5_000 }, (_, index) => ({
    ...problem(`p_${index}`, index % 2 ? "warning" : "error", index % 100),
    file: `${directory}/src/file${String(Math.floor(index / 100)).padStart(2, "0")}.ts`,
    message: `problem ${index}`,
  }))
  // Registered after setup's route, so it answers first.
  await page.route(`${server}/workbench/problems*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ problems: many, counts: counts(2_500, 2_500), producers: [] }),
    }),
  )

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="problems"]').click()
  const panel = page.locator('[data-component="workbench-problems"]')
  const rows = panel.locator('[data-row="problem"], [data-row="file"]')
  await expect(panel.locator('[data-row="file"]').first()).toContainText("file00.ts")
  expect(await rows.count()).toBeGreaterThan(0)
  expect(await rows.count()).toBeLessThan(200)

  const search = panel.getByRole("textbox", { name: "Filter problems" })
  const started = Date.now()
  await search.fill("problem 4999")
  await expect(panel.locator('[data-row="problem"]')).toHaveCount(1)
  expect(Date.now() - started).toBeLessThan(2_000)

  await search.fill("")
  await expect(panel.locator('[data-row="file"]').first()).toContainText("file00.ts")
  await panel.getByRole("region", { name: "Problems" }).evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(panel.locator('[data-row="problem"]').last()).toContainText("problem 4999")
  expect(await rows.count()).toBeLessThan(200)
})

test("UX #3 permission cards show what they approve: a diff, a command with its cwd, one line", async ({ page }) => {
  const mock = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="agents"]').click()
  await page.locator('[data-component="agenthq-card"][data-agent="agt_ada"]').click()
  const workspace = page.locator('[data-component="agenthq-workspace"]')
  await expect(workspace.locator('[data-row="message"][data-role="user"]')).toContainText("Fix the parser bug")
  const options = [
    { id: "once", label: "Allow once", kind: "allow_once" },
    { id: "always", label: "Always allow", kind: "allow_always" },
    { id: "reject", label: "Reject", kind: "reject_once" },
  ]
  mock.emit(
    envelope(1, {
      type: "permission.requested",
      requestID: "perm_edit",
      title: "Edit src/parser.ts",
      tool: "edit",
      details: '{"filepath":"/private/var/folders/x/src/parser.ts","diff":"…"}',
      preview: {
        kind: "edit",
        path: "src/parser.ts",
        diff: "Index: src/parser.ts\n===================================================================\n--- src/parser.ts\n+++ src/parser.ts\n@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n const b = 3\n",
      },
      options,
    }),
    envelope(2, {
      type: "permission.requested",
      requestID: "perm_bash",
      title: `Run the tests in ${directory}/packages/parser`,
      tool: "bash",
      preview: { kind: "command", command: "bun test parser", cwd: `${directory}/packages/parser` },
      options,
    }),
    envelope(3, {
      type: "permission.requested",
      requestID: "perm_other",
      title: "Fetch a page",
      preview: { kind: "other", summary: "GET https://example.com/docs" },
      options,
    }),
    envelope(4, {
      type: "permission.requested",
      requestID: "perm_old",
      title: "Old adapter",
      details: '{"raw":true}',
      options,
    }),
  )
  const edit = workspace.locator('[data-row="permission"][data-request="perm_edit"]')
  await expect(edit.locator('[data-slot="permission-edit"] [data-component="file"][data-mode="diff"]')).toBeVisible()
  await expect(edit.locator('[data-slot="permission-edit"]')).toContainText("src/parser.ts")
  await expect(edit).not.toContainText("/private/var/folders")
  // Only Allow once is primary; "always" says what it covers.
  await expect(edit.locator("[data-option]")).toHaveText(["Allow once", "Always allow edits in this session", "Reject"])
  await expect(edit.locator('[data-option="once"]')).toHaveAttribute("data-variant", "contrast")
  await expect(edit.locator('[data-option="always"]')).not.toHaveAttribute("data-variant", "contrast")
  const bash = workspace.locator('[data-row="permission"][data-request="perm_bash"]')
  await expect(bash.locator('[data-slot="permission-command"]')).toContainText("$ bun test parser")
  // UX #15: paths relative to where the agent works
  await expect(bash.locator('[data-slot="permission-command"]')).toContainText("in packages/parser")
  await expect(bash).toContainText("Run the tests in packages/parser")
  await expect(bash).not.toContainText(directory)
  await expect(bash.locator('[data-option="always"]')).toHaveText("Always allow this command in this session")
  await expect(workspace.locator('[data-request="perm_other"] [data-slot="permission-other"]')).toHaveText(
    "GET https://example.com/docs",
  )
  await expect(workspace.locator('[data-request="perm_old"]')).toContainText('{"raw":true}')
  await edit.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath("ux3-permission-preview.png") })
})

function agent(id: string, name: string, projectDirectory: string) {
  return {
    id,
    name,
    avatar: { kind: "preset", value: id === "agt_ada" ? "fox" : "owl", color: "orange" },
    provider: "opencode",
    specialty: "Parsers",
    projectDirectory,
    createdAt: 1,
    updatedAt: 1,
  }
}

function runInfo(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "check",
    unit: `${directory}/tsconfig.json`,
    checker: "tsc",
    command: ["tsc", "--noEmit", "-p", `${directory}/tsconfig.json`],
    execClass: "inert",
    status,
    startedAt: 1_700_000_000_000,
    ...extra,
  }
}

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

type RunsRoutes = { list: unknown[]; detail: Record<string, unknown> }

async function setup(page: Page, options: { runs?: RunsRoutes } = {}) {
  const pending: { directory: string; payload: unknown }[] = []
  const history: Record<string, unknown>[] = [
    envelope(0, { type: "message", messageID: "u1", role: "user", text: "Fix the parser bug" }),
  ]
  const answers: { requestID: string; body: unknown }[] = []
  const calls = { history: 0, problems: 0, runs: [] as string[], checks: 0 }
  // What GET /agenthq/agents and /agenthq/agents/:id/sessions return; tests change them to simulate the server.
  const agents: Record<string, unknown>[] = [agent("agt_ada", "Ada", directory)]
  const sessions: Record<string, { id: string }[]> = { agt_ada: [sessionInfo] }

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
    events: () => pending.splice(0),
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
    if (path === "/agenthq/agents") return json(route, agents)
    const listed = path.match(/^\/agenthq\/agents\/([^/]+)\/sessions$/)?.[1]
    if (listed) return json(route, sessions[listed] ?? [])
    if (path === `/agenthq/sessions/${agentSession}`) {
      calls.history++
      return json(route, { session: sessionInfo, history })
    }
    const detail = path.match(/^\/agenthq\/sessions\/([^/]+)$/)?.[1]
    const other = Object.values(sessions)
      .flat()
      .find((item) => item.id === detail)
    if (other) return json(route, { session: other, history: [] })
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

  // The runs routes are optional on the server: without them the Output tab works from events alone.
  await page.route(`${server}/workbench/runs**`, (route) => {
    const path = new URL(route.request().url()).pathname
    calls.runs.push(path)
    const detail = options.runs?.detail[path.split("/").at(-1) ?? ""]
    if (path === "/workbench/runs" && options.runs) return json(route, options.runs.list)
    if (detail) return json(route, detail)
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: path }) })
  })
  await page.route(`${server}/workbench/check*`, (route) => {
    calls.checks++
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
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
    agents,
    sessions,
    historyRequests: () => calls.history,
    problemRequests: () => calls.problems,
    runRequests: () => calls.runs,
    checkRequests: () => calls.checks,
    emit(...items: Record<string, unknown>[]) {
      this.emitIn(directory, ...items)
    },
    // Events published by another project's instance carry that project's directory.
    emitIn(target: string, ...items: Record<string, unknown>[]) {
      pending.push(
        ...items.map((item) => ({
          directory: target,
          payload:
            "seq" in item
              ? { id: `evt_${Math.random()}`, type: "agenthq.session.event", properties: { envelope: item } }
              : { id: `evt_${Math.random()}`, ...item },
        })),
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
