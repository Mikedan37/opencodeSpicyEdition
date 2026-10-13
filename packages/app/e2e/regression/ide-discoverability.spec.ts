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

test("the palette has every IDE tab and the IDE's actions", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory, title })
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
