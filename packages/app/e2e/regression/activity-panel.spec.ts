import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Spicy Workbench Activity tab (P7): investigations with their timeline and evidence, linked to Output, the Debug tab
// and Agent HQ; plus the debug session's hand-to-agent / release controls.
const directory = "/work/activity"
const projectID = "proj_activity"
const sessionID = "ses_activity"
const title = "Activity host"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

test("activity: investigation timeline and evidence link to Output, Debug and Agent HQ; resume, cancel, ownership", async ({
  page,
}) => {
  const mock = await setup(page)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-workbench-tab="activity"]')).toHaveText("Activity1")
  await page.locator('[data-workbench-tab="activity"]').click()
  const activity = page.locator('[data-component="workbench-activity"]')
  await expect(activity.locator("button[data-investigation]")).toHaveCount(2)

  // The newest investigation: why it waits, its status timeline and its evidence
  const detail = activity.locator('[data-component="workbench-investigation"]')
  await expect(detail.locator('[data-slot="investigation-reason"]')).toHaveText("S2: the same error came back twice")
  await expect(detail.locator('[data-slot="investigation-timeline"] [data-checkpoint]')).toHaveCount(4)
  await expect(detail.locator('[data-checkpoint="needs_human"]')).toContainText("S2: the same error came back twice")
  const evidence = detail.locator('[data-slot="investigation-evidence"] [data-evidence]')
  await expect(evidence).toHaveCount(3)
  await expect(evidence.nth(0)).toHaveAttribute("data-class", "observed")
  await expect(evidence.nth(2)).toHaveAttribute("data-class", "verified")
  await expect(evidence.nth(2)).toContainText("Verification")
  await expect(detail).toContainText("Agent notes (inferred, not evidence)")
  await expect(detail).toContainText("1 of 2 repair attempts, 12 of 200 debug steps")
  await expect(detail.locator("strong")).toHaveText("observed")

  // A verification run opens in Output, expanded
  await evidence.nth(0).locator('[data-link="run"]').click()
  await expect(page.locator('[data-workbench-tab="output"]')).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('section[data-run="run_1"] [role="region"]')).toBeVisible()
  await expect(page.locator('section[data-run="run_1"]')).toContainText("AssertionError")

  // A debug session opens in the side panel's Debug tab; its owner can release it ("Controlled by" menu) or let the
  // agent drive (Ask an agent menu)
  await page.locator('[data-workbench-tab="activity"]').click()
  await evidence.nth(1).locator('[data-link="debug"]').click()
  const debug = page.locator('#review-panel [data-component="workbench-debug"]')
  await expect(debug).toBeVisible()
  const owner = debug.locator('[data-slot="debug-owner"]')
  await expect(owner).toHaveAttribute("data-owner", "human")
  await owner.click()
  await page.locator('[data-action="debug-release"]').click()
  await expect(owner).toHaveAttribute("data-owner", "idle")
  await expect(owner).toHaveText("Controlled by: Nobody")
  await debug.locator('[data-action="ask-agent"]').click()
  await page.locator('[data-action="debug-hand-to-agent"]').click()
  await expect(owner).toHaveAttribute("data-owner", "agent")
  await owner.click()
  await expect(page.locator('[data-action="debug-take-over"]')).toBeVisible()
  await page.keyboard.press("Escape")
  expect(mock.owners).toEqual(["idle", "agent"])

  // The agent's session opens in Agent HQ
  await page.locator('[data-workbench-tab="activity"]').click()
  await detail.locator('[data-link="session"]').first().click()
  await expect(page.locator('[data-workbench-tab="agents"]')).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-component="agenthq-workspace"] [data-session="ags_inv"]')).toHaveAttribute(
    "aria-current",
    "true",
  )

  // Resume and cancel; a newer summary reloads the record
  await page.locator('[data-workbench-tab="activity"]').click()
  const records = mock.records
  await detail.locator('[data-action="investigation-resume"]').click()
  await expect(activity.locator('button[data-investigation="inv_1"] [data-investigation-status]')).toHaveAttribute(
    "data-investigation-status",
    "reproducing",
  )
  await expect.poll(() => mock.records).toBeGreaterThan(records)
  await expect(page.locator('[data-workbench-tab="activity"]')).toHaveText("Activity")
  mock.emit({
    type: "workbench.investigation.updated",
    properties: { investigation: summary("inv_1", "verifying", 50) },
  })
  await expect(detail.locator("h3 + [data-investigation-status]")).toHaveAttribute(
    "data-investigation-status",
    "verifying",
  )
  await detail.locator('[data-action="investigation-cancel"]').click()
  await expect(detail.locator('[data-action="investigation-cancel"]')).toHaveCount(0)
  expect(mock.actions).toEqual(["resume", "cancel"])
})

function summary(id: string, status: string, updatedAt: number) {
  return {
    id,
    title: id === "inv_1" ? "Parser crashes on empty input" : "Flaky test in utils",
    status,
    agentID: "agt_ada",
    sessionID: "ags_inv",
    attempts: 1,
    evidenceCount: 3,
    ...(status === "needs_human" ? { reason: "S2: the same error came back twice" } : {}),
    updatedAt,
  }
}

