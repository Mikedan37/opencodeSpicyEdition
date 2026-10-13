import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { repo } from "../utils/opencode-server"
import { expectSessionTitle } from "../utils/waits"

// CON-11: swift build's real output (the problems agent's capture, colors included) through the Output tab: the ANSI
// colors render and the file:line:col references open the file at the line.
const directory = "/work/swiftpm"
const projectID = "proj_swiftpm"
const sessionID = "ses_swiftpm"
const title = "Swift build output"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const ptyID = "pty_swiftpm"
const SOURCE = 'let count: Int = "one"\nprint(count)\n'

test.use({ viewport: { width: 1440, height: 900 } })

test("swift build output renders its colors and opens its file references", async ({ page }) => {
  const golden = JSON.parse(
    await fs.readFile(
      path.join(repo, "packages/opencode/test/fixture/workbench/golden/swift-build-color.json"),
      "utf8",
    ),
  ) as { stdout: string; stderr: string; exitCode: number }
  // The capture was made in /ROOT/swiftpm; here the project is /work/swiftpm.
  const output = (golden.stdout + golden.stderr).replaceAll("/ROOT/swiftpm", directory).replaceAll("/ROOT", "/work")
  expect(golden.stderr).toContain("\u001b[1;31merror: ")
  const mock = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="output"]').click()
  const panel = page.locator('[data-component="workbench-output"]')

  mock.emit({ type: "workbench.run.updated", properties: { run: runInfo("running") } })
  mock.emit(
    ...output
      .match(/[\s\S]{1,2000}/g)!
      .map((chunk, seq) => ({ type: "workbench.run.output", properties: { runID: "run_swift", seq, chunk } })),
    {
      type: "workbench.run.updated",
      properties: { run: runInfo("failed", { exitCode: golden.exitCode, finishedAt: 1_700_000_002_000 }) },
    },
  )
  const run = panel.locator('section[data-run="run_swift"]')
  await expect(run).toHaveAttribute("data-status", "failed")
  await expect(run).toContainText("cannot convert value of type 'String' to specified type 'Int'")

  // Colors: the bold red "error:" and the cyan line-number gutter of the excerpt; no escape codes left as text.
  const error = run.locator('span[style*="--ansi-red"]', { hasText: "error:" }).first()
  await expect(error).toBeVisible()
  expect(await error.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600")
  await expect(run.locator('span[style*="--ansi-cyan"]', { hasText: "1 |" }).first()).toBeVisible()
  expect(await run.locator('[role="region"]').innerText()).not.toContain("\u001b[")

  // file:line:col references are links that open the file at the line.
  const link = run.locator('[role="region"] button', { hasText: `${directory}/Sources/app/main.swift:1:18` }).first()
  await expect(link).toBeVisible()
  await link.click()
  const side = page.locator("#review-panel")
  await expect(side.getByRole("tab", { name: "main.swift" })).toHaveAttribute("data-selected", "")
  await expect(side).toContainText('let count: Int = "one"')
  await page.screenshot({ path: test.info().outputPath("output-swift.png") })
})

function runInfo(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "run_swift",
    kind: "check",
    unit: directory,
    checker: "swift",
    command: ["swift", "build"],
    execClass: "exec",
    status,
    startedAt: 1_700_000_000_000,
    ...extra,
  }
}

async function setup(page: Page) {
  const pending: { directory: string; payload: unknown }[] = []
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "swiftpm",
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
    fileContent: (file) => ({ type: "text", content: file === "Sources/app/main.swift" ? SOURCE : "" }),
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
    if (url.pathname === "/workbench/runs") return json(route, [])
    if (url.pathname === "/workbench/file" && url.searchParams.get("path") === "Sources/app/main.swift")
      return json(route, { content: SOURCE, hash: "h" })
    return json(route, { message: url.pathname }, 404)
  })
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
  return {
    emit(...items: Record<string, unknown>[]) {
      pending.push(...items.map((item) => ({ directory, payload: { id: `evt_${Math.random()}`, ...item } })))
    },
  }
}
