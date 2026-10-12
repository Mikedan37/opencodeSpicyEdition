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

  test("replies that do not match the contract are errors, not data", async () => {
    const { api } = client(() => json([{ id: "not-an-agent-id", name: 1 }]))
    await expect(api.agents()).rejects.toThrow("unexpected response")
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
