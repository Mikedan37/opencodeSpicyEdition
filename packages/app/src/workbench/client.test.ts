import { describe, expect, test } from "bun:test"
import { createWorkbenchClient, WorkbenchRequestError } from "./client"

function client(reply: (url: URL, init?: RequestInit) => Response, password?: string) {
  const calls: { url: URL; init?: RequestInit }[] = []
  return {
    calls,
    api: createWorkbenchClient({
      server: { url: "http://127.0.0.1:4096/", password },
      directory: "/repo/app",
      fetch: async (url, init) => {
        calls.push({ url, init })
        return reply(url, init)
      },
    }),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const provider = {
  id: "opencode",
  name: "OpenCode",
  available: true,
  auth: "ok",
  capabilities: {
    streaming: true,
    toolEvents: true,
    permissionRequests: true,
    cancel: true,
    resume: false,
    models: true,
    mcpTools: false,
  },
}

describe("workbench client", () => {
  test("scopes requests to the directory, authenticates and decodes", async () => {
    const { api, calls } = client(() => json([provider]), "secret")
    expect((await api.providers()) as unknown).toEqual([provider])
    expect(calls[0]?.url.pathname).toBe("/agenthq/providers")
    expect(calls[0]?.url.searchParams.get("directory")).toBe("/repo/app")
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Basic ${btoa("opencode:secret")}`)
  })

  test("posts JSON bodies to encoded paths", async () => {
    const { api, calls } = client(() => json({ accepted: true }))
    await api.respond("ags_1", "perm/1", "allow")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.url.pathname).toBe("/agenthq/sessions/ags_1/permissions/perm%2F1")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ optionID: "allow" })
  })

  test("a server without the routes is unavailable, other failures carry the server message", async () => {
    const html = client(() => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))
    const missing = client(() => json({ message: "no route" }, 404))
    const broken = client(() => json({ data: { message: "provider crashed" } }, 500))
    const kind = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: unknown) => (error instanceof WorkbenchRequestError ? `${error.kind}: ${error.message}` : "other"),
      )
    expect(await kind(html.api.agents())).toStartWith("unavailable")
    expect(await kind(missing.api.agents())).toBe("unavailable: no route")
    expect(await kind(broken.api.agents())).toBe("failed: provider crashed")
  })

  test("the session's auto-approve switch is read and set on its own route", async () => {
    const { api, calls } = client((_, init) => json({ enabled: init?.method === "PUT" }))
    expect(await api.autoApprove("ses/1")).toBe(false)
    expect(await api.setAutoApprove("ses/1", true)).toBe(true)
    expect(calls.map((call) => [call.init?.method, call.url.pathname])).toEqual([
      ["GET", "/workbench/sessions/ses%2F1/auto-approve"],
      ["PUT", "/workbench/sessions/ses%2F1/auto-approve"],
    ])
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ enabled: true })
  })

  test("replies that do not match the contract are errors, not data", async () => {
    const { api } = client(() => json([{ id: "not-an-agent-id", name: 1 }]))
    await expect(api.agents()).rejects.toThrow("unexpected response")
  })

  test("runs, run records and checks use the workbench routes", async () => {
    const run = {
      id: "run_1",
      kind: "check",
      unit: "/repo/tsconfig.json",
      checker: "tsc",
      command: ["tsc"],
      execClass: "inert",
      status: "passed",
    }
    const { api, calls } = client((url) =>
      url.pathname === "/workbench/runs/run_1" ? json({ run, output: "ok\n", truncated: false }) : json([run]),
    )
    expect((await api.runs()) as unknown).toEqual([run])
    expect((await api.run("run_1")) as unknown).toEqual({ run, output: "ok\n", truncated: false })
    await api.check({ unit: "/repo" }).catch(() => undefined)
    expect(calls.map((call) => `${call.init?.method} ${call.url.pathname}`)).toEqual([
      "GET /workbench/runs",
      "GET /workbench/runs/run_1",
      "POST /workbench/check",
    ])
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ unit: "/repo" })
  })

  test("session history decodes as { session, history }", async () => {
    const info = {
      id: "ags_1",
      agentID: "agt_1",
      provider: "opencode",
      status: "idle",
      pendingPermissions: 0,
      createdAt: 1,
      updatedAt: 2,
    }
    const history = [{ sessionID: "ags_1", seq: 0, at: 1, event: { type: "turn.completed" } }]
    const { api } = client(() => json({ session: info, history }))
    expect((await api.session("ags_1")) as unknown).toEqual({ session: info, history })
  })
})
