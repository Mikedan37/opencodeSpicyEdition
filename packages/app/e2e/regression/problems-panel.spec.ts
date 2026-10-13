import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockWorkbench, problemsSnapshot } from "../utils/workbench-mock"
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
  // A row's name is its content (UX a11y), not just where it opens
  await expect(
    panel.getByRole("button", { name: "Error: Cannot find name 'foo'., app.ts line 9, column 5", exact: true }),
  ).toBeVisible()
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
  const banner = panel.locator('[data-slot="problems-lsp-off"]')
  await expect(banner).toContainText(off)
  await expect(banner.getByRole("button", { name: "Turn on language servers" })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("diag12-banner.png") })

  // No problems: the empty state carries the same line, and no banner. Nothing reported, so not an all-clear.
  mock.snapshot = { ...snapshot([]), lsp: "off" }
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: snapshot([]).counts } })
  await expect(panel).toContainText("Nothing checked yet")
  await expect(panel).toContainText(off)
  await expect(panel.locator('[data-slot="problems-lsp-off"]')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("diag12-empty.png") })

  // Language servers on: neither.
  mock.snapshot = { ...snapshot([]), lsp: "on" }
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: snapshot([]).counts } })
  await expect(panel).not.toContainText(off)
})

const ada = {
  id: "agt_ada",
  name: "Ada",
  avatar: { kind: "preset", value: "fox", color: "orange" },
  provider: "opencode",
  projectDirectory: directory,
  createdAt: 1,
  updatedAt: 1,
}

