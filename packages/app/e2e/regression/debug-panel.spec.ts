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
  'if __name__ == "__main__":',
  "    main()",
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

  // A stop the human drives opens its file; the Debug tab shows the stack and the top frame's scopes
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
  // Cheap scopes open by themselves; an expensive one waits for a click
  await expect(debug.locator('[data-frame-scopes="1"] [data-variable="x"]')).toContainText("x=1")
  await expect(debug.locator('[data-frame-scopes="1"] [data-variable="Globals"]')).toHaveAttribute(
    "aria-expanded",
    "false",
  )

  // Children load lazily, 50 at a time
  await debug.locator('[data-variable="items"] > button').click()
  await expect(debug.locator('[data-variable="items"] [role="group"] [role="treeitem"]')).toHaveCount(50)
  await debug.getByRole("button", { name: "Load more" }).click()
  await expect(debug.locator('[data-variable="items"] [role="group"] [role="treeitem"]')).toHaveCount(53)
  await expect(debug.getByRole("button", { name: "Load more" })).toHaveCount(0)
  expect(mock.variables).toEqual(["30:0", "11:0", "11:50"])
  expect(mock.scopes).toEqual([1])

  // Watches evaluate in the selected frame on each stop while the human drives
  await debug.getByPlaceholder("Add expression").fill("x + 1")
  await debug.getByPlaceholder("Add expression").press("Enter")
  await expect(debug.locator('[data-watch="x + 1"]')).toContainText("x + 1=2")
  // Another frame shows its own scopes; watches evaluate there as watches
  await debug.locator('[data-frame="2"] [data-slot="frame"]').click()
  await expect.poll(() => mock.evaluations.at(-1)).toEqual({ expression: "x + 1", frameID: 2, context: "watch" })
  const outer = debug.locator('[data-frame-scopes="2"]')
  await expect(outer.locator('[data-variable="count"]')).toContainText("count=6")
  await expect(outer.locator('[data-variable="label"]')).toContainText("label='orders'")
  await expect(outer.locator('[data-variable="x"]')).toHaveCount(0)
  await outer.locator('[data-variable="Globals"] > button').click()
  await expect(outer.locator('[data-variable="__name__"]')).toContainText("__name__='__main__'")
  expect(mock.scopes).toEqual([1, 2])
  expect(mock.variables.slice(3)).toEqual(["40:0", "41:0"])
  // Watch results stay out of the Debug Console (start opened it in the bottom panel)
  await expect(page.locator('[data-component="workbench-debug-console"]')).toBeVisible()
  await expect(page.locator('[data-component="workbench-debug-console"] [data-console-row]')).toHaveCount(0)

  // Stepping posts the command; the next stop keeps the Debug tab in front and resets the frame to the top one
  await debug.locator('[data-debug-action="next"]').click()
  await expect.poll(() => mock.controls).toEqual(["next"])
  mock.emit(updated({ state: "stopped", stop: stopAt(2) }))
  await expect(debug.locator('[data-frame="1"] [data-slot="frame"]')).toHaveAttribute("aria-current", "true")
  await expect(debug).toBeVisible()

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