function record() {
  return {
    investigation: {
      id: "inv_1",
      projectID,
      directory,
      sessionID: "ags_inv",
      agentID: "agt_ada",
      title: "Parser crashes on empty input",
      status: "needs_human",
      policy: {
        maxRepairAttempts: 2,
        maxDebugSteps: 200,
        maxInvestigationDurationMs: 1_800_000,
        requireApprovalForExecution: true,
        requireApprovalForAttach: true,
        stopOnRepeatedFailures: true,
        stopOnPermissionDenial: true,
      },
      target: { program: `${directory}/parser.py` },
      attempts: [
        {
          n: 1,
          patchHash: "abc",
          changes: [{ file: `${directory}/parser.py`, hash: "h1" }],
          errorFingerprints: [],
          errorCount: 2,
          checkIDs: ["run_2"],
          passed: false,
          at: 4,
        },
      ],
      evidence: ["ev_1", "ev_2", "ev_3"],
      notes: [{ kind: "hypothesis", text: "split() on an empty line returns []", at: 3 }],
      checkpoints: [
        { status: "created", at: 1 },
        { status: "reproducing", at: 2, evidenceID: "ev_1" },
        { status: "debugging", at: 3, evidenceID: "ev_2" },
        { status: "needs_human", at: 5, reason: "S2: the same error came back twice" },
      ],
      processes: [],
      debugSessions: ["dbg_one"],
      steps: 12,
      crashes: 0,
      since: 1,
      seq: 9,
      unverified: [`${directory}/parser.py`],
      host: { pid: 1 },
      createdAt: 1,
      updatedAt: 5,
    },
    evidence: [
      {
        id: "ev_1",
        kind: "repro-run",
        class: "observed",
        summary: "python parser.py exits 1",
        refs: { runID: "run_1" },
        at: 2,
      },
      {
        id: "ev_2",
        kind: "debug-stop",
        class: "observed",
        summary: "IndexError at parser.py:12",
        refs: { debugSessionID: "dbg_one" },
        at: 3,
      },
      {
        id: "ev_3",
        kind: "verification",
        class: "verified",
        summary: "check failed with 2 errors",
        refs: { runID: "run_2", sessionID: "ags_inv" },
        data: { errors: 2 },
        at: 4,
      },
    ],
    report: "Facts are **observed** unless verified.",
  }
}

async function setup(page: Page) {
  const pending: { directory: string; payload: unknown }[] = []
  const mock = {
    records: 0,
    actions: [] as string[],
    owners: [] as string[],
    emit(...items: Record<string, unknown>[]) {
      pending.push(...items.map((item) => ({ directory, payload: { id: `evt_${Math.random()}`, ...item } })))
    },
  }
  let owner = "human"

  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "activity",
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
    events: () => pending.splice(0),
  })

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })

  const debugSession = () => ({
    id: "dbg_one",
    adapter: "debugpy",
    program: `${directory}/parser.py`,
    state: "stopped",
    owner,
    capabilities: [],
    investigationID: "inv_1",
    startedAt: 1,
  })

  await page.route(`${server}/workbench/**`, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === "/workbench/investigations")
      return json(route, [summary("inv_1", "needs_human", 5), summary("inv_2", "resolved", 2)])
    if (path === "/workbench/investigations/inv_1") {
      mock.records++
      return json(route, record())
    }
    const action = path.match(/^\/workbench\/investigations\/inv_1\/(resume|cancel)$/)?.[1]
    if (action && method === "POST") {
      mock.actions.push(action)
      return json(
        route,
        summary("inv_1", action === "resume" ? "reproducing" : "cancelled", action === "resume" ? 10 : 60),
      )
    }
    if (path === "/workbench/debug/sessions") return json(route, [debugSession()])
    if (path === "/workbench/debug/sessions/dbg_one/owner") {
      owner = String((request.postDataJSON() as { owner: string }).owner)
      mock.owners.push(owner)
      return json(route, debugSession())
    }
    if (path === "/workbench/debug/sessions/dbg_one/output") return json(route, [])
    if (path === "/workbench/runs")
      return json(route, [
        {
          id: "run_1",
          kind: "test",
          unit: `${directory}/parser.py`,
          checker: "pytest",
          command: ["pytest"],
          execClass: "exec",
          status: "failed",
          startedAt: 1,
          finishedAt: 2,
          exitCode: 1,
        },
      ])
    if (path === "/workbench/runs/run_1")
      return json(route, {
        run: {
          id: "run_1",
          kind: "test",
          unit: `${directory}/parser.py`,
          checker: "pytest",
          command: ["pytest"],
          execClass: "exec",
          status: "failed",
          startedAt: 1,
          finishedAt: 2,
          exitCode: 1,
        },
        output: "E   AssertionError: expected []\n",
      })
    if (path === "/workbench/problems")
      return json(route, { problems: [], counts: { error: 0, warning: 0, info: 0, hint: 0 }, producers: [] })
    return json(route, { message: path }, 404)
  })

  await page.route(`${server}/agenthq/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/agenthq/providers") return json(route, [])
    if (path === "/agenthq/agents")
      return json(route, [
        {
          id: "agt_ada",
          name: "Ada",
          avatar: { kind: "preset", value: "fox", color: "orange" },
          provider: "opencode",
          projectDirectory: directory,
          createdAt: 1,
          updatedAt: 1,
        },
      ])
    if (path === "/agenthq/agents/agt_ada/sessions")
      return json(route, [
        {
          id: "ags_inv",
          agentID: "agt_ada",
          provider: "opencode",
          title: "Investigate the parser",
          status: "idle",
          pendingPermissions: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      ])
    if (path === "/agenthq/sessions/ags_inv")
      return json(route, {
        session: {
          id: "ags_inv",
          agentID: "agt_ada",
          provider: "opencode",
          status: "idle",
          pendingPermissions: 0,
          createdAt: 1,
          updatedAt: 2,
        },
        history: [],
      })
    if (path === "/agenthq/tasks" || path === "/agenthq/messages") return json(route, [])
    return json(route, { message: path }, 404)
  })

  // Opening the bottom panel starts a terminal.
  const ptyID = "pty_activity"
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
