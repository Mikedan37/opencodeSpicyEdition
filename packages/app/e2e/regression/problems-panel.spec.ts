import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// The Problems tab against mocked workbench routes: merged sources (DIAG-01), a crashed language server's stale
// problems (DIAG-07) and language servers turned off (DIAG-12).
const directory = "/work/problems"
const projectID = "proj_problems"
const sessionID = "ses_problems"
const title = "Problems host"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

const lsp = { kind: "lsp", tool: "typescript", producer: `lsp:typescript:${directory}` }
const tsc = { kind: "typecheck", tool: "tsc", producer: `check:tsc:${directory}/tsconfig.json` }

test.use({ viewport: { width: 1440, height: 900 } })

test("DIAG-01 a merged problem lists all its sources and the kind filter matches any of them", async ({ page }) => {
  const mock = await setup(page)
  mock.snapshot = snapshot([
    problem("p_merged", 3, "Type 'string' is not assignable to type 'number'.", [
      tsc,
      { ...lsp, channel: "push" },
      { ...lsp, channel: "pull" },
    ]),
    problem("p_tsc", 9, "Cannot find name 'foo'.", [tsc]),
  ])
  const panel = await openProblems(page)
  const merged = panel.locator('[data-problem="p_merged"] [data-slot="problem-sources"]')
  await expect(merged).toHaveText("tsc · LSP (push, pull)")
  await expect(merged).toHaveAttribute("title", "tsc: typecheck\ntypescript: lsp (push)\ntypescript: lsp (pull)")
  await expect(panel.locator('[data-problem="p_tsc"] [data-slot="problem-sources"]')).toHaveText("tsc")
  await page.screenshot({ path: test.info().outputPath("diag01-sources.png") })

  // Its first source is tsc, yet the language-server filter keeps it: the filter looks at every source.
  await panel.getByRole("combobox", { name: "Source" }).selectOption("lsp")
  await expect(panel.locator('[data-row="problem"]')).toHaveCount(1)
  await expect(panel.locator('[data-problem="p_merged"]')).toBeVisible()
  await panel.getByRole("combobox", { name: "Source" }).selectOption("typecheck")
  await expect(panel.locator('[data-row="problem"]')).toHaveCount(2)
})

test("DIAG-07 a crashed language server's stale problems say why in the stale badge", async ({ page }) => {
  const mock = await setup(page)
  mock.snapshot = snapshot(
    [
      { ...problem("p_crashed", 3, "Type 'string' is not assignable to type 'number'.", [lsp]), stale: true },
      { ...problem("p_edited", 9, "Cannot find name 'foo'.", [tsc]), stale: true },
    ],
    [
      {
        producer: lsp.producer,
        kind: "lsp",
        tool: "typescript",
        state: "failed",
        reason: "exit code 139",
        updatedAt: 2,
      },
    ],
  )
  const panel = await openProblems(page)
  await expect(panel.locator('[data-problem="p_crashed"] [data-slot="problem-stale"]')).toHaveAttribute(
    "title",
    "Language server crashed: exit code 139; showing its last results",
  )
  await expect(panel.locator('[data-problem="p_edited"] [data-slot="problem-stale"]')).toHaveAttribute(
    "title",
    "The file changed after this problem was reported",
  )
})

test("DIAG-12 language servers off: a banner over the list, and the empty state says so", async ({ page }) => {
  const mock = await setup(page)
  mock.snapshot = { ...snapshot([problem("p_tsc", 9, "Cannot find name 'foo'.", [tsc])]), lsp: "off" }
  const panel = await openProblems(page)
  const off = 'Language servers are off: set "lsp": true in your opencode config.'
  await expect(panel.locator('[data-slot="problems-lsp-off"]')).toHaveText(off)
  await page.screenshot({ path: test.info().outputPath("diag12-banner.png") })

  // No problems: the empty state carries the same line, and no banner.
  mock.snapshot = { ...snapshot([]), lsp: "off" }
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: snapshot([]).counts } })
  await expect(panel).toContainText("No problems detected")
  await expect(panel).toContainText(off)
  await expect(panel.locator('[data-slot="problems-lsp-off"]')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("diag12-empty.png") })

  // Language servers on: neither.
  mock.snapshot = { ...snapshot([]), lsp: "on" }
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: snapshot([]).counts } })
  await expect(panel).not.toContainText(off)
})

function problem(id: string, line: number, message: string, sources: Record<string, unknown>[]) {
  return {
    id,
    file: `${directory}/src/app.ts`,
    range: { start: { line: line - 1, character: 4 }, end: { line: line - 1, character: 9 } },
    severity: "error",
    message,
    source: sources[0],
    sources,
    observedAt: 1_700_000_000_000,
    stale: false,
  }
}

function snapshot(problems: Record<string, unknown>[], producers: Record<string, unknown>[] = []) {
  return {
    problems,
    counts: { error: problems.length, warning: 0, info: 0, hint: 0 },
    producers,
  } as Record<string, unknown>
}

async function openProblems(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="problems"]').click()
  return page.locator('[data-component="workbench-problems"]')
}

async function setup(page: Page) {
  const pending: { directory: string; payload: unknown }[] = []
  const mock = {
    // GET /workbench/problems
    snapshot: snapshot([]),
    emit(...items: Record<string, unknown>[]) {
      pending.push(...items.map((item) => ({ directory, payload: { id: `evt_${Math.random()}`, ...item } })))
    },
  }
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "problems",
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
    fileList: () => [],
  })
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })
  await page.route(`${server}/workbench/**`, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/workbench/problems") return json(route, mock.snapshot)
    return json(route, { message: url.pathname }, 404)
  })
  const ptyID = "pty_problems"
  const location = { directory, project: { id: projectID, directory } }
  const pty = { id: ptyID, title: "Terminal 1", command: "zsh", args: [], cwd: directory, status: "running", pid: 1 }
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