test("debug console: backlog and live rows merge, filters, attribution, evaluate, completions, history", async ({
  page,
}) => {
  const mock = await setup(page)
  mock.sessions = [session({ state: "stopped", stop: stopAt(1) })]
  mock.backlog = [
    row(4, "system", "system", "… 4 earlier rows dropped (256 KB output cap)"),
    row(5, "stdout", "program", "hello from main"),
    row(6, "stderr", "program", "warning: careful"),
    row(7, "console", "adapter", "debugpy attached"),
    { ...row(8, "stop", "adapter", "paused on breakpoint"), location: { file: `${directory}/app.py`, line: 4 } },
  ]
  mock.evaluate = (body) =>
    body.expression === "items"
      ? { ...row(21, "result", "human", "[0, 1, 2]"), variablesReference: 77 }
      : row(23, "exception", "human", "NameError: name 'nope' is not defined")
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="debug"]').click()
  const panel = page.locator('[data-component="workbench-debug-console"]')

  // The backlog leads with the server's truncation row; a live row and a duplicate merge by seq
  mock.emit(output(row(8, "stop", "adapter", "paused on breakpoint"), row(9, "stdout", "program", "live line")))
  const rows = panel.locator("[data-console-row]")
  await expect(rows).toHaveText([
    /… 4 earlier rows dropped/,
    /programhello from main/,
    /warning: careful/,
    /debuggerdebugpy attached/,
    /paused on breakpointapp\.py:4/,
    /programlive line/,
  ])
  await expect(panel.locator('[data-console-row="6"] [data-slot="console-chip"]')).toHaveCount(0)

  // Filters hide streams
  await panel.locator('[data-console-filter="stderr"]').click()
  await expect(panel.locator('[data-console-row="6"]')).toHaveCount(0)
  await panel.locator('[data-console-filter="stderr"]').click()
  await expect(panel.locator('[data-console-row="6"]')).toBeVisible()

  // Completions come from the adapter for the text before the cursor; Tab inserts the highlighted one
  const input = panel.locator('[data-slot="debug-console-input"]')
  await input.fill("ite")
  await expect(panel.getByRole("option")).toHaveText([/items/, /iter/])
  expect(mock.completions.at(-1)).toBe("?text=ite&column=4&frameID=1&directory=%2Fwork%2Fdebugging")
  await input.press("ArrowDown")
  await input.press("ArrowUp")
  await input.press("Tab")
  await expect(input).toHaveValue("items")
  await expect(panel.getByRole("option")).toHaveCount(0)

  // Enter evaluates in the selected frame; the result row is attributed to you and expands lazily
  await input.press("Enter")
  await expect.poll(() => mock.evaluations.at(-1)).toEqual({ expression: "items", frameID: 1 })
  mock.emit(
    output(row(20, "eval", "human", "items"), { ...row(21, "result", "human", "[0, 1, 2]"), variablesReference: 77 }),
  )
  await expect(panel.locator('[data-console-row="20"]')).toHaveText("you› items")
  await expect(panel.locator('[data-console-row="21"]')).toContainText("[0, 1, 2]")
  await panel.locator('[data-console-row="21"] [role="treeitem"] > button').click()
  await expect(panel.locator('[data-console-row="21"] [role="group"] [role="treeitem"]')).toHaveCount(50)
  expect(mock.variables).toEqual(["77:0"])

  // A failing expression shows as an exception row; Up recalls earlier input
  await input.fill("nope")
  await input.press("Enter")
  await expect(panel.locator('[data-console-row="23"]')).toHaveAttribute("data-kind", "exception")
  await input.press("ArrowUp")
  await expect(input).toHaveValue("nope")
  await input.press("ArrowUp")
  await expect(input).toHaveValue("items")
  await input.press("ArrowDown")
  await input.press("ArrowDown")
  await expect(input).toHaveValue("")

  // Evaluation needs a paused program
  mock.emit(updated({ state: "running" }))
  await expect(input).toBeDisabled()
  await expect(input).toHaveAttribute("placeholder", "Pause the program to evaluate expressions")
})

