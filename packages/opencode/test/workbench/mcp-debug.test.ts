// The Workbench MCP bridge's debug_* tools against the real opencode routes (served on a local port) and real
// debugpy. Every launch, attach and evaluate is asked in opencode: the test plays the user and answers through the
// permission routes. Python fixtures end normally; none of them crash Python.
import { describe, expect } from "bun:test"
import path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Fiber, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Debugpy } from "@/workbench/dap/adapters/debugpy"
import { WorkbenchBridge } from "@/workbench/mcp/bridge"
import { WorkbenchDebugBridge } from "@/workbench/mcp/debug"
import { Parameters } from "@/workbench/tool/debug"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer } from "../server/httpapi-layer"

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
const found = await Debugpy.resolve({ directory: process.cwd() })
const reason = "error" in found ? found.error : undefined
const real = reason ? it.live.skip : it.live
const name = (title: string) => (reason ? `${title} [skipped: ${reason}]` : title)

const AVG = `def average(xs):
    total = sum(xs)
    return total / len(xs)


orders = {"alice": [10, 20], "bob": []}
for name, xs in orders.items():
    print(name, average(xs))
`

const serverURL = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  if (server.address._tag !== "TcpAddress") throw new Error("the test server should listen on TCP")
  return `http://127.0.0.1:${server.address.port}`
})

const connect = (connection: WorkbenchBridge.Connection) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const [client, server] = InMemoryTransport.createLinkedPair()
      await WorkbenchBridge.create(connection, WorkbenchDebugBridge.tools()).connect(server)
      const mcp = new Client({ name: "workbench-debug-test", version: "1.0.0" })
      await mcp.connect(client)
      return mcp
    }),
    (mcp) => Effect.promise(() => mcp.close()),
  )

const call = (mcp: Client, tool: string, args: Record<string, unknown> = {}) =>
  Effect.promise(() => mcp.callTool({ name: tool, arguments: args }) as Promise<CallToolResult>)

const text = (result: CallToolResult) =>
  result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")

// The user's side of the IDE: the opencode routes the app uses.
const ide = (url: string, directory: string) => {
  const request = (route: string, init: RequestInit = {}) =>
    Effect.promise(async () => {
      const response = await fetch(new URL(route, url), {
        ...init,
        headers: { "x-opencode-directory": directory, "content-type": "application/json", ...init.headers },
      })
      return { status: response.status, body: (await response.json()) as any }
    })
  return {
    request,
    /** Waits for the bridge's permission request and answers it like the user would. */
    answer: (permission: string, reply: "once" | "always" | "reject") =>
      Effect.gen(function* () {
        const asked = yield* pollWithTimeout(
          request("/permission").pipe(
            Effect.map((result) =>
              (result.body as { id: string; permission: string; sessionID: string }[]).find(
                (item) => item.permission === permission,
              ),
            ),
          ),
          `no ${permission} request`,
          "10 seconds",
        )
        yield* request(`/permission/${asked.id}/reply`, { method: "POST", body: JSON.stringify({ reply }) })
        return asked
      }),
  }
}

