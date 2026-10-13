import { expect, test, type Page } from "@playwright/test"
import { ada, mockWorkbench } from "../utils/workbench-mock"

// UX audit #7: the bottom panel is Terminal · Problems · Checks · Debug · Agents. Debug has Console | Program, Agents
// has Agents | Tasks | Activity | Tools; what does not fit goes to a "»" menu. Old tab ids still find their places.
const directory = "/work/regroup"
const title = "Regrouped tabs"

const surfaces = (page: Page) => page.locator('[data-component="workbench-tabs"] [data-surface]')
const panel = (page: Page) => page.locator('[data-component="workbench-panel"]')

test("800×900: the tabs that do not fit are in », nothing is clipped, and the open one stays in the bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 })
  const { open } = await mockWorkbench(page, { directory, title })
  await open()
  await page.keyboard.press("Control+Backquote")
  const list = page.locator('#terminal-panel [data-slot="tabs-list"]')
  const more = page.locator('[data-action="workbench-tabs-more"]')
  await expect(more).toBeVisible()
  await expect.poll(() => surfaces(page).count()).toBeLessThan(4)
  const visible = await surfaces(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-surface")))
  expect(visible[0]).toBe("problems")

  // Every trigger, the » button and the terminal tab sit inside the bar, side by side
  const bar = (await list.boundingBox())!
  const group = (await page.locator('[data-component="workbench-tabs"]').boundingBox())!
  for (const box of [
    ...(await Promise.all((await surfaces(page).all()).map((item) => item.boundingBox()))),
    await more.boundingBox(),
  ]) {
    expect(box!.x).toBeGreaterThanOrEqual(bar.x - 0.5)
    expect(box!.x + box!.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5)
  }
  const terminalTab = (await page.locator('#terminal-panel [data-slot="tabs-trigger-wrapper"]').first().boundingBox())!
  expect(terminalTab.x + terminalTab.width).toBeLessThanOrEqual(group.x + 0.5)
  // The bar does not overflow: the terminal's tab and its "+" are not under the IDE's tabs
  const overflow = () => list.evaluate((node) => node.scrollWidth - node.clientWidth)
  await expect.poll(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: test.info().outputPath("ux7-overflow-800.png") })

  // The menu holds the rest; picking one opens it and brings it into the bar
  await page.locator('[data-workbench-tab="problems"]').click()
  await more.click()
  const menu = page.locator("[data-tabs-menu]")
  const labels = { problems: "Problems", checks: "Checks", debug: "Debug", agents: "Agents" }
  // The bar re-fits once the terminal's own tab renders, so compare the menu with the bar as it is now
  const hidden = async () => {
    const shown = await surfaces(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-surface")))
    return (Object.keys(labels) as (keyof typeof labels)[]).filter((id) => !shown.includes(id)).map((id) => labels[id])
  }
  await expect
    .poll(async () => (await menu.locator("[data-surface]").allTextContents()).join() === (await hidden()).join())
    .toBe(true)
  await expect(menu.locator("[data-surface]")).toHaveText(await hidden())
  await menu.locator('[data-surface="agents"]').click()
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveAttribute("aria-selected", "true")
  await expect(panel(page)).toHaveAttribute("data-surface", "agents")
  await expect(more).toBeVisible()
  await expect.poll(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: test.info().outputPath("ux7-overflow-800-agents.png") })

  // Wide enough: all four, no menu
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(surfaces(page)).toHaveText(["Problems", "Checks", "Debug", "Agents"])
  await expect(more).toHaveCount(0)
})