test("run tab: the program's terminal stays after exit with its code; an internal console points to the console", async ({
  page,
}) => {
  const mock = await setup(page)
  const program = "pty_program"
  mock.sessions = [session({ ptyID: program })]
  const sockets: string[] = []
  await page.route(`**/api/pty/${program}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: { id: program, title: "app.py", command: "python3", args: [], cwd: directory, status: "running", pid: 2 },
      }),
    }),
  )
  await page.routeWebSocket(new RegExp(`/api/pty/${program}/connect`), (socket) => {
    sockets.push(socket.url())
    socket.send("hello from the program\r\n")
  })
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="run"]').click()
  const run = page.locator('[data-component="workbench-run"]')
  const terminal = run.locator(`[data-run-pty="${program}"] [data-component="terminal"]`)
  await expect(terminal).toBeVisible()
  await expect.poll(() => sockets.length).toBe(1)
  await expect(run.locator('[data-slot="run-status"]')).toHaveText("Running")

  mock.emit(
    { type: "pty.exited", properties: { id: program, exitCode: 3 } },
    updated({ state: "terminated", ptyID: program }),
  )
  await expect(run.locator('[data-slot="run-status"]')).toHaveText("Exited with code 3")
  await expect(terminal).toBeVisible()

  // Leaving the tab and coming back mounts the terminal again from its saved state
  await page.locator('[data-workbench-tab="debug"]').click()
  await expect(terminal).toHaveCount(0)
  await page.locator('[data-workbench-tab="run"]').click()
  await expect(terminal).toBeVisible()
  await expect.poll(() => sockets.length).toBe(2)
  await expect(run.locator('[data-slot="run-status"]')).toHaveText("Exited with code 3")

  // debugpy's default internal console has no terminal: the tab points to the Debug Console
  mock.emit(updated({ id: "dbg_two", startedAt: 1_700_000_000_500 }))
  await expect(run).toContainText("This program writes to the Debug Console")
  await run.getByRole("button", { name: "Show Debug Console" }).click()
  await expect(page.locator('[data-workbench-tab="debug"]')).toHaveAttribute("aria-selected", "true")
})

test("run tab after the program ended: replays the debugger's copy of its output, or says it is gone", async ({
  page,
}) => {
  const mock = await setup(page)
  const program = "pty_program"
  mock.sessions = [session({ ptyID: program })]
  const state = { exited: false, sockets: 0 }
  await page.route(`**/api/pty/${program}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: {
          id: program,
          title: "app.py",
          command: "python3",
          args: [],
          cwd: directory,
          status: state.exited ? "exited" : "running",
          pid: 2,
        },
      }),
    }),
  )
  // The /pty routes don't attach to an exited PTY: the server closes the socket with 4404
  await page.routeWebSocket(new RegExp(`/api/pty/${program}/connect`), (socket) => {
    state.sockets++
    if (state.exited) return socket.close({ code: 4404, reason: "session exited" })
    socket.send("loading orders\r\n")
  })
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="run"]').click()
  const run = page.locator('[data-component="workbench-run"]')
  const terminal = run.locator(`[data-run-pty="${program}"] [data-component="terminal"]`)
  await expect(terminal).toBeVisible()
  await expect.poll(() => state.sockets).toBe(1)

  // The program writes more and ends while another tab is in front
  await page.locator('[data-workbench-tab="debug"]').click()
  await expect(terminal).toHaveCount(0)
  state.exited = true
  mock.emit(
    { type: "pty.exited", properties: { id: program, exitCode: 1 } },
    updated({ state: "terminated", ptyID: program }),
    output(row(1, "stdout", "program", "loading orders\n"), row(2, "stderr", "program", "ValueError: bad order\n")),
  )
  await expect(page.locator('[data-component="workbench-debug-console"]')).toContainText("ValueError: bad order")
  await page.locator('[data-workbench-tab="run"]').click()
  await expect(run.locator('[data-slot="run-status"]')).toHaveText("Exited with code 1")
  const replay = run.locator("[data-run-replay]")
  await expect(replay).toContainText("The program has ended")
  await expect(replay).toContainText("loading orders")
  await expect(replay).toContainText("ValueError: bad order")
  await expect(terminal).toHaveCount(0)
  expect(state.sockets).toBe(1)

  // After a reload the exit was never seen: the terminal tries, the PTY is gone, and the debugger's copy is gone too
  mock.sessions = [session({ state: "terminated", ptyID: program })]
  mock.backlog = null
  await page.reload()
  await expectSessionTitle(page, title)
  // The bottom panel and its tab are restored
  await page.locator('[data-workbench-tab="run"]').click()
  await expect(replay).toContainText("Output is no longer available")
  await expect(terminal).toHaveCount(0)
  expect(state.sockets).toBeGreaterThan(1)
})

