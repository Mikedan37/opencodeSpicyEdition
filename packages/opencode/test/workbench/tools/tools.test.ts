// The tool creator end to end, against the real opencode routes served on a local port: drafts from an agent (the
// agent route, as the Workbench MCP bridge uses it) and from the user, static checks, approval, the registry, the
// custom_* ask, test runs, disable/enable, reject and delete, and the MCP bridge listing and calling created tools.
// The project's .opencode gets @opencode-ai/plugin linked from this repository, so nothing is installed.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Fiber, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { WorkbenchBridge } from "@/workbench/mcp/bridge"
import { WorkbenchToolsBridge } from "@/workbench/mcp/tools"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { httpApiLayer } from "../../server/httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.promise(() => resetDatabase()),
        () => Effect.promise(() => Promise.all([disposeAllInstances(), resetDatabase()])),
      ),
    ),
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    httpApiLayer,
  ),
)

// Writes `marker` when it is imported: it must not exist before the user approves the tool.
const GREETER = (marker: string) => `import { writeFileSync } from "node:fs"
import { tool } from "@opencode-ai/plugin"

writeFileSync(${JSON.stringify(marker)}, "imported")

export default tool({
  description: "Greets someone",
  args: { name: tool.schema.string().describe("Who to greet") },
  async execute(args) {
    return \`hello \${args.name}\`
  },
})
`

// A project whose .opencode already has its dependencies, so config and approval install nothing.
const project = tmpdirScoped({
  git: true,
  init: (dir) =>
    Effect.promise(async () => {
      const opencode = path.join(dir, ".opencode")
      await fs.mkdir(path.join(opencode, "node_modules", "@opencode-ai"), { recursive: true })
      await fs.symlink(
        path.resolve(import.meta.dir, "../../../../plugin"),
        path.join(opencode, "node_modules", "@opencode-ai", "plugin"),
        "dir",
      )
      const dependencies = { "@opencode-ai/plugin": "*" }
      await Bun.write(path.join(opencode, "package.json"), JSON.stringify({ dependencies }))
      await Bun.write(path.join(opencode, "package-lock.json"), JSON.stringify({ packages: { "": { dependencies } } }))
    }),
})

const serverURL = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  if (server.address._tag !== "TcpAddress") throw new Error("the test server should listen on TCP")
  return `http://127.0.0.1:${server.address.port}`
})

// The user's side: the routes the IDE uses.
const ide = (url: string, directory: string) => {
  const request = (route: string, init: RequestInit = {}) =>
    Effect.promise(async () => {
      const response = await fetch(new URL(route, url), {
        ...init,
        headers: { "x-opencode-directory": directory, "content-type": "application/json", ...init.headers },
      })
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as any }
    })
  const post = (route: string, body: unknown = {}) => request(route, { method: "POST", body: JSON.stringify(body) })
  return {
    request,
    post,
    tools: () => request("/workbench/tools").pipe(Effect.map((result) => result.body as Workbench.CustomTool[])),
    ids: () => request("/experimental/tool/ids").pipe(Effect.map((result) => result.body as string[])),
    /** Waits for an ask and answers it like the user would. */
    answer: (permission: string, reply: "once" | "always" | "reject") =>
      Effect.gen(function* () {
        const asked = yield* pollWithTimeout(
          request("/permission").pipe(
            Effect.map((result) =>
              (result.body as { id: string; permission: string; sessionID: string; metadata: any }[]).find(
                (item) => item.permission === permission,
              ),
            ),
          ),
          `no ${permission} request`,
          "10 seconds",
        )
        yield* post(`/permission/${asked.id}/reply`, { reply })
        return asked
      }),
  }
}

const exists = (file: string) =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )

describe("tool creator", () => {
  it.live(
    "an agent's draft is only parsed until the user approves it; then it is live and its calls ask",
    () =>
      Effect.gen(function* () {
        const dir = yield* project
        const user = ide(yield* serverURL, dir)
        const marker = path.join(dir, "imported.txt")
        const session = (yield* user.post("/session", { title: "agent" })).body.id as string

        // An agent drafts a tool (the agent route is what the MCP bridge calls; tool_create is the same tool).
        const drafted = yield* user.post("/workbench/tools/agent", {
          sessionID: session,
          tool: "tool_create",
          args: { name: "hello", description: "Greets people", source: GREETER(marker) },
        })
        expect(drafted.status).toBe(200)
        expect(drafted.body.output).toContain("waiting for the human's approval")
        const [draft] = yield* user.tools()
        expect(draft).toMatchObject({
          name: "hello",
          id: "custom_hello",
          status: "draft",
          description: "Greets someone",
          args: [{ name: "name", type: "string", description: "Who to greet", required: true }],
          path: path.join(dir, ".opencode", "tool-drafts", "hello.ts"),
          createdBy: { by: "agent", sessionID: session, agent: "build" },
        })
        expect(draft.source).toBe(GREETER(marker))
        expect(yield* exists(marker)).toBe(false)
        expect(yield* user.ids()).not.toContain("custom_hello")

        // A broken draft is kept with its reason and cannot be approved; a stale review is refused.
        const broken = yield* user.post("/workbench/tools", {
          name: "broken",
          description: "never compiles",
          source: "export default tool({ description: 'x',",
        })
        expect(broken.body).toMatchObject({ status: "invalid", createdBy: { by: "user" } })
        expect(broken.body.reason).toStartWith("it does not compile:")
        expect((yield* user.post("/workbench/tools/broken/approve", { hash: broken.body.hash })).status).toBe(400)
        expect((yield* user.post("/workbench/tools/hello/approve", { hash: "0".repeat(64) })).status).toBe(409)
        expect(yield* exists(marker)).toBe(false)

        // Approved: the file is an ordinary custom tool, loaded once, and live without a restart.
        const approved = yield* user.post("/workbench/tools/hello/approve", { hash: draft.hash })
        expect(approved.status).toBe(200)
        expect(approved.body).toMatchObject({
          status: "enabled",
          path: path.join(dir, ".opencode", "tool", "custom_hello.ts"),
          inputSchema: { properties: { name: { type: "string", description: "Who to greet" } } },
        })
        expect(yield* exists(marker)).toBe(true)
        expect(yield* exists(draft.path)).toBe(false)
        expect(yield* user.ids()).toContain("custom_hello")
        // The name is taken until the tool is deleted.
        const again = yield* user.post("/workbench/tools", { name: "hello", description: "", source: draft.source })
        expect(again.status).toBe(409)

        // An agent's call asks in its session; once allowed, it runs.
        const calling = yield* user
          .post("/workbench/tools/agent", { sessionID: session, tool: "custom_hello", args: { name: "Ada" } })
          .pipe(Effect.forkChild)
        const asked = yield* user.answer("custom_hello", "once")
        expect(asked).toMatchObject({ sessionID: session, metadata: { args: { name: "Ada" } } })
        expect((yield* Fiber.join(calling)).body).toMatchObject({ output: "hello Ada" })
        // Arguments are checked against the tool's schema first.
        expect(
          (yield* user.post("/workbench/tools/agent", { sessionID: session, tool: "custom_hello", args: { name: 1 } }))
            .status,
        ).toBe(400)

        // The user's test run does not ask.
        const ran = yield* user.post("/workbench/tools/hello/run", { args: { name: "Bob" } })
        expect(ran.body).toMatchObject({ output: "hello Bob" })

        // Disabled: out of the registry; enabling needs the reviewed source again.
        const disabled = yield* user.post("/workbench/tools/hello/disable")
        expect(disabled.body).toMatchObject({ status: "disabled", path: `${approved.body.path}.disabled` })
        expect(yield* user.ids()).not.toContain("custom_hello")
        expect((yield* user.post("/workbench/tools/hello/run", { args: { name: "Bob" } })).status).toBe(404)
        expect((yield* user.post("/workbench/tools/hello/enable", { hash: "0".repeat(64) })).status).toBe(409)
        const enabled = yield* user.post("/workbench/tools/hello/enable", { hash: disabled.body.hash })
        expect(enabled.body.status).toBe("enabled")
        expect(yield* user.ids()).toContain("custom_hello")

        // Deleted: gone from the folder, the list and the registry.
        expect((yield* user.request("/workbench/tools/hello", { method: "DELETE" })).body).toBe(true)
        expect((yield* user.tools()).map((tool) => tool.name)).toEqual(["broken"])
        expect(yield* user.ids()).not.toContain("custom_hello")
      }),
    60_000,
  )

  it.live("rejecting a draft deletes it", () =>
    Effect.gen(function* () {
      const dir = yield* project
      const user = ide(yield* serverURL, dir)
      const draft = yield* user.post("/workbench/tools", {
        name: "scratch",
        description: "a draft the user turns down",
        source: GREETER(path.join(dir, "imported.txt")),
      })
      expect(draft.body.status).toBe("draft")
      expect((yield* user.post("/workbench/tools/scratch/reject")).body).toBe(true)
      expect(yield* exists(draft.body.path)).toBe(false)
      expect(yield* user.tools()).toEqual([])
      expect((yield* user.post("/workbench/tools/scratch/reject")).status).toBe(404)
    }),
  )

  it.live(
    "the MCP bridge drafts with tool_create, lists enabled tools with their schema, and calls them with the ask",
    () =>
      Effect.gen(function* () {
        const dir = yield* project
        const url = yield* serverURL
        const user = ide(url, dir)
        const mcp = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const [client, server] = InMemoryTransport.createLinkedPair()
            await WorkbenchBridge.create({ url, directory: dir }, WorkbenchToolsBridge.tools()).connect(server)
            const mcp = new Client({ name: "workbench-tools-test", version: "1.0.0" })
            await mcp.connect(client)
            return mcp
          }),
          (mcp) => Effect.promise(() => mcp.close()),
        )
        const names = () =>
          Effect.promise(() => mcp.listTools()).pipe(Effect.map((listed) => listed.tools.map((tool) => tool.name)))
        const call = (name: string, args: Record<string, unknown>) =>
          Effect.promise(() => mcp.callTool({ name, arguments: args }) as Promise<CallToolResult>)
        const text = (result: CallToolResult) =>
          result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")

        expect(yield* names()).toEqual(["workbench_problems", "workbench_check", "workbench_doctor", "tool_create"])
        const created = yield* call("tool_create", {
          name: "greet",
          description: "Greets people",
          source: GREETER(path.join(dir, "imported.txt")),
        })
        expect(text(created)).toContain("waiting for the human's approval")
        const [draft] = yield* user.tools()
        const owner = yield* user.request(`/session/${draft.createdBy.sessionID}`)
        expect(owner.body.title).toBe("Workbench MCP")
        // Approval is the user's, in the IDE: there is no MCP tool for it.
        expect((yield* names()).some((name) => /approve|enable|reject/.test(name))).toBe(false)
        yield* user.post("/workbench/tools/greet/approve", { hash: draft.hash })

        const listed = (yield* Effect.promise(() => mcp.listTools())).tools.find((tool) => tool.name === "custom_greet")
        expect(listed).toMatchObject({
          description: "Greets someone",
          inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } } },
        })
        const calling = yield* call("custom_greet", { name: "Ada" }).pipe(Effect.forkChild)
        expect((yield* user.answer("custom_greet", "once")).sessionID).toBe(draft.createdBy.sessionID!)
        expect(text(yield* Fiber.join(calling))).toBe("hello Ada")
        const refused = yield* call("custom_greet", { name: "Eve" }).pipe(Effect.forkChild)
        yield* user.answer("custom_greet", "reject")
        const result = yield* Fiber.join(refused)
        expect(result.isError).toBe(true)
        expect(text(result)).toContain("permission denied in the IDE")

        yield* user.post("/workbench/tools/greet/disable")
        expect(yield* names()).not.toContain("custom_greet")
      }),
    60_000,
  )
})
