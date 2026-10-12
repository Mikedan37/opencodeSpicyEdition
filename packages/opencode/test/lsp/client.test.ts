import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import * as LSPServer from "@/lsp/server"

function spawnFakeServer() {
  const { spawn } = require("child_process")
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

describe("LSPClient interop", () => {
  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("initialize does not overclaim unsupported diagnostics capabilities", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const params = await client.connection.sendRequest<any>("test/get-initialize-params", {})
    // spicy: refresh is handled now (REG-01), so advertising it is not an overclaim
    expect(params.capabilities.workspace.diagnostics.refreshSupport).toBe(true)
    expect(params.processId).toBe(process.pid) // spicy: REG-10
    expect(params.capabilities.textDocument.publishDiagnostics.versionSupport).toBe(false)

    await client.shutdown()
  })

  test("workspace/configuration returns one result per requested item", async () => {
    const handle = spawnFakeServer() as any
    const initialization = {
      alpha: {
        beta: 1,
      },
      gamma: true,
    }

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: {
            ...(handle as unknown as LSPServer.Handle),
            initialization,
          },
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const response = await client.connection.sendRequest<any[]>("test/request-configuration", {
      items: [{ section: "alpha" }, { section: "alpha.beta" }, { section: "missing" }, {}],
    })

    expect(response).toEqual([{ beta: 1 }, 1, null, initialization])

    await client.shutdown()
  })

  test("sends ranged didChange for incremental sync servers", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "first\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.notify.open({ path: file })
        await Bun.write(file, "second\nthird\n")
        await client.notify.open({ path: file })

        const change = await client.connection.sendRequest<{
          textDocument: { version: number }
          contentChanges: {
            range?: { start: { line: number; character: number }; end: { line: number; character: number } }
            text: string
          }[]
        }>("test/get-last-change", {})
        expect(change.textDocument.version).toBe(1)
        expect(change.contentChanges).toEqual([
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            text: "second\nthird\n",
          },
        ])

        await client.shutdown()
      },
    })
  })

  test("document mode falls back to push diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        const wait = client.waitForDiagnostics({ path: file, version, mode: "document" })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })
        await wait

        const diagnostics = client.diagnostics.get(file) ?? []
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.message).toBe("push diagnostic")

        const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
        expect(count).toBe(0)

        await client.shutdown()
      },
    })
  })

  test("document mode accepts matching push diagnostics published before waiting", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })

        for (let i = 0; i < 20 && (client.diagnostics.get(file)?.length ?? 0) === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }

        expect(client.diagnostics.get(file)?.[0]?.message).toBe("push diagnostic")

        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "document" })
        expect(Date.now() - started).toBeLessThan(1_000)

        await client.shutdown()
      },
    })
  })

  test("document mode waits for pull diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "DocumentCompilerSemantic" }],
          documentDiagnosticsByIdentifier: {
            DocumentCompilerSemantic: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "pull diagnostic",
                severity: 1,
              },
            ],
          },
        })

        const version = await client.notify.open({ path: file })
        await client.waitForDiagnostics({ path: file, version, mode: "document" })

        const diagnostics = client.diagnostics.get(file) ?? []
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.message).toBe("pull diagnostic")

        const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
        expect(count).toBeGreaterThan(0)

        await client.shutdown()
      },
    })
  })

  test("document mode does not wait for the slowest pull identifier after current-file diagnostics arrive", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registrations: [{ identifier: "fast" }, { identifier: "slow" }],
          documentDiagnosticsByIdentifier: {
            fast: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "fast diagnostic",
                severity: 1,
              },
            ],
            slow: [],
          },
          documentDelayMsByIdentifier: {
            slow: 2_500,
          },
        })

        const version = await client.notify.open({ path: file })
        await client.connection.sendRequest("test/register-configured-pull-diagnostics", {})
        await new Promise((resolve) => setTimeout(resolve, 100))
        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "document" })

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(client.diagnostics.get(file)?.[0]?.message).toBe("fast diagnostic")
        expect(await client.connection.sendRequest("test/get-diagnostic-request-count", {})).toBeGreaterThan(1)

        await client.shutdown()
      },
    })
  })

  test("full mode includes workspace pull diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    const related = path.join(tmp.path, "other.cs")
    await Bun.write(file, "class C {}\n")
    await Bun.write(related, "class D {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [
            { identifier: "DocumentCompilerSemantic" },
            { identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true },
          ],
          documentDiagnosticsByIdentifier: {
            DocumentCompilerSemantic: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "current file",
                severity: 1,
              },
            ],
          },
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [
              {
                uri: pathToFileURL(related).href,
                items: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 5 },
                    },
                    message: "workspace file",
                    severity: 1,
                  },
                ],
              },
            ],
          },
        })

        const version = await client.notify.open({ path: file })
        await client.waitForDiagnostics({ path: file, version, mode: "full" })

        expect(client.diagnostics.get(file)?.[0]?.message).toBe("current file")
        expect(client.diagnostics.get(related)?.[0]?.message).toBe("workspace file")

        await client.shutdown()
      },
    })
  })

  test("full mode treats an empty workspace pull response as handled", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true }],
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [],
          },
        })

        const version = await client.notify.open({ path: file })
        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "full" })

        expect(Date.now() - started).toBeLessThan(1_000)

        await client.shutdown()
      },
    })
  })
})

