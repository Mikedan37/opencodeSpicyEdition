import { expect, test, type Page } from "@playwright/test"
import { ada, mockWorkbench, problemsSnapshot } from "../utils/workbench-mock"

// UX audit #1: the IDE is found without ctrl+`: the status strip, the palette's commands, the one-time card.
const directory = "/work/discover"
const title = "Discover the IDE"

test.use({ viewport: { width: 1440, height: 900 } })

test("the status strip is always there, and each item opens its tab with the panel", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory, title })
  mock.agents = [{ ...ada, projectDirectory: directory }]
  mock.tasks = [
    {
      id: "tsk_1",
      title: "Write the notes",
      assignee: "agt_ada",
      dependsOn: [],
      status: "review",
      isolated: false,
      createdAt: 1,
      updatedAt: 2,
    },
  ]
  await open()
  const strip = page.locator('[data-component="workbench-status"]')
  const panel = page.locator('[data-component="workbench-panel"]')
  // The panel is closed; nothing has been checked.
  await expect(panel).toHaveCount(0)
  await expect(strip.locator('[data-status="problems"]')).toHaveText("ProblemsNot checked yet")
  await expect(strip.locator('[data-status="agents"]')).toHaveText("Agents1 needs you")
  await expect(strip.locator('[data-status="debug"]')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("strip-closed.png") })

  // Problems arrive: the counts show; the item opens the Problems tab, opening the panel.
  mock.snapshot = problemsSnapshot(
    [problem("p1", "error"), problem("p2", "error"), problem("p3", "warning")],
    [{ producer: "check:tsc", kind: "typecheck", tool: "tsc", state: "idle", updatedAt: Date.now() }],
  )
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: mock.snapshot.counts } })
  await expect(strip.locator('[data-status="problems"]')).toHaveText("Problems2 errors · 1 warning")
  await strip.locator('[data-status="problems"]').click()
  await expect(page.locator('[data-workbench-tab="problems"]')).toHaveAttribute("aria-selected", "true")
  await expect(panel).toHaveAttribute("data-tab", "problems")

  // A paused program shows its state; the item opens the Debug Console.
  mock.emit({
    type: "workbench.debug.updated",
    properties: {
      session: {
        id: "dbg_1",
        adapter: "debugpy",
        program: `${directory}/app.py`,
        state: "stopped",
        owner: "human",
        capabilities: [],
        startedAt: 1,
        stop: {
          reason: "exception",
          threadID: 1,
          frames: [],
          locals: [],
          exception: { id: "ZeroDivisionError", description: "division by zero" },
          at: 2,
        },
      },
    },
  })
  await expect(strip.locator('[data-status="debug"]')).toHaveText("DebugPaused: ZeroDivisionError")
  await strip.locator('[data-status="debug"]').click()
  await expect(panel).toHaveAttribute("data-tab", "debug")

  // Agents: the needs-you count; the item opens the Agents tab.
  await strip.locator('[data-status="agents"]').click()
  await expect(panel).toHaveAttribute("data-tab", "agents")
  // The panel toggle closes and opens the panel.
  await strip.locator('[data-status="panel"]').click()
  await expect(panel).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("strip-items.png") })
})

test("keyboard focus on a Workbench tab shows a ring (UX a11y)", async ({ page }) => {
  const { open } = await mockWorkbench(page, { directory, title })
  await open()
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="problems"]').click()
  const output = page.locator('[data-workbench-tab="output"]').locator("xpath=..")
  await expect(output).not.toHaveCSS("box-shadow", /0px 0px 0px 2px inset/)
  await page.keyboard.press("ArrowRight")
  await expect(page.locator('[data-workbench-tab="output"]')).toBeFocused()
  await expect(output).toHaveCSS("box-shadow", /0px 0px 0px 2px inset/)
  await page.screenshot({ path: test.info().outputPath("a11y-tab-focus.png") })
})