test("UI-07 Fix with agent sends the problem's snapshot; Fix all in file sends the file's to an agent", async ({
  page,
}) => {
  const mock = await setup(page)
  mock.snapshot = snapshot([
    {
      ...problem("p_assign", 12, "Type 'string' is not assignable to type 'number'.", [
        { ...tsc, runID: "run_tsc" },
        { ...lsp, channel: "push" },
      ]),
      code: "TS2322",
    },
    {
      ...problem("p_unused", 3, "'x' is declared but never used.", [{ ...lsp, channel: "pull" }]),
      severity: "warning",
    },
  ])
  mock.file = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
  mock.runs = [
    {
      id: "run_tsc",
      kind: "check",
      unit: `${directory}/tsconfig.json`,
      checker: "tsc",
      command: ["tsc", "--noEmit"],
      execClass: "inert",
      status: "failed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_900,
      exitCode: 2,
      counts: { error: 1, warning: 0, info: 0, hint: 0 },
    },
  ]
  const panel = await openProblems(page)
  const action = (selector: string) => panel.locator(selector).locator("xpath=..").locator('[data-action="handoff"]')
  const menu = page.locator("[data-handoff-menu]")

  // UX #10: a "Fix" text button shows on the hovered row and on the row the keyboard is on, and Tab reaches it.
  const fix = action('[data-problem="p_assign"]')
  await expect(fix).toHaveText("Fix")
  await expect(fix).toHaveAttribute("aria-label", "Fix with agent: Type 'string' is not assignable to type 'number'.")
  await expect.poll(() => fix.evaluate((el) => getComputedStyle(el).opacity)).toBe("0")
  await panel.locator('[data-problem="p_assign"]').hover()
  await expect.poll(() => fix.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  await page.mouse.move(0, 0)
  await panel.locator('[data-problem="p_assign"]').focus()
  await expect.poll(() => fix.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  await page.keyboard.press("Tab")
  await expect(fix).toBeFocused()
  await expect(action('[data-row="file"]')).toHaveText("Fix all")

  // A problem row's picker: this session and the Agent HQ identity. This session gets exactly the problem's snapshot.
  await action('[data-problem="p_assign"]').click()
  await expect(menu.locator("[data-target]")).toHaveText(["This session", "Ada"])
  await page.screenshot({ path: test.info().outputPath("ui07-picker.png") })
  await menu.locator('[data-target="session"]').click()
  await expect.poll(() => mock.prompts.length).toBe(1)
  const prompt = mock.prompts[0]!
  expect(prompt.path).toBe(`/session/${sessionID}/prompt_async`)
  // UX #10: a one-line message, with the snapshot attached as "Problem context" (the server hands it to the model
  // whole).
  const parts = (prompt.body as { parts: { type: string; text?: string; url?: string; filename?: string }[] }).parts
  expect(parts).toEqual([
    expect.objectContaining({
      type: "text",
      text: "Fix the problem at src/app.ts:12: Type 'string' is not assignable to type 'number'.",
    }),
    expect.objectContaining({ type: "file", mime: "text/plain", filename: "Problem context" }),
  ])
  const attached = parts[1]!.url!
  expect(Buffer.from(attached.slice(attached.indexOf(",") + 1), "base64").toString("utf8")).toBe(FIX_ONE)
  await expect(page.getByText("Sent to this session", { exact: true })).toBeVisible()
  // The timeline shows it as a collapsible chip, not a wall of text.
  const chip = page.locator('[data-slot="user-message-context"]')
  await expect(chip.locator("summary")).toHaveText("Problem context")
  await expect(chip.locator("pre")).toBeHidden()
  await chip.locator("summary").click()
  expect(await chip.locator("pre").textContent()).toBe(FIX_ONE)
  await page.screenshot({ path: test.info().outputPath("ui07-context-chip.png") })

  // Fix all in file: the last used target comes first; Ada gets the file's snapshot as an Agent HQ message, and the
  // toast links to the session that received it.
  await action('[data-row="file"]').click()
  await expect(menu.locator("[data-target]")).toHaveText([/^This session\s*Last used$/, "Ada"])
  await menu.locator('[data-target="agent:agt_ada"]').click()
  await expect.poll(() => mock.messages.length).toBe(1)
  expect(mock.messages[0]).toEqual({ to: "agt_ada", text: FIX_FILE })
  await expect(page.getByText("Sent to Ada", { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("ui07-sent.png") })
  await page.getByRole("button", { name: "Open session" }).click()
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-component="agenthq-workspace"] [data-session="ags_ada"]')).toHaveAttribute(
    "aria-current",
    "true",
  )

  // Ada is now the default, also after a reload. Nothing else was sent.
  await page.reload()
  await expectSessionTitle(page, title)
  await page.locator('[data-workbench-tab="problems"]').click()
  await action('[data-problem="p_unused"]').click()
  await expect(menu.locator("[data-target]")).toHaveText([/^Ada\s*Last used$/, "This session"])
  await page.keyboard.press("Escape")
  expect(mock.prompts).toHaveLength(1)
  expect(mock.messages).toHaveLength(1)
})

const excerpt = (from: number, to: number, marked: number[]) =>
  Array.from({ length: to - from + 1 }, (_, index) => {
    const line = from + index
    return `${marked.includes(line) ? ">" : " "} ${String(line).padStart(2)} | line ${line}`
  })
const VERIFIED =
  "Latest verification run: tsc check of tsconfig.json: failed (exit code 2; 1 errors, 0 warnings; run run_tsc)."
const FIX_ONE = [
  "Fix this problem.",
  "",
  "File: src/app.ts",
  "Severity: error",
  "Range: 12:5-12:10",
  "Code: TS2322",
  "Message: Type 'string' is not assignable to type 'number'.",
  "Sources: tsc (typecheck, run run_tsc), typescript (lsp, push)",
  "",
  'Source of src/app.ts (">" marks the problem lines):',
  "```",
  ...excerpt(2, 22, [12]),
  "```",
  "",
  VERIFIED,
].join("\n")
const FIX_FILE = [
  "Fix these 2 problems in src/app.ts.",
  "",
  "Problem 1 of 2",
  "Severity: error",
  "Range: 12:5-12:10",
  "Code: TS2322",
  "Message: Type 'string' is not assignable to type 'number'.",
  "Sources: tsc (typecheck, run run_tsc), typescript (lsp, push)",
  "",
  "Problem 2 of 2",
  "Severity: warning",
  "Range: 3:5-3:10",
  "Message: 'x' is declared but never used.",
  "Sources: typescript (lsp, pull)",
  "",
  'Source of src/app.ts (">" marks the problem lines):',
  "```",
  ...excerpt(1, 22, [3, 12]),
  "```",
  "",
  VERIFIED,
].join("\n")

test("first run: Nothing checked yet, Run checks, Last checked, and Turn on language servers after asking", async ({
  page,
}) => {
  const { mock, open } = await mockWorkbench(page, { directory: "/work/first", title: "First run" })
  mock.snapshot = { ...problemsSnapshot([]), lsp: "off" }
  mock.files["opencode.json"] = '{\n  "model": "test/test"\n}\n'
  await open()
  await page.locator('[data-status="problems"]').click()
  const panel = page.locator('[data-component="workbench-problems"]')
  // Nothing reported yet: no false all-clear, and the way to get a real answer.
  await expect(panel).toContainText("Nothing checked yet")
  await expect(panel).not.toContainText("No problems detected")
  await page.screenshot({ path: test.info().outputPath("first-run-unchecked.png") })
  await panel.getByRole("button", { name: "Run checks" }).last().click()
  await expect.poll(() => mock.checks).toEqual([{ unit: "/work/first" }])

  // Once a checker reported: the all-clear, with when and what.
  mock.snapshot = {
    ...problemsSnapshot(
      [],
      [{ producer: "check:tsc", kind: "typecheck", tool: "tsc", state: "idle", updatedAt: Date.now() }],
    ),
    lsp: "off",
  }
  mock.emit({ type: "workbench.problems.updated", properties: { producers: [], counts: mock.snapshot.counts } })
  await expect(panel).toContainText("No problems detected")
  await expect(panel.locator('[data-slot="problems-checked"]')).toHaveText("Last checked: Just now · tsc")

  // Turn on language servers: asks, then writes the project's opencode.json and reloads the project.
  await panel.locator('[data-action="problems-lsp"]').click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Turn on language servers?")
  await expect(dialog).toContainText('This sets "lsp": true in opencode.json in this project')
  await page.screenshot({ path: test.info().outputPath("first-run-lsp-confirm.png") })
  mock.snapshot = { ...mock.snapshot, lsp: "on" }
  await dialog.locator('[data-choice="enable"]').click()
  await expect
    .poll(() => mock.config)
    .toEqual([{ path: "opencode.json", content: '{\n  "model": "test/test",\n  "lsp": true\n}\n', baseHash: "h1" }])
  await expect.poll(() => mock.disposed).toBe(1)
  await expect(panel.locator('[data-action="problems-lsp"]')).toHaveCount(0)
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
    // GET /workbench/file?path=src/app.ts and GET /workbench/runs
    file: "",
    runs: [] as unknown[],
    // What this session's prompts and Agent HQ's messages received.
    prompts: [] as { path: string; body: unknown }[],
    messages: [] as unknown[],
    emit(...items: Record<string, unknown>[]) {
      pending.push(...items.map((item) => ({ directory, payload: { id: `evt_${Math.random()}`, ...item } })))
    },
  }
  await mockOpenCodeServer(page, {
    protocol: "v1",
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
    if (url.pathname === "/workbench/runs") return json(route, mock.runs)
    if (url.pathname === "/workbench/file" && url.searchParams.get("path") === "src/app.ts")
      return json(route, { content: mock.file, hash: "h1" })
    return json(route, { message: url.pathname }, 404)
  })
  // This session's prompt, whichever protocol the app speaks.
  await page.route(/\/session\/[^/]+\/prompt(_async)?(\?|$)/, (route) => {
    mock.prompts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    return json(route, {})
  })
  await page.route(`${server}/agenthq/**`, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === "/agenthq/agents") return json(route, [ada])
    if (path === "/agenthq/messages" && request.method() === "POST") {
      const body = request.postDataJSON() as { to: string; text: string }
      mock.messages.push(body)
      return json(route, {
        id: "amg_1",
        from: "user",
        to: body.to,
        text: body.text,
        evidenceIDs: [],
        at: 1_700_000_000_500,
        delivery: "delivered",
        kind: "user",
        sessionID: "ags_ada",
        hops: 0,
        relay: false,
      })
    }
    if (path === "/agenthq/sessions/ags_ada")
      return json(route, {
        session: {
          id: "ags_ada",
          agentID: "agt_ada",
          provider: "opencode",
          title: "Messages",
          status: "working",
          pendingPermissions: 0,
          createdAt: 1_700_000_000_500,
          updatedAt: 1_700_000_000_500,
        },
        history: [],
      })
    // providers, sessions, tasks, messages: none
    return json(route, [])
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
