import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Spicy Workbench debugger: the side panel's Debug tab, driven by the debug routes and injected workbench.debug.* events.
const directory = "/work/debugging"
const projectID = "proj_debugging"
const sessionID = "ses_debugging"
const title = "Debugging host"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const debugID = "dbg_one"
const source = [
  "import sys",
  "",
  "def main():",
  "    x = 1",
  "    items = list(range(53))",
  "    return helper(x)",
  "",
  "def helper(value):",
  "    return value * 2",
  "",
].join("\n")

test.use({ viewport: { width: 1440, height: 900 } })

test("debug side panel: start errors verbatim, stack, lazy variables, watches, ownership, breakpoints", async ({
  page,
}) => {
  const mock = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  // F5 with no session opens the start dialog; launch.json configurations are offered next to a program path
  await page.keyboard.press("F5")
  const dialog = page.locator('[data-component="debug-start-dialog"]')
  await expect(dialog).toBeVisible()
  const what = dialog.locator('select[name="configuration"]')
  await expect(what.locator("option")).toHaveText(["Program", "launch.json: Current file"])
  await what.selectOption("")
  await dialog.locator('input[name="program"]').fill("app.py")
  await dialog.locator('input[name="args"]').fill('--name "Ada L" 3')
  await dialog.getByText("Pause on the first line").click()

  // The server's refusal is shown as it words it, and the dialog stays open
  mock.startError = "Developer Mode off — run sudo DevToolsSecurity -enable"
  await dialog.getByRole("button", { name: "Start debugging" }).click()
  await expect(dialog.locator('[data-slot="debug-start-error"]')).toHaveText(
    "Developer Mode off — run sudo DevToolsSecurity -enable",
  )
  mock.startError = undefined
  await dialog.getByRole("button", { name: "Start debugging" }).click()
  await expect(dialog).toBeHidden()
  expect(mock.starts.at(-1)).toEqual({ program: "app.py", args: ["--name", "Ada L", "3"], stopOnEntry: true })

  // A stop the human drives opens its file; the Debug tab shows the stack and the top frame's locals
  mock.emit(updated({ state: "stopped", stop: stopAt(1) }))
  const panel = page.locator("#review-panel")
  await expect(panel.getByRole("tab", { name: "app.py" })).toHaveAttribute("data-selected", "")
  await panel.locator('[data-workbench-side-tab="debug"]').click()
  const debug = panel.locator('[data-component="workbench-debug"]')
  await expect(debug).toBeVisible()
  await expect(debug.locator('[data-slot="debug-status"]')).toHaveText("Paused: breakpoint")
  await expect(debug.locator("[data-frame]")).toHaveCount(2)
  await expect(debug.locator('[data-frame="1"] [data-slot="frame"]')).toHaveAttribute("aria-current", "true")
  await expect(debug.locator('[data-frame="1"] [data-slot="frame"]')).toContainText("main")
  await expect(debug.locator('[data-variable="x"]')).toContainText("x=1")

  // Children load lazily, 50 at a time
  await debug.locator('[data-variable="items"] > button').click()
  await expect(debug.locator('[data-variable="items"] [role="group"] [role="treeitem"]')).toHaveCount(50)
  await debug.getByRole("button", { name: "Load more" }).click()
  await expect(debug.locator('[data-variable="items"] [role="group"] [role="treeitem"]')).toHaveCount(53)
  await expect(debug.getByRole("button", { name: "Load more" })).toHaveCount(0)
  expect(mock.variables).toEqual(["11:0", "11:50"])

  // Watches evaluate in the selected frame on each stop while the human drives
  await debug.getByPlaceholder("Add expression").fill("x + 1")
  await debug.getByPlaceholder("Add expression").press("Enter")
  await expect(debug.locator('[data-watch="x + 1"]')).toContainText("x + 1=2")
  await debug.locator('[data-frame="2"] [data-slot="frame"]').click()
  await expect.poll(() => mock.evaluations.at(-1)).toEqual({ expression: "x + 1", frameID: 2 })
  await expect(debug.locator('[data-debug-section="variables"]')).toContainText(
    "Variables are listed for the top frame",
  )

  // Stepping posts the command; the next stop resets the frame to the top one
  await debug.locator('[data-debug-action="next"]').click()
  await expect.poll(() => mock.controls).toEqual(["next"])
  mock.emit(updated({ state: "stopped", stop: stopAt(2) }))
  await expect(debug.locator('[data-frame="1"] [data-slot="frame"]')).toHaveAttribute("aria-current", "true")

  // The agent drives: controls are disabled with a reason; Take over posts owner = human
  mock.emit(updated({ state: "stopped", owner: "agent", stop: stopAt(2) }))
  await expect(debug.locator('[data-slot="debug-owner"]')).toHaveAttribute("data-owner", "agent")
  await expect(debug.locator('[data-debug-action="next"]')).toBeDisabled()
  await expect(debug.locator('[data-debug-action="next"]')).toHaveAttribute("title", /take over to drive it/)
  await expect(debug.locator('[data-debug-action="stop"]')).toBeEnabled()
  await debug.locator('[data-action="debug-take-over"]').click()
  await expect.poll(() => mock.owners).toEqual(["human"])
  await expect(debug.locator('[data-slot="debug-owner"]')).toHaveAttribute("data-owner", "human")

  // F9 toggles a breakpoint on the selected line of the open file and syncs it as an absolute path
  await expect(debug.locator('[data-debug-section="breakpoints"]')).toContainText("No breakpoints")
  await page.keyboard.press("F9")
  await expect.poll(() => mock.breakpoints.at(-1)).toEqual({ file: `${directory}/app.py`, breakpoints: [{ line: 4 }] })
  const row = debug.locator(`[data-breakpoint="app.py:4"]`)
  await expect(row).toContainText("line 4")
  await expect(row).toContainText("not verified")

  // Conditions are offered per capability; log points are not supported by this session
  await row.hover()
  await row.getByRole("button", { name: "Edit breakpoint on line 4" }).click()
  await expect(row.getByPlaceholder("debugpy does not support this")).toBeDisabled()
  await row.getByPlaceholder("x > 3").fill("x > 0")
  await row.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => mock.breakpoints.at(-1))
    .toEqual({
      file: `${directory}/app.py`,
      breakpoints: [{ line: 4, condition: "x > 0" }],
    })
  await expect(row).toContainText("when x > 0")

  // Exception filters start from the server default and post the new set
  await expect(debug.locator('[data-exception-filter="uncaught"]')).toBeChecked()
  await debug.locator('[data-exception-filter="raised"]').check()
  await expect.poll(() => mock.breakpoints.at(-1)).toEqual({ exceptions: ["uncaught", "raised"] })

  // Any other tab hides the Debug tab
  await panel.getByRole("tab", { name: "app.py" }).click()
  await expect(debug).toBeHidden()
  await expect(panel.locator('[data-workbench-side-tab="debug"]')).toBeVisible()
})