test("the palette has every IDE tab and the IDE's actions", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory, title })
  mock.runs = [
    {
      id: "run_1",
      kind: "check",
      unit: directory,
      checker: "tsc",
      command: ["tsc", "--noEmit"],
      execClass: "inert",
      status: "failed",
      startedAt: 1,
      finishedAt: 2,
    },
  ]
  mock.checkSummary = { passed: 2, failed: 1, skipped: 0, unavailable: 0, timedOut: 0 }
  await open()
  const panel = page.locator('[data-component="workbench-panel"]')
  for (const [command, tab] of [
    ["Show output", "output"],
    ["Show debug console", "debug"],
    ["Show run (program terminal)", "run"],
    ["Show activity", "activity"],
    ["Show tools", "tools"],
    ["Show agents", "agents"],
    ["Show problems", "problems"],
  ] as const) {
    await palette(page, command)
    await expect(panel).toHaveAttribute("data-tab", tab)
  }

  // Run checks starts them for the whole project and shows Output.
  await palette(page, "Run checks")
  await expect.poll(() => mock.checks).toEqual([{ unit: directory }])
  await expect(panel).toHaveAttribute("data-tab", "output")
  // UX #15: the counts that are not zero; the project's own unit by its folder name
  await expect(panel.locator('[data-slot="report"]')).toHaveText("Last check: 2 passed, 1 failed")
  await expect(panel.locator('section[data-run="run_1"]')).toContainText(directory.split("/").pop()!)
  await expect(panel.locator('section[data-run="run_1"]')).not.toContainText(directory)

  // New tool opens the Tools tab on the form; New agent opens the agent dialog.
  await palette(page, "New tool")
  await expect(page.locator('[data-component="workbench-tool-new"]')).toBeVisible()
  await palette(page, "New agent")
  await expect(page.locator('[data-component="agenthq-dialog"]')).toBeVisible()
  await page.keyboard.press("Escape")
  // New task needs an agent first, so the palette does not offer it.
  await openPalette(page)
  await page.getByPlaceholder("Search files, commands, and sessions").fill("New task")
  await expect(page.getByRole("option", { name: /New task/ })).toHaveCount(0)
  await page.keyboard.press("Escape")
})

test("the one-time card points at the strip and the panel; dismissed, it stays gone", async ({ page }) => {
  const { open } = await mockWorkbench(page, { directory, title, intro: true })
  await open()
  const card = page.locator('[data-component="workbench-intro"]')
  await expect(card).toContainText("Your IDE")
  await expect(card).toContainText("Problems, agents, the debugger and checks live in the strip")
  await page.screenshot({ path: test.info().outputPath("intro-card.png") })
  await card.getByRole("button", { name: "Open the panel" }).click()
  await expect(page.locator('[data-component="workbench-tabs"]')).toBeVisible()
  await card.getByRole("button", { name: "Dismiss" }).click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-component="workbench-status"]')).toBeVisible()
  await expect(card).toHaveCount(0)
})

test("an agent's ask and a task ready for review raise OS notifications that open them", async ({ page }) => {
  // The browser's Notification, recorded, with the window out of focus (notify only fires when it is).
  await page.addInitScript(() => {
    const sent: { title: string; body: string }[] = []
    const scope = window as unknown as Record<string, unknown>
    scope.__notifications = sent
    scope.Notification = class {
      static permission = "granted"
      static requestPermission = async () => "granted"
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        sent.push({ title, body: options?.body ?? "" })
        scope.__lastNotification = this
      }
      close() {}
    }
    document.hasFocus = () => false
  })
  const { mock, open } = await mockWorkbench(page, { directory, title })
  mock.agents = [{ ...ada, projectDirectory: directory }]
  const session = {
    id: "ags_1",
    agentID: "agt_ada",
    provider: "opencode",
    title: "Notes",
    status: "working",
    pendingPermissions: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  mock.agentSessions = [session]
  const task = {
    id: "tsk_1",
    title: "Write the notes",
    assignee: "agt_ada",
    dependsOn: [],
    status: "running",
    isolated: false,
    createdAt: 1,
    updatedAt: 1,
  }
  mock.tasks = [task]
  await open()
  const sent = () => page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications)
  const strip = page.locator('[data-component="workbench-status"]')
  await expect(strip.locator('[data-status="agents"]')).toHaveText("Agents")

  // The agent asks: a notification, and the strip counts it.
  mock.emit(
    {
      type: "agenthq.session.event",
      properties: {
        envelope: {
          sessionID: "ags_1",
          seq: 0,
          at: 2,
          event: {
            type: "permission.requested",
            requestID: "perm_1",
            title: "Edit notes.txt",
            options: [{ id: "once", label: "Allow once", kind: "allow_once" }],
          },
        },
      },
    },
    {
      type: "agenthq.session.updated",
      properties: { session: { ...session, status: "needs_approval", pendingPermissions: 1, updatedAt: 2 } },
    },
  )
  await expect.poll(sent).toEqual([{ title: "Permission required", body: "Ada asks: Edit notes.txt" }])
  await expect(strip.locator('[data-status="agents"]')).toHaveText("Agents1 needs you")
  // Clicking it opens the agent's session in the Agents tab.
  await page.evaluate(() =>
    (window as unknown as { __lastNotification: { onclick: () => void } }).__lastNotification.onclick(),
  )
  await expect(page.locator('[data-component="workbench-panel"]')).toHaveAttribute("data-tab", "agents")
  await expect(page.locator('[data-component="agenthq-workspace"] [data-session="ags_1"]')).toHaveAttribute(
    "aria-current",
    "true",
  )

  // The task reaches review: one notification, not one per later update.
  mock.emit({ type: "agenthq.task.updated", properties: { task: { ...task, status: "review", updatedAt: 3 } } })
  mock.emit({ type: "agenthq.task.updated", properties: { task: { ...task, status: "review", updatedAt: 4 } } })
  await expect.poll(sent).toHaveLength(2)
  expect((await sent())[1]).toEqual({
    title: "Ready for review",
    body: "Write the notes by Ada is waiting for your review",
  })
  await page.waitForTimeout(500)
  expect(await sent()).toHaveLength(2)
})

