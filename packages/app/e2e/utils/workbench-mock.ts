// A mocked opencode server for the IDE's specs: the session page of one project with the Workbench and Agent HQ routes
// answered from a `mock` object the spec changes as it goes, events pushed with `mock.emit`, and what the app sent
// recorded (prompts, messages, checks, config writes). v1 protocol: the composer has a model, so prompts can be sent.
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "./mock-server"
import { expectSessionTitle } from "./waits"

export const workbenchServer = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

export const ada = {
  id: "agt_ada",
  name: "Ada",
  avatar: { kind: "preset", value: "fox", color: "orange" },
  provider: "opencode",
  projectDirectory: "",
  createdAt: 1,
  updatedAt: 1,
}

export function problemsSnapshot(problems: Record<string, unknown>[], producers: Record<string, unknown>[] = []) {
  return {
    problems,
    counts: {
      error: problems.filter((item) => (item.severity ?? "error") === "error").length,
      warning: problems.filter((item) => item.severity === "warning").length,
      info: 0,
      hint: 0,
    },
    producers,
  } as Record<string, unknown>
}

export async function mockWorkbench(
  page: Page,
  options: { directory: string; title: string; sessionID?: string; intro?: boolean },
) {
  const directory = options.directory
  const projectID = `proj_${directory.split("/").pop()}`
  const sessionID = options.sessionID ?? `ses_${directory.split("/").pop()}`
  const pending: { directory: string; payload: unknown }[] = []
  const mock = {
    directory,
    sessionID,
    // GET /workbench/problems, /workbench/runs, /workbench/file?path=, /workbench/debug/sessions, /workbench/doctor,
    // /workbench/investigations, /workbench/tools
    snapshot: problemsSnapshot([]),
    runs: [] as unknown[],
    investigations: [] as unknown[],
    tools: [] as unknown[],
    files: {} as Record<string, string>,
    debugSessions: [] as unknown[],
    doctor: undefined as unknown,
    // GET /agenthq/agents, /agenthq/agents/:id/sessions, /agenthq/tasks, /agenthq/providers
    agents: [] as unknown[],
    providers: [] as unknown[],
    agentSessions: [] as { agentID: string }[],
    tasks: [] as unknown[],
    // What the app sent: this session's prompts, Agent HQ messages and new agents, checks, config changes, permission
    // replies.
    prompts: [] as { path: string; body: unknown }[],
    created: [] as Record<string, unknown>[],
    messages: [] as unknown[],
    checks: [] as unknown[],
    config: [] as unknown[],
    replies: [] as { id: string; reply: unknown }[],
    // POST /instance/dispose (the project reloads on the server)
    disposed: 0,
    // POST /workbench/check answers with this summary
    checkSummary: { passed: 0, failed: 0, skipped: 0, unavailable: 0, timedOut: 0 },
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
      name: directory.split("/").pop(),
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
        title: options.title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    events: () => pending.splice(0),
    fileList: () => [],
    fileContent: (path) => ({ type: "text", content: mock.files[path] ?? "" }),
    onInstanceDispose: () => mock.disposed++,
  })
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })
  const server = workbenchServer
  await page.route(`${server}/workbench/**`, (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === "/workbench/problems") return json(route, mock.snapshot)
    if (path === "/workbench/runs") return json(route, mock.runs)
    if (path === "/workbench/debug/sessions" && request.method() === "GET") return json(route, mock.debugSessions)
    if (path === "/workbench/doctor" && mock.doctor) return json(route, mock.doctor)
    if (path === "/workbench/check" && request.method() === "POST") {
      mock.checks.push(request.postDataJSON())
      return json(route, {
        id: "rep_1",
        trigger: "user",
        changedFiles: [],
        checks: [],
        summary: mock.checkSummary,
        unverifiedFiles: [],
        completedAt: 1_700_000_000_000,
      })
    }
    if (path === "/workbench/file") {
      const file = url.searchParams.get("path") ?? ""
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { path: string; content: string }
        mock.files[body.path] = body.content
        mock.config.push(body)
        return json(route, { hash: "h2" })
      }
      if (file in mock.files) return json(route, { content: mock.files[file], hash: "h1" })
    }
    if (path === "/workbench/investigations") return json(route, mock.investigations)
    if (path === "/workbench/tools") return json(route, mock.tools)
    return json(route, { message: path }, 404)
  })
  // This session's prompt, whichever protocol the app speaks.
  await page.route(/\/session\/[^/]+\/prompt(_async)?(\?|$)/, (route) => {
    mock.prompts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    return json(route, {})
  })
  await page.route(`${server}/permission/*/reply*`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[2]!
    mock.replies.push({ id, reply: (route.request().postDataJSON() as { reply?: unknown }).reply })
    return json(route, true)
  })
  await page.route(`${server}/agenthq/**`, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === "/agenthq/agents" && request.method() === "GET") return json(route, mock.agents)
    if (path === "/agenthq/providers") return json(route, mock.providers)
    if (path === "/agenthq/agents" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>
      mock.created.push(body)
      const agent = { ...body, id: `agt_${mock.created.length}`, createdAt: 2, updatedAt: 2 }
      mock.agents.push(agent)
      return json(route, agent)
    }
    if (path === "/agenthq/tasks" && request.method() === "GET") return json(route, mock.tasks)
    const sessionsOf = path.match(/^\/agenthq\/agents\/([^/]+)\/sessions$/)?.[1]
    if (sessionsOf && request.method() === "GET")
      return json(
        route,
        mock.agentSessions.filter((item) => item.agentID === sessionsOf),
      )
    if (path === "/agenthq/messages" && request.method() === "POST") {
      const body = request.postDataJSON() as { to: string; text: string }
      mock.messages.push(body)
      return json(route, {
        id: `amg_${mock.messages.length}`,
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
    // providers, sessions, messages: none
    return json(route, [])
  })
  const ptyID = `pty_${projectID}`
  const location = { directory, project: { id: projectID, directory } }
  const pty = { id: ptyID, title: "Terminal 1", command: "zsh", args: [], cwd: directory, status: "running", pid: 1 }
  await page.route("**/api/pty*", (route) => json(route, { location, data: pty }))
  await page.route(`**/api/pty/${ptyID}*`, (route) => json(route, { location, data: pty }))
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyID}/connect`), () => undefined)
  // v1 terminals: the panel opens with one, like a real server's
  await page.route(`${server}/pty`, (route) => json(route, pty))
  await page.route(`${server}/pty/${ptyID}*`, (route) => json(route, pty))
  await page.route(`${server}/pty/${ptyID}/connect-token*`, (route) =>
    json(route, { ticket: "e2e-ticket", expires_in: 60 }),
  )
  await page.routeWebSocket(new RegExp(`/pty/${ptyID}/connect`), () => undefined)
  await page.addInitScript(
    (input) => {
      if (sessionStorage.getItem("workbench-mock.seeded")) return
      sessionStorage.setItem("workbench-mock.seeded", "1")
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
      // The one-time "Your IDE" card, seen already unless a spec is about it.
      if (!input.intro) localStorage.setItem("opencode.global.dat:workbench.intro", JSON.stringify({ dismissed: true }))
    },
    { directory, server, sessionID, intro: !!options.intro },
  )
  return {
    mock,
    // The session page, ready.
    async open() {
      await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
      await expectSessionTitle(page, options.title)
    },
  }
}