test("editor gutter: paused line with values, breakpoint dots, F9, frame selection", async ({ page }) => {
  const mock = await setup(page)
  mock.sessions = [session()]
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  // The stop opens app.py in the editor; the paused line is marked and shows the values named on it
  mock.emit(updated({ state: "stopped", stop: stopAt(1) }))
  const panel = page.locator("#review-panel")
  await expect(panel.getByRole("tab", { name: "app.py" })).toHaveAttribute("data-selected", "")
  const editor = panel.locator('[data-component="workbench-editor"][data-path="app.py"]')
  await expect(editor.locator('.cm-line[data-spicy-exec][data-line="4"]')).toHaveCount(1)
  await expect(editor.locator(".cm-lineNumbers .cm-spicy-exec-gutter")).toHaveText("4")
  await expect(editor.locator("[data-debug-values]")).toHaveText("x = 1")

  // F9 (the editor not focused) on the paused line adds a breakpoint dot; the server reported it unverified
  await page.keyboard.press("F9")
  await expect(editor.locator('[data-spicy-breakpoint][data-line="4"]')).toHaveAttribute(
    "data-spicy-breakpoint",
    "unverified",
  )

  // Another frame moves the marker; values are only known for the top frame
  await panel.locator('[data-workbench-side-tab="debug"]').click()
  await panel.getByRole("button", { name: "Open app.py at line 12" }).click()
  await expect(editor.locator('.cm-line[data-spicy-exec][data-line="12"]')).toHaveCount(1)
  await expect(editor.locator('.cm-line[data-spicy-exec][data-line="4"]')).toHaveCount(0)
  await expect(editor.locator("[data-debug-values]")).toHaveCount(0)

  // F9 on line 12 adds a second breakpoint; F9 again removes it
  await page.keyboard.press("F9")
  await expect(editor.locator('[data-spicy-breakpoint][data-line="12"]')).toHaveCount(1)
  await page.keyboard.press("F9")
  await expect(editor.locator('[data-spicy-breakpoint][data-line="12"]')).toHaveCount(0)
  await expect(editor.locator('[data-spicy-breakpoint][data-line="4"]')).toHaveCount(1)
  expect(mock.breakpoints.at(-1)).toEqual({ file: `${directory}/app.py`, breakpoints: [{ line: 4 }] })

  // A click in the gutter sets a breakpoint on that line and a second click clears it, here and on the server
  await editor.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^9$/ }).click()
  await expect(editor.locator('[data-spicy-breakpoint][data-line="9"]')).toHaveCount(1)
  await expect
    .poll(() => mock.breakpoints.at(-1))
    .toEqual({ file: `${directory}/app.py`, breakpoints: [{ line: 4 }, { line: 9 }] })
  await editor.locator('.cm-spicy-glyphs [data-line="9"]').click()
  await expect(editor.locator('[data-spicy-breakpoint][data-line="9"]')).toHaveCount(0)

  // Running clears the paused line
  mock.emit(updated({ state: "running" }))
  await expect(editor.locator("[data-spicy-exec]")).toHaveCount(0)
})

test("editor: a Problems event puts its lint marker in the gutter and under the code", async ({ page }) => {
  const mock = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await page.getByRole("button", { name: "Toggle review" }).click()
  await panel.getByRole("button", { name: "Open file" }).click()
  await panel.locator('[data-slot="file-tree-v2-row"][data-path="app.py"]').click()
  const editor = panel.locator('[data-component="workbench-editor"][data-path="app.py"]')
  await expect(editor.locator(".cm-line").first()).toHaveText("import sys")
  await expect(editor.locator("[data-spicy-glyph]")).toHaveCount(0)

  mock.problems = [
    {
      id: "p1",
      file: `${directory}/app.py`,
      range: { start: { line: 4, character: 12 }, end: { line: 4, character: 16 } },
      severity: "error",
      message: '"range" is shadowed',
      source: { kind: "lsp", tool: "pyright", producer: `lsp:pyright:${directory}` },
      observedAt: 1,
      stale: false,
    },
  ]
  mock.emit({ type: "workbench.problems.updated", properties: {} })
  await expect(editor.locator('[data-spicy-glyph="error"][data-line="5"]')).toHaveCount(1)
  await expect(editor.locator(".cm-lintRange-error")).toHaveText("list")
  await editor.locator(".cm-lintRange-error").hover()
  await expect(page.locator(".cm-tooltip-lint")).toContainText('"range" is shadowed')
})