test("Agents: each view says what waits for you, and the Agents tab adds them up", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory, title })
  mock.agents = [{ ...ada, projectDirectory: directory }]
  mock.agentSessions = [
    {
      id: "ags_ask",
      agentID: "agt_ada",
      provider: "opencode",
      title: "Fix the parser",
      status: "needs_approval",
      pendingPermissions: 1,
      createdAt: 1,
      updatedAt: 2,
    },
  ]
  mock.tasks = [
    {
      id: "tsk_1",
      title: "Write the note",
      assignee: "agt_ada",
      dependsOn: [],
      status: "review",
      isolated: true,
      createdAt: 1,
      updatedAt: 2,
    },
  ]
  mock.investigations = [
    { id: "inv_1", title: "Parser crash", status: "needs_human", attempts: 1, evidenceCount: 0, updatedAt: 1 },
  ]
  mock.tools = [
    {
      name: "greet",
      id: "custom_greet",
      description: "Says hello",
      args: [],
      status: "draft",
      path: `${directory}/.opencode/tool/greet.ts`,
      source: "export default {}",
      hash: "h1",
      createdBy: { by: "agent", agent: "Ada" },
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  await open()
  await page.keyboard.press("Control+Backquote")
  // An agent asking, a task in review, an investigation waiting for a human, a drafted tool
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveText("Agents4")
  await expect(page.locator('[data-component="workbench-status"] [data-status="agents"]')).toContainText("4 need you")
  await page.locator('[data-workbench-tab="agents"]').click()
  const view = (id: string) => page.locator(`[data-agenthq-view="${id}"]`)
  // One number per view: what waits (amber) when anything does
  await expect(view("agents")).toHaveText("Agents1")
  await expect(view("tasks")).toHaveText("Tasks1")
  await expect(page.locator('[data-agenthq-view] [data-slot="view-waiting"]')).toHaveCount(4)
  // Activity and Tools keep their old tab ids
  await expect(page.locator('[data-workbench-tab="activity"]')).toHaveText("Activity1")
  await expect(page.locator('[data-workbench-tab="tools"]')).toHaveText("Tools1")
  await page.screenshot({ path: test.info().outputPath("ux7-agents-views.png") })

  // Views switch in place; the panel answers to the old ids
  await page.locator('[data-workbench-tab="activity"]').click()
  await expect(page.locator('[data-workbench-tab="activity"]')).toHaveAttribute("aria-selected", "true")
  await expect(panel(page)).toHaveAttribute("data-tab", "activity")
  await expect(page.locator('[data-component="workbench-activity"]')).toBeVisible()
  await page.locator('[data-workbench-tab="tools"]').click()
  await expect(panel(page)).toHaveAttribute("data-tab", "tools")
  await expect(page.locator('[data-component="workbench-tools"]')).toBeVisible()
  await view("tasks").click()
  await expect(page.locator('[data-component="agenthq-tasks"]')).toBeVisible()
  await expect(page.locator('[data-action="task-new"]')).toBeVisible()

  // Expand shows the whole Agents tab full height, views included
  await page.locator('[data-action="agenthq-expand"]').click()
  const expanded = page.locator('[data-component="agenthq-expanded"]')
  await expect(expanded.locator('[data-agenthq-view="tasks"]')).toHaveAttribute("aria-selected", "true")
  await expanded.locator('[data-workbench-tab="activity"]').click()
  await expect(expanded.locator('[data-component="workbench-activity"]')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("ux7-agents-expanded.png") })
  await page.keyboard.press("Escape")
  await expect(expanded).toHaveCount(0)
  await expect(page.locator('[data-component="workbench-activity"]')).toBeVisible()
})

test("Debug: Console | Program, Program once a session runs in a terminal", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory, title })
  const session = (patch: Record<string, unknown> = {}) => ({
    id: "dbg_one",
    adapter: "debugpy",
    program: `${directory}/app.py`,
    state: "running",
    owner: "human",
    capabilities: [],
    startedAt: 1_700_000_000_000,
    ...patch,
  })
  mock.debugSessions = [session()]
  await open()
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="debug"]').click()
  await expect(panel(page)).toHaveAttribute("data-tab", "debug")
  await expect(page.locator('[data-component="workbench-debug-console"]')).toBeVisible()
  // debugpy's internal console: no terminal, no switch
  await expect(page.locator("[data-debug-view]")).toHaveCount(0)

  // A program that ran in a terminal brings Program (the old Run tab's id)
  mock.emit({
    type: "workbench.debug.updated",
    properties: { session: session({ id: "dbg_two", state: "terminated", ptyID: "pty_program", startedAt: 1 }) },
  })
  const program = page.locator('[data-debug-view="program"]')
  await expect(program).toHaveAttribute("data-workbench-tab", "run")
  await page.screenshot({ path: test.info().outputPath("ux7-debug-switch.png") })
  await program.click()
  await expect(program).toHaveAttribute("aria-selected", "true")
  await expect(panel(page)).toHaveAttribute("data-tab", "run")
  // The selected session has no terminal: Program points back to the console
  const run = page.locator('[data-component="workbench-run"]')
  await expect(run).toContainText("This program writes to the console")
  await run.getByRole("button", { name: "Show console" }).click()
  await expect(page.locator('[data-debug-view="console"]')).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-workbench-tab="debug"]')).toHaveAttribute("aria-selected", "true")
})

test("a panel saved before the regroup opens where its tab went; the last view is kept per workspace", async ({
  page,
}) => {
  const { open } = await mockWorkbench(page, { directory, title })
  await open()
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="agents"]').click()
  // Nothing waits: each view shows how many there are, muted
  await expect(page.locator('[data-agenthq-view="agents"]')).toHaveText("Agents0")
  await expect(page.locator('[data-agenthq-view] [data-slot="view-count"]')).toHaveCount(4)
  await page.locator('[data-workbench-tab="tools"]').click()
  // The panel's saved state, as the app wrote it
  const saved = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((item) => item.endsWith("workbench-panel"))
      return key ? { key, value: JSON.parse(localStorage.getItem(key)!) } : undefined
    })
  await expect.poll(async () => (await saved())?.value).toEqual({ tab: "agents", debug: "console", agents: "tools" })

  // The last Agents view comes back with the tab
  await page.locator('[data-workbench-tab="problems"]').click()
  await page.locator('[data-workbench-tab="agents"]').click()
  await expect(page.locator('[data-workbench-tab="tools"]')).toHaveAttribute("aria-selected", "true")

  // Saved before the regroup, when Run was a tab of its own
  const { key } = (await saved())!
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ tab: "run" })), key)
  await page.reload()
  await expect(panel(page)).toHaveAttribute("data-surface", "debug")
  await expect(panel(page)).toHaveAttribute("data-tab", "run")
  await expect(page.locator('[data-debug-view="program"]')).toHaveAttribute("aria-selected", "true")
})
