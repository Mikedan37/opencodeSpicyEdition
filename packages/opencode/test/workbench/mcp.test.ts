import { describe, expect } from "bun:test"
import path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { WorkbenchBridge } from "@/workbench/mcp/bridge"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { write, zoo } from "../fixture/workbench/zoo"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "../server/httpapi-layer"

// The bridge runs against the real opencode routes served on a local port; an MCP SDK client drives it.
const it = testEffect(
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.promise(() => resetDatabase()),
        () => Effect.promise(() => resetDatabase()),
      ),
    ),
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    httpApiLayer,
  ),
)
// Real-toolchain tests skip when the tool is missing; the test name says which tool.
const needs = (...tools: string[]) => (tools.every((tool) => which(tool)) ? it.live : it.live.skip)

const serverURL = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  if (server.address._tag !== "TcpAddress") throw new Error("the test server should listen on TCP")
  return `http://127.0.0.1:${server.address.port}`
})

const connect = (connection: WorkbenchBridge.Connection) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const [client, server] = InMemoryTransport.createLinkedPair()
      await WorkbenchBridge.create(connection).connect(server)
      const mcp = new Client({ name: "workbench-test", version: "1.0.0" })
      await mcp.connect(client)
      return mcp
    }),
    (mcp) => Effect.promise(() => mcp.close()),
  )

const call = (mcp: Client, name: string, args: Record<string, unknown> = {}) =>
  Effect.promise(() => mcp.callTool({ name, arguments: args }) as Promise<CallToolResult>)

const text = (result: CallToolResult) =>
  result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")

describe("workbench MCP bridge", () => {
  it.live("lists the workbench tools with their input schemas", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })
      const listed = yield* Effect.promise(() => mcp.listTools())
      expect(listed.tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([
        ["workbench_problems", true],
        ["workbench_check", false],
        ["workbench_doctor", true],
      ])
      expect(Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.inputSchema]))).toEqual({
        workbench_problems: {
          type: "object",
          properties: {
            severity: {
              type: "string",
              enum: ["error", "warning", "info", "hint"],
              description: "Only problems of this severity",
            },
            source: {
              type: "string",
              enum: ["lsp", "compiler", "typecheck", "linter", "build", "test", "runtime"],
              description: "Only problems from this kind of producer",
            },
            file: {
              type: "string",
              description: "Only problems in this file (absolute, or relative to the project)",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              description: "How many problems to list (default 50)",
            },
          },
        },
        workbench_check: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "Files to check, absolute or relative to the project",
            },
            unit: { type: "string", description: "A folder (its source files, at most 200) or one file" },
            tests: {
              type: "boolean",
              description: "Also run the affected packages' tests (they run project code, so they need verify.exec)",
            },
          },
        },
        workbench_doctor: { type: "object", properties: {} },
      })
    }),
  )

  needs("clang")("[clang] workbench_check runs inert checks and reports what failed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => write(dir, zoo["link-c"]))
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })

      const checked = yield* call(mcp, "workbench_check", { files: ["main.c"] })
      expect(checked.isError).toBeFalsy()
      expect(text(checked)).toContain("0 passed, 1 failed")
      expect(text(checked)).toContain("(no file) error link [clang] Undefined symbols")
      expect(text(checked)).toContain("failed  clang  .  exit 1")
      expect(checked.structuredContent).toMatchObject({ report: { trigger: "agent" } })

      const problems = yield* call(mcp, "workbench_problems", { severity: "error" })
      expect(text(problems)).toStartWith("1 errors, 0 warnings, 0 info, 0 hints")
      expect(text(problems)).toContain("error link [clang]")
    }),
  )

  needs("cargo")("[cargo] checks that run project code are skipped for agents until the IDE approves", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => write(dir, zoo["rust-build"]))
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })
      const checked = yield* call(mcp, "workbench_check", { files: ["src/main.rs"] })
      expect(text(checked)).toContain("0 passed, 0 failed, 0 timed out, 1 skipped")
      expect(text(checked)).toContain("skipped  cargo  .  needs approval in the IDE")
    }),
  )

  it.live("VER-07 a repository check command is skipped for agents until the IDE approves", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({
        git: true,
        config: {
          workbench: {
            checks: {
              lint: { command: [process.execPath, "-e", "process.exit(1)"], files: ["*.txt"], format: "plain" },
            },
          },
        },
      })
      yield* Effect.promise(() => write(dir, { "a.txt": "a\n" }))
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })
      const checked = yield* call(mcp, "workbench_check", { files: ["a.txt"] })
      expect(text(checked)).toContain("skipped  lint  .  needs approval in the IDE")
    }),
  )

  it.live("rejects arguments it does not know, so a model cannot pick its own trigger", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })
      const result = yield* call(mcp, "workbench_check", { files: [], trigger: "user" })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain("Invalid arguments for workbench_check")
    }),
  )

  it.live("workbench_doctor returns the doctor table", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const mcp = yield* connect({ url: yield* serverURL, directory: dir })
      const result = yield* call(mcp, "workbench_doctor")
      expect(text(result)).toStartWith("LANG")
      expect(result.structuredContent).toMatchObject({ languages: expect.any(Array) })
    }),
  )

  it.live("an unreachable server is a tool error with the reason", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const mcp = yield* connect({ url: "http://127.0.0.1:1", directory: dir })
      const result = yield* call(mcp, "workbench_problems")
      expect(result.isError).toBe(true)
      expect(text(result)).toContain("The opencode server at http://127.0.0.1:1 is not reachable")
    }),
  )

  it.live("sends the project directory and basic-auth credentials", () =>
    Effect.gen(function* () {
      const seen: Headers[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              seen.push(request.headers)
              return Response.json({ problems: [], counts: { error: 0, warning: 0, info: 0, hint: 0 }, producers: [] })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const mcp = yield* connect({
        url: `http://127.0.0.1:${server.port}`,
        directory: "/projects/demo",
        username: "ide",
        password: "secret",
      })
      expect(text(yield* call(mcp, "workbench_problems"))).toStartWith("0 errors")
      expect(seen[0].get("x-opencode-directory")).toBe("/projects/demo")
      expect(seen[0].get("authorization")).toBe(`Basic ${Buffer.from("ide:secret").toString("base64")}`)
    }),
  )

  it.live(
    "opencode workbench mcp serves the tools on stdio",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const url = yield* serverURL
        const mcp = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const client = new Client({ name: "workbench-stdio-test", version: "1.0.0" })
            await client.connect(
              new StdioClientTransport({
                command: process.execPath,
                args: [
                  "run",
                  path.join(__dirname, "../../src/index.ts"),
                  "workbench",
                  "mcp",
                  "--url",
                  url,
                  "--directory",
                  dir,
                ],
                env: Object.fromEntries(
                  Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
                ),
                stderr: "ignore",
              }),
            )
            return client
          }),
          (client) => Effect.promise(() => client.close()),
        )
        const listed = yield* Effect.promise(() => mcp.listTools())
        // spicy: the CLI also serves the debug_* tools (dap); test/workbench/mcp-debug.test.ts covers them
        const names = listed.tools.map((tool) => tool.name)
        expect(names.filter((name) => !name.startsWith("debug_"))).toEqual([
          "workbench_problems",
          "workbench_check",
          "workbench_doctor",
        ])
        expect(names).toContain("debug_start")
        const problems = yield* call(mcp, "workbench_problems")
        expect(problems.isError).toBeFalsy()
        expect(text(problems)).toStartWith("0 errors")
      }),
    60_000,
  )
})