test("a stop brings its file forward over the Review tab but leaves the Debug tab in front", async ({ page }) => {
  const mock = await setup(page, {
    vcsDiff: [
      {
        file: "src/other.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch:
          "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,2 +1,2 @@\n-export const a = 1\n+export const a = 2\n export const b = 3\n",
      },
    ],
  })
  mock.sessions = [session()]
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(panel.getByRole("tab", { name: /Files Changed/ })).toHaveAttribute("data-selected", "")

  mock.emit(updated({ state: "stopped", stop: stopAt(1) }))
  await expect(panel.getByRole("tab", { name: "app.py" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByRole("tab", { name: /Files Changed/ })).not.toHaveAttribute("data-selected", "")

  // Not over the Debug tab: stepping keeps the stack and variables in view
  await panel.locator('[data-workbench-side-tab="debug"]').click()
  const debug = panel.locator('[data-component="workbench-debug"]')
  await expect.poll(() => mock.scopes.length).toBeGreaterThan(0)
  const loaded = mock.scopes.length
  mock.emit(updated({ state: "stopped", stop: stopAt(2) }))
  // The new stop reloads the frame's scopes, so it has been applied while the Debug tab stays in front
  await expect.poll(() => mock.scopes.length).toBeGreaterThan(loaded)
  await expect(debug).toBeVisible()

  // Back on another tab, the next stop brings its file forward again
  await panel.getByRole("tab", { name: /Files Changed/ }).click()
  await expect(debug).toBeHidden()
  mock.emit(updated({ state: "stopped", stop: stopAt(3) }))
  await expect(panel.getByRole("tab", { name: "app.py" })).toHaveAttribute("data-selected", "")
})

// UI-05: run keys work like an IDE's, also while the prompt has the focus.
test("UI-05 F5 fires while typing in the prompt", async ({ page }) => {
  await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const input = page.locator('[data-component="prompt-input"]').first()
  await input.click()
  await page.keyboard.type("check this")
  await expect(input).toContainText("check this")

  await page.keyboard.press("F5")
  await expect(page.locator('[data-component="debug-start-dialog"]')).toBeVisible()
  await expect(input).toContainText("check this")
})

// UI-02: a problem opens its file at the problem's line, also far down a long file.
test("UI-02 clicking a problem opens its file at that line", async ({ page }) => {
  const mock = await setup(page)
  const long = Array.from({ length: 200 }, (_, index) => `line_${index + 1} = ${index + 1}`).join("\n") + "\n"
  // Registered after setup's route, so it answers first.
  await page.route(`${server}/workbench/file*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ content: long, hash: "h-long" }),
    }),
  )
  mock.problems = [
    {
      id: "p_150",
      file: `${directory}/app.py`,
      range: { start: { line: 149, character: 0 }, end: { line: 149, character: 8 } },
      severity: "error",
      message: "planted at 150",
      source: { kind: "typecheck", tool: "mypy", producer: "check:mypy:/work" },
      observedAt: 1,
      stale: false,
    },
  ]
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="problems"]').click()
  await page.locator('[data-component="workbench-problems"] [data-problem="p_150"]').click()

  const panel = page.locator("#review-panel")
  await expect(panel.getByRole("tab", { name: "app.py" })).toHaveAttribute("data-selected", "")
  const editor = panel.locator('[data-component="workbench-editor"][data-path="app.py"]')
  await expect(editor.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^150$/ })).toBeInViewport()
})

// UI-03: the editor only renders the lines near the viewport; a breakpoint must come back with its line.
test("UI-03 a breakpoint is still shown after scrolling away and back", async ({ page }) => {
  const mock = await setup(page)
  mock.sessions = [session()]
  const long = Array.from({ length: 200 }, (_, index) => `line_${index + 1} = ${index + 1}`).join("\n") + "\n"
  await page.route(`${server}/workbench/file*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ content: long, hash: "h-long" }),
    }),
  )
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  mock.emit(updated({ state: "stopped", stop: stopAt(1) }))
  const editor = page.locator('#review-panel [data-component="workbench-editor"][data-path="app.py"]')
  await expect(editor.locator('.cm-line[data-spicy-exec][data-line="4"]')).toHaveCount(1)
  await page.keyboard.press("F9")
  const dot = editor.locator('[data-spicy-breakpoint][data-line="4"]')
  await expect(dot).toHaveCount(1)

  // Whichever ancestor actually scrolls the editor.
  const scroll = (top: boolean) =>
    editor.locator(".cm-content").evaluate((el, top) => {
      const scroller = (node: HTMLElement | null): HTMLElement | null =>
        !node || node.scrollHeight > node.clientHeight + 1 ? node : scroller(node.parentElement)
      const target = scroller(el)
      if (target) target.scrollTop = top ? 0 : target.scrollHeight
    }, top)
  await scroll(false)
  await expect(editor.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^200$/ })).toBeInViewport()
  // Line 4 left the DOM, so coming back re-renders it.
  await expect(dot).toHaveCount(0)
  await scroll(true)
  await expect(dot).toHaveCount(1)
  await expect(dot).toBeInViewport()
})