function session(patch: Record<string, unknown> = {}) {
  return {
    id: debugID,
    adapter: "debugpy",
    program: `${directory}/app.py`,
    state: "running",
    owner: "human",
    capabilities: ["supportsConditionalBreakpoints", "supportsHitConditionalBreakpoints", "supportsCompletionsRequest"],
    startedAt: 1_700_000_000_000,
    ...patch,
  }
}

function updated(patch: Record<string, unknown>) {
  return { type: "workbench.debug.updated", properties: { session: session(patch) } }
}

function stopAt(at: number) {
  return {
    reason: "breakpoint",
    threadID: 1,
    frames: [
      { id: 1, name: "main", file: `${directory}/app.py`, line: 4 },
      { id: 2, name: "<module>", file: `${directory}/app.py`, line: 12 },
    ],
    locals: [
      { name: "x", type: "int", value: "1", variablesReference: 0 },
      { name: "items", type: "list", value: "[0, 1, 2, ...]", variablesReference: 11 },
    ],
    at,
  }
}

async function setup(page: Page) {
  const pending: { directory: string; payload: unknown }[] = []
  const mock = {
    startError: undefined as string | undefined,
    starts: [] as unknown[],
    controls: [] as string[],
    owners: [] as string[],
    variables: [] as string[],
    evaluations: [] as unknown[],
    breakpoints: [] as unknown[],
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
      name: "debugging",
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
    fileList: () => [],
    fileContent: (path) => {
      if (path === ".vscode/launch.json")
        return {
          type: "text",
          content:
            '{\n  // configurations\n  "configurations": [{ "name": "Current file", "type": "debugpy", "program": "${file}" },],\n}',
        }
      return { type: "text", content: path === "app.py" ? source : "" }
    },
    events: () => pending.splice(0),
  })

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })

  await page.route(`${server}/workbench/**`, (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const body = request.postDataJSON() as Record<string, unknown> | null
    if (path === "/workbench/debug/sessions" && request.method() === "GET") return json(route, [])
    if (path === "/workbench/debug/sessions" && request.method() === "POST") {
      if (mock.startError) return json(route, { message: mock.startError }, 503)
      mock.starts.push(body)
      return json(route, session())
    }
    const action = path.match(/^\/workbench\/debug\/sessions\/[^/]+\/(\w+)$/)?.[1]
    if (action === "control") {
      mock.controls.push(String(body?.action))
      return json(route, session())
    }
    if (action === "owner") {
      mock.owners.push(String(body?.owner))
      return json(route, session({ owner: body?.owner, state: "stopped", stop: stopAt(2) }))
    }
    if (action === "variables") {
      const start = Number(url.searchParams.get("start") ?? 0)
      mock.variables.push(`${url.searchParams.get("ref")}:${start}`)
      const count = start === 0 ? 50 : 3
      return json(
        route,
        Array.from({ length: count }, (_, index) => ({
          name: String(start + index),
          type: "int",
          value: String(start + index),
          variablesReference: 0,
        })),
      )
    }
    if (action === "evaluate") {
      mock.evaluations.push(body)
      return json(route, { seq: 90 + mock.evaluations.length, at: 1, kind: "result", by: "human", text: "2" })
    }
    if (action === "breakpoints") {
      mock.breakpoints.push(body)
      const lines = (body?.breakpoints as { line: number }[] | undefined) ?? []
      return json(route, {
        ...(body?.file ? { file: body.file } : {}),
        breakpoints: lines.map((item) => ({ line: item.line, verified: false, message: "not loaded yet" })),
        ...(body?.exceptions ? { exceptions: body.exceptions } : {}),
      })
    }
    if (action === "output") return json(route, [])
    return json(route, { message: path }, 404)
  })

  // Opening the bottom panel starts a terminal.
  const ptyID = "pty_debugging"
  const pty = { id: ptyID, title: "Terminal 1", command: "zsh", args: [], cwd: directory, status: "running", pid: 1 }
  const location = { directory, project: { id: projectID, directory } }
  await page.route("**/api/pty*", (route) => json(route, { location, data: pty }))
  await page.route(`**/api/pty/${ptyID}*`, (route) => json(route, { location, data: pty }))
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

  return mock
}