// spicy: REG-01 / REG-02 regression tests
const errorAt = (message: string) => ({
  range: { start: { line: 0, character: 17 }, end: { line: 0, character: 24 } },
  message,
  severity: 1,
})

async function openWithSourcekitPattern(input: {
  diagnostics: ReturnType<typeof errorAt>[]
  provisionalMs: number
  mode: "document" | "full"
}) {
  const handle = spawnFakeServer() as any
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "main.swift")
  await Bun.write(file, 'let count: Int = "three"\n')
  return await withTestInstance({
    directory: tmp.path,
    fn: async (ctx) => {
      const client = await LSPClient.create({
        serverID: "fake",
        server: handle as unknown as LSPServer.Handle,
        root: tmp.path,
        directory: tmp.path,
        instance: ctx,
      })
      // Like sourcekit-lsp: register pull diagnostics on didOpen, answer an empty report until the package's
      // build settings are "loaded", then send workspace/diagnostic/refresh; never push.
      await client.connection.sendRequest("test/configure-pull-diagnostics", {
        registerOn: "didOpen",
        registrations: [{}],
        provisionalMs: input.provisionalMs,
        documentDiagnostics: input.diagnostics,
      })
      const version = await client.notify.open({ path: file })
      const started = Date.now()
      await client.waitForDiagnostics({ path: file, version, mode: input.mode })
      const result = {
        elapsed: Date.now() - started,
        diagnostics: client.diagnostics.get(file) ?? [],
        pulls: await client.connection.sendRequest<number>("test/get-diagnostic-request-count", {}),
      }
      await client.shutdown()
      return result
    },
  })
}

describe("LSPClient provisional pull reports (REG-01)", () => {
  for (const mode of ["document", "full"] as const) {
    test(`${mode} mode re-pulls after the server's refresh instead of keeping the empty first report`, async () => {
      const result = await openWithSourcekitPattern({
        diagnostics: [errorAt("Cannot convert value of type 'String' to specified type 'Int'")],
        provisionalMs: 400,
        mode,
      })
      expect(result.diagnostics.map((item) => item.message)).toEqual([
        "Cannot convert value of type 'String' to specified type 'Int'",
      ])
      expect(result.pulls).toBeGreaterThan(1)
    })
  }

  test("an empty report after the refresh is final", async () => {
    const result = await openWithSourcekitPattern({ diagnostics: [], provisionalMs: 300, mode: "document" })
    expect(result.diagnostics).toEqual([])
    expect(result.elapsed).toBeGreaterThanOrEqual(250)
    expect(result.elapsed).toBeLessThan(1_500)
  })

  test("an empty report from a static pull provider is final at once", async () => {
    const { spawn } = require("child_process")
    const handle = {
      process: spawn(process.execPath, [path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")], {
        stdio: "pipe",
        env: { ...process.env, FAKE_LSP_STATIC_PULL: "1" },
      }),
    }
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "clean.js")
    await Bun.write(file, "export {}\n")
    const elapsed = await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })
        const version = await client.notify.open({ path: file })
        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "document" })
        const result = Date.now() - started
        await client.shutdown()
        return result
      },
    })
    expect(elapsed).toBeLessThan(1_000)
  })

  test("a server that never refreshes holds an empty first report only until warm-up ends", async () => {
    const result = await openWithSourcekitPattern({ diagnostics: [], provisionalMs: 0, mode: "document" })
    expect(result.diagnostics).toEqual([])
    expect(result.elapsed).toBeLessThan(5_500)
  })
})

describe("LSPClient server death (REG-02)", () => {
  test("a server that exits during initialize fails at once with its stderr", async () => {
    const { spawn } = require("child_process")
    // Same shape as the rustup proxy for a missing component: reads the request, prints, exits 1.
    const proc = spawn(
      process.execPath,
      [
        "-e",
        `process.stdin.once("data", () => { process.stderr.write("error: Unknown binary 'rust-analyzer' in official toolchain\\n"); process.exit(1) })`,
      ],
      { stdio: "pipe" },
    )
    const started = Date.now()
    const error = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "rust",
          server: { process: proc } as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }).then(
          () => undefined,
          (err: unknown) => err,
        ),
    })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(error).toBeInstanceOf(LSPClient.InitializeError)
    expect(String((error as InstanceType<typeof LSPClient.InitializeError>).cause)).toContain(
      "exited with code 1: error: Unknown binary 'rust-analyzer' in official toolchain",
    )
  })
})