async function openConsole(page: Page, backlog: Record<string, unknown>[]) {
  const mock = await setup(page)
  mock.sessions = [session({ state: "stopped", stop: stopAt(1) })]
  mock.backlog = backlog
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="debug"]').click()
  return { mock, panel: page.locator('[data-component="workbench-debug-console"]') }
}

test("CON-12 10,000 console rows stay virtualized while filtering and scrolling", async ({ page }) => {
  const backlog = Array.from({ length: 10_000 }, (_, index) =>
    row(index + 1, index % 2 ? "stderr" : "stdout", "program", `line ${index + 1}`),
  )
  const { panel } = await openConsole(page, backlog)
  const rows = panel.locator("[data-console-row]")
  // The console follows the newest row.
  await expect(panel.locator('[data-console-row="10000"]')).toContainText("line 10000")
  expect(await rows.count()).toBeLessThan(300)

  const started = Date.now()
  await panel.locator('[data-console-filter="stderr"]').click()
  await expect(panel.locator('[data-console-row="10000"]')).toHaveCount(0)
  await expect(panel.locator('[data-console-row="9999"]')).toContainText("line 9999")
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(await rows.count()).toBeLessThan(300)

  await panel.getByRole("region").evaluate((el) => (el.scrollTop = 0))
  await expect(panel.locator('[data-console-row="1"]')).toContainText("line 1")
  expect(await rows.count()).toBeLessThan(300)
})

test("CON-03 Esc closes the completion list and keeps the typed text", async ({ page }) => {
  const { panel } = await openConsole(page, [row(5, "stdout", "program", "hello")])
  const input = panel.locator('[data-slot="debug-console-input"]')
  await input.fill("ite")
  await expect(panel.getByRole("option")).toHaveText([/items/, /iter/])
  await input.press("Escape")
  await expect(panel.getByRole("option")).toHaveCount(0)
  await expect(input).toHaveValue("ite")
  await expect(input).toBeFocused()
})

test("CON-03 Shift+Enter adds a line and Enter evaluates the whole input; Up and Down recall history from its ends", async ({
  page,
}) => {
  const { mock, panel } = await openConsole(page, [row(5, "stdout", "program", "hello")])
  const input = panel.locator('[data-slot="debug-console-input"]')
  await input.click()
  await page.keyboard.type("total = 1")
  await page.keyboard.press("Shift+Enter")
  await page.keyboard.type("total + 1")
  await expect(input).toHaveValue("total = 1\ntotal + 1")
  await expect(input).toHaveAttribute("rows", "2")
  await page.keyboard.press("Enter")
  await expect.poll(() => mock.evaluations.at(-1)).toEqual({ expression: "total = 1\ntotal + 1", frameID: 1 })
  await expect(input).toHaveValue("")
  await expect(input).toHaveAttribute("rows", "1")

  // Up from the (only) line recalls the two-line entry; Up again only moves to its first line; Down twice goes back
  // to the line being typed.
  const caret = () => input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)
  await page.keyboard.press("ArrowUp")
  await expect(input).toHaveValue("total = 1\ntotal + 1")
  await input.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(15, 15))
  await page.keyboard.press("ArrowUp")
  await expect(input).toHaveValue("total = 1\ntotal + 1")
  expect(await caret()).toBeLessThan(10)
  await page.keyboard.press("ArrowDown")
  await expect(input).toHaveValue("total = 1\ntotal + 1")
  expect(await caret()).toBeGreaterThan(9)
  await page.keyboard.press("ArrowDown")
  await expect(input).toHaveValue("")
})

test("CON-05 an agent's evaluation is attributed to the agent", async ({ page }) => {
  const { mock, panel } = await openConsole(page, [row(5, "stdout", "program", "hello")])
  mock.emit(output(row(6, "eval", "agent", "len(xs)"), row(7, "result", "agent", "(0, 0)")))
  await expect(panel.locator('[data-console-row="6"]')).toHaveText("agent› len(xs)")
  await expect(panel.locator('[data-console-row="6"]')).toHaveAttribute("data-by", "agent")
  await expect(panel.locator('[data-console-row="7"]')).toContainText("(0, 0)")
})