test("IDE setup: the doctor's languages × tools grid, with fix commands to copy and Recheck", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = []
    ;(window as unknown as { __copied: string[] }).__copied = copied
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    })
  })
  const { mock, open } = await mockWorkbench(page, { directory, title })
  let requests = 0
  mock.doctor = {
    languages: [
      {
        id: "python",
        name: "Python",
        lsp: { server: "pyright", enabled: false, reason: 'LSP is off; set "lsp": true in opencode.json' },
        probes: [
          { area: "runtime", tool: "python3", status: "ok", version: "Python 3.13.1" },
          { area: "lsp", tool: "pyright", status: "missing" },
          { area: "check", tool: "ruff", status: "ok", version: "ruff 0.6.2" },
          { area: "test", tool: "pytest", status: "broken", reason: "pytest is not installed for /usr/bin/python3" },
          { area: "debug", tool: "debugpy", status: "ok", version: "1.8.11" },
        ],
      },
      {
        id: "swift",
        name: "Swift",
        lsp: { server: "sourcekit-lsp", enabled: false },
        probes: [
          {
            area: "debug",
            tool: "lldb-dap",
            status: "blocked",
            reason:
              "Developer Mode is off: launching under lldb asks for an admin password (sudo DevToolsSecurity -enable)",
          },
        ],
      },
    ],
  }
  await page.route(`**/workbench/doctor*`, async (route) => {
    requests++
    await route.fallback()
  })
  await open()
  await page.locator('[data-status="problems"]').click()
  await page.locator('[data-component="workbench-problems"] [data-action="open-setup"]').click()
  const setup = page.locator('[data-component="workbench-setup"]')
  await expect(setup.locator('tr[data-language="python"]')).toBeVisible()
  const python = setup.locator('tr[data-language="python"]')
  await expect(python.locator('td[data-area="check"]')).toHaveText(/^✓\s*Ready:\s*ruff 0\.6\.2$/)
  await expect(python.locator('td[data-area="lsp"]')).toContainText("pyright: language servers are off")
  await expect(python.locator('td[data-area="lsp"] [data-probe="pyright"]')).toContainText("npm install -g pyright")
  await expect(python.locator('td[data-area="test"]')).toContainText(
    "Does not run: pytest is not installed for /usr/bin/python3",
  )
  const swift = setup.locator('tr[data-language="swift"] td[data-area="debug"]')
  await expect(swift).toContainText("Blocked: Developer Mode is off")
  await swift.locator('[data-action="setup-copy"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))
    .toEqual(["sudo DevToolsSecurity -enable"])
  await page.screenshot({ path: test.info().outputPath("ide-setup.png") })
  const before = requests
  await page.locator('[data-action="setup-recheck"]').click()
  await expect.poll(() => requests).toBe(before + 1)
})

test("the palette's Fix sends the open file's problems through the agent picker", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory, title })
  mock.agents = [{ ...ada, projectDirectory: directory }]
  mock.files["src/app.ts"] = "const a = 1\nconst b: number = 'x'\n"
  mock.snapshot = problemsSnapshot([problem("p1", "error")])
  await open()
  // No file open: nothing to fix.
  await palette(page, "Fix problems in the open file with an agent")
  await expect(page.getByText("The open file has no problems", { exact: true })).toBeVisible()
  // Open src/app.ts from its problem, then Fix from the palette.
  await page.locator('[data-status="problems"]').click()
  await page.locator('[data-component="workbench-problems"] [data-problem="p1"]').click()
  await expect(page.locator("#review-panel").getByRole("tab", { name: "app.ts" })).toBeVisible()
  await palette(page, "Fix problems in the open file with an agent")
  const picker = page.locator("[data-handoff-dialog]")
  await expect(picker.locator("[data-target]")).toHaveText(["This session", "Ada"])
  await picker.locator('[data-target="agent:agt_ada"]').click()
  await expect.poll(() => mock.messages.length).toBe(1)
  expect((mock.messages[0] as { text: string }).text).toContain("Message: message p1")
})

async function palette(page: Page, command: string) {
  await openPalette(page)
  await page.getByPlaceholder("Search files, commands, and sessions").fill(command)
  await page
    .getByRole("option", { name: new RegExp(`^${command.replace(/[()]/g, "\\$&")}`) })
    .first()
    .click()
}

// ctrl+k once the page listens for it.
async function openPalette(page: Page) {
  const input = page.getByPlaceholder("Search files, commands, and sessions")
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("Control+k")
    await expect(input).toBeVisible({ timeout: 1000 })
  }).toPass()
}

function problem(id: string, severity: string) {
  return {
    id,
    file: `${directory}/src/app.ts`,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
    severity,
    message: `message ${id}`,
    source: { kind: "typecheck", tool: "tsc", producer: "check:tsc" },
    observedAt: 1,
    stale: false,
  }
}