describe("workbench MCP bridge: debug tools", () => {
  it.live("lists one debug_* tool per action with the in-process tool's field schemas", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })
      const listed = (yield* Effect.promise(() => mcp.listTools())).tools.filter((tool) =>
        tool.name.startsWith("debug_"),
      )
      expect(listed.map((tool) => tool.name)).toEqual(
        Parameters.fields.action.literals.map((action) => `debug_${action}`),
      )
      const byName = Object.fromEntries(listed.map((tool) => [tool.name, tool]))
      // Inspection is read-only; control and evaluation are not.
      expect(listed.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual([
        "debug_inspect",
        "debug_output",
        "debug_status",
      ])
      expect(byName.debug_stop.annotations?.destructiveHint).toBe(true)
      const properties = (name: string) =>
        (byName[name].inputSchema as { properties: Record<string, unknown> }).properties
      expect(Object.keys(properties("debug_start")).toSorted()).toEqual(
        [
          "title",
          "configuration",
          "program",
          "args",
          "cwd",
          "adapter",
          "preset",
          "stopOnEntry",
          "breakpoints",
          "exceptions",
          "file",
        ].toSorted(),
      )
      expect(Object.keys(properties("debug_control"))).toEqual(["session", "command"])
      // Field descriptions reach the model (an optional() wrapper used to drop them from the JSON Schema).
      expect(properties("debug_start").program).toMatchObject({
        description: expect.stringContaining("Program to debug"),
      })
      // Every field is the in-process tool's field, as the model sees it there.
      const inProcess = (ToolJsonSchema.fromSchema(Parameters) as { properties: Record<string, unknown> }).properties
      for (const tool of listed)
        for (const [field, schema] of Object.entries(properties(tool.name))) expect(schema).toEqual(inProcess[field])
      // A model cannot choose the session the asks appear in: the field is not part of any tool, and the
      // empty debug_status schema that lets unknown keys through still forwards only its own fields.
      const forged = yield* call(mcp, "debug_control", { sessionID: "ses_forged", command: "continue" })
      expect(forged.isError).toBe(true)
      expect(text(forged)).toContain("Invalid arguments for debug_control")
      const status = yield* call(mcp, "debug_status", { sessionID: "ses_forged", action: "stop" })
      expect(status.isError).toBeFalsy()
      expect(text(status)).toBe("no debug sessions")
    }),
  )

  real(
    name("asks in opencode for launch and evaluate, records ownership and an investigation, keeps inspection open"),
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => Bun.write(path.join(dir, "avg.py"), AVG))
        const url = yield* serverURL
        const user = ide(url, dir)
        const mcp = yield* connect({ url, directory: dir })

        const starting = yield* call(mcp, "debug_start", {
          program: "avg.py",
          title: "average crashes for empty orders",
          breakpoints: [{ file: "avg.py", line: 3, condition: "len(xs) == 0" }],
        }).pipe(Effect.forkChild)
        // Nothing runs until the user answers.
        const asked = yield* user.answer("debug.launch", "once")
        const started = yield* Fiber.join(starting)
        expect(started.isError).toBeFalsy()
        expect(text(started)).toContain("· stopped · owner agent")
        expect(text(started)).toContain("at        avg.py:3 in average")
        expect(text(started)).toContain("locals    total: int = 0 · xs: list = []")
        const session = (started.structuredContent as { session: { id: string; investigationID?: string } }).session
        expect(session.investigationID).toStartWith("inv_")

        // The asks live in the bridge's own opencode session, which also owns the investigation.
        const owner = yield* user.request(`/session/${asked.sessionID}`)
        expect(owner.body.title).toBe("Workbench MCP: debugging")
        const investigations = yield* user.request("/workbench/investigations")
        expect(investigations.body).toEqual([
          expect.objectContaining({
            id: session.investigationID,
            sessionID: asked.sessionID,
            title: "average crashes for empty orders",
          }),
        ])

        // Inspection never asks; evaluation runs program code, so it does.
        expect(text(yield* call(mcp, "debug_inspect", {}))).toContain("xs: list = []")
        const evaluating = yield* call(mcp, "debug_evaluate", { expression: "len(xs), sum(xs)" }).pipe(Effect.forkChild)
        yield* user.answer("debug.evaluate", "once")
        expect(text(yield* Fiber.join(evaluating))).toContain("result: (0, 0)")

        // While the user drives, the agent may read but not control.
        yield* user.request(`/workbench/debug/sessions/${session.id}/owner`, {
          method: "POST",
          body: JSON.stringify({ owner: "human" }),
        })
        const refused = yield* call(mcp, "debug_control", { command: "continue" })
        expect(refused.isError).toBe(true)
        expect(text(refused)).toContain("controlled by the human since")
        expect(text(yield* call(mcp, "debug_inspect", { path: "xs" }))).toContain("xs: list = []")

        yield* user.request(`/workbench/debug/sessions/${session.id}/owner`, {
          method: "POST",
          body: JSON.stringify({ owner: "agent" }),
        })
        const exception = yield* call(mcp, "debug_control", { command: "continue" })
        expect(text(exception)).toContain("exception ZeroDivisionError: division by zero")
        expect(text(yield* call(mcp, "debug_output", {}))).toContain("alice 15.0")
        expect(text(yield* call(mcp, "debug_status", {}))).toContain(`investigation ${session.investigationID}`)

        const stopped = yield* call(mcp, "debug_stop", {})
        expect(text(stopped)).toContain("· terminated ·")
      }),
    60_000,
  )

  real(
    name("a rejected or denied ask stops the call and hands the investigation to the user"),
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => Bun.write(path.join(dir, "avg.py"), AVG))
        const url = yield* serverURL
        const user = ide(url, dir)
        const mcp = yield* connect({ url, directory: dir })
        const starting = yield* call(mcp, "debug_start", { program: "avg.py" }).pipe(Effect.forkChild)
        yield* user.answer("debug.launch", "reject")
        const result = yield* Fiber.join(starting)
        expect(result.isError).toBe(true)
        expect(text(result)).toContain("permission denied in the IDE")
        const sessions = yield* user.request("/workbench/debug/sessions")
        expect(sessions.body).toEqual([])
        const investigations = yield* user.request("/workbench/investigations")
        expect(investigations.body).toEqual([
          expect.objectContaining({ status: "needs_human", reason: "S7: permission denied: debug.launch" }),
        ])
      }),
    60_000,
  )
})