test("CON-04 stderr is styled apart from stdout", async ({ page }) => {
  const { panel } = await openConsole(page, [
    row(5, "stdout", "program", "plain line"),
    row(6, "stderr", "program", "error line"),
  ])
  const color = (seq: number) =>
    panel.locator(`[data-console-row="${seq}"] > div`).evaluate((el) => getComputedStyle(el).color)
  await expect(panel.locator('[data-console-row="6"]')).toContainText("error line")
  expect(await color(6)).not.toBe(await color(5))
})

function row(seq: number, kind: string, by: string, text: string) {
  return { seq, at: seq, kind, by, text }
}

function output(...rows: Record<string, unknown>[]) {
  return { type: "workbench.debug.output", properties: { debugSessionID: debugID, rows } }
}

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

async function setup(page: Page, options: { vcsDiff?: unknown[] } = {}) {
  const pending: { directory: string; payload: unknown }[] = []
  const mock = {
    // What GET /workbench/debug/sessions and GET .../output return; tests set them before navigating.
    sessions: [] as unknown[],
    // null: the server no longer has the session's output (404)
    backlog: [] as unknown[] | null,
    // Reply to POST .../evaluate; defaults to a plain result.
    evaluate: undefined as ((body: Record<string, unknown>) => unknown) | undefined,
    completions: [] as string[],
    startError: undefined as string | undefined,
    starts: [] as unknown[],
    controls: [] as string[],
    owners: [] as string[],
    variables: [] as string[],
    evaluations: [] as unknown[],
    scopes: [] as number[],
    breakpoints: [] as unknown[],
    // GET /workbench/problems
    problems: [] as unknown[],
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
    fileList: (path) =>
      path ? [] : [{ name: "app.py", path: "app.py", absolute: `${directory}/app.py`, type: "file", ignored: false }],
    ...(options.vcsDiff ? { vcsDiff: options.vcsDiff } : {}),
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
    if (path === "/workbench/debug/sessions" && request.method() === "GET") return json(route, mock.sessions)
    // The editor reads files through the editor's own route.
    if (path === "/workbench/file" && url.searchParams.get("path") === "app.py")
      return json(route, { content: source, hash: "h1" })
    if (path === "/workbench/problems")
      return json(route, {
        problems: mock.problems,
        counts: { error: mock.problems.length, warning: 0, info: 0, hint: 0 },
        producers: [],
      })
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
    if (action === "scopes") {
      const frame = Number(url.searchParams.get("frameID"))
      mock.scopes.push(frame)
      return json(route, [
        { name: "Locals", variablesReference: frame === 1 ? 30 : 40 },
        { name: "Globals", variablesReference: frame === 1 ? 31 : 41, expensive: true },
      ])
    }
    if (action === "variables") {
      const start = Number(url.searchParams.get("start") ?? 0)
      const ref = Number(url.searchParams.get("ref"))
      mock.variables.push(`${ref}:${start}`)
      if (ref === 30) return json(route, stopAt(0).locals)
      if (ref === 40)
        return json(route, [
          { name: "count", type: "int", value: "6", variablesReference: 0 },
          { name: "label", type: "str", value: "'orders'", variablesReference: 0 },
        ])
      if (ref === 31 || ref === 41)
        return json(route, [{ name: "__name__", type: "str", value: "'__main__'", variablesReference: 0 }])
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
      return json(
        route,
        mock.evaluate?.(body ?? {}) ?? {
          // watch and hover results are only returned (seq 0); repl results are console rows
          seq: body?.context === "watch" ? 0 : 90 + mock.evaluations.length,
          at: 1,
          kind: "result",
          by: "human",
          text: "2",
        },
      )
    }
    if (action === "completions") {
      mock.completions.push(url.search)
      return json(route, [
        { label: "items", type: "variable", start: 0, length: 3 },
        { label: "iter", type: "function", start: 0, length: 3 },
      ])
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
    if (action === "output")
      return mock.backlog ? json(route, mock.backlog) : json(route, { message: "debug session not found" }, 404)
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
