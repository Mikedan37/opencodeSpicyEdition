// spicy: Workbench debug routes end to end against the scripted fake adapter (TCP via launch.json debugServer).
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Storage } from "../../src/storage/storage"
import { WorkbenchInvestigation } from "../../src/workbench/investigation/investigation"

const FAKE = path.join(import.meta.dir, "../workbench/fixture/fake-dap.ts")
const root = "/workbench/debug/sessions"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

async function fakeAdapter(directory: string, name = "fake") {
  const proc = Bun.spawn(
    [
      process.execPath,
      FAKE,
      JSON.stringify({
        profile: "debugpy",
        tcp: true,
        stops: [
          {
            reason: "breakpoint",
            line: 3,
            name: "average",
            file: path.join(directory, "app.py"),
            locals: [{ name: "xs", value: "[]", type: "list" }],
          },
          { reason: "step", line: 4, name: "average", file: path.join(directory, "app.py") },
        ],
        output: [{ category: "stdout", output: "alice 15.0\n" }],
      }),
    ],
    { stdout: "pipe" },
  )
  const chunk = await proc.stdout.getReader().read()
  const port = Number(/PORT (\d+)/.exec(new TextDecoder().decode(chunk.value))?.[1])
  const file = path.join(directory, ".vscode", "launch.json")
  const existing = await Bun.file(file)
    .json()
    .catch(() => ({ configurations: [] as object[] }))
  await Bun.write(
    file,
    JSON.stringify({
      configurations: [
        ...existing.configurations,
        { name, type: "python", request: "launch", program: "${workspaceFolder}/app.py", debugServer: port },
      ],
    }),
  )
  return proc
}

async function until<T>(read: () => Promise<T | undefined>, message: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(message)
}

describe("workbench debug HttpApi", () => {
  test("start, inspect, evaluate, complete, hand over, control, output and stop", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const adapter = await fakeAdapter(tmp.path)
    const app = Server.Default().app
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const call = (method: string, url: string, body?: object) =>
      app.request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    const events: GlobalEvent[] = []
    const listen = (event: GlobalEvent) => events.push(event)
    GlobalBus.on("event", listen)
    try {
      const started = await call("POST", root, { configuration: "fake" })
      expect(started.status).toBe(200)
      const info = (await started.json()) as { id: string; owner: string }
      expect(info.owner).toBe("human")
      const stopped = await until(async () => {
        const list = (await (await call("GET", root)).json()) as {
          id: string
          state: string
          stop?: { frames: { line: number }[] }
        }[]
        return list.find((item) => item.id === info.id && item.state === "stopped" && item.stop)
      }, "never stopped")
      expect(stopped.stop?.frames[0]?.line).toBe(3)

      const variables = await call("GET", `${root}/${info.id}/variables?ref=1000`)
      expect(await variables.json()).toEqual([{ name: "xs", type: "list", value: "[]", variablesReference: 0 }])
      const evaluated = await call("POST", `${root}/${info.id}/evaluate`, { expression: "len(xs)" })
      expect(await evaluated.json()).toMatchObject({ kind: "result", by: "human", text: "<len(xs)>" })
      const completions = await call("GET", `${root}/${info.id}/completions?text=x`)
      expect(await completions.json()).toEqual([{ label: "xs", type: "variable" }])

      const handed = await call("POST", `${root}/${info.id}/owner`, { owner: "agent" })
      expect(((await handed.json()) as { owner: string }).owner).toBe("agent")
      const refused = await call("POST", `${root}/${info.id}/control`, { action: "next" })
      expect(refused.status).toBe(409)
      expect(JSON.stringify(await refused.json())).toContain("controlled by the agent")
      await call("POST", `${root}/${info.id}/owner`, { owner: "human" })
      const stepped = await call("POST", `${root}/${info.id}/control`, { action: "next" })
      expect(stepped.status).toBe(200)

      const output = (await (await call("GET", `${root}/${info.id}/output`)).json()) as { kind: string; text: string }[]
      expect(output.some((row) => row.kind === "stdout" && row.text === "alice 15.0\n")).toBe(true)

      const ended = await call("DELETE", `${root}/${info.id}`)
      expect(((await ended.json()) as { state: string }).state).toBe("terminated")
      const missing = await call("POST", `${root}/dbg_missing/control`, { action: "next" })
      expect(missing.status).toBe(404)

      await until(
        async () => (events.some((event) => event.payload.type === "workbench.debug.output") ? true : undefined),
        "no output event",
      )
      const updates = events.filter((event) => event.payload.type === "workbench.debug.updated")
      expect(updates.length).toBeGreaterThan(0)
      expect(updates.every((event) => event.directory === tmp.path)).toBe(true)
    } finally {
      GlobalBus.off("event", listen)
      adapter.kill()
    }
  })

  test("a third live session in one project is refused", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const adapters = [
      await fakeAdapter(tmp.path, "one"),
      await fakeAdapter(tmp.path, "two"),
      await fakeAdapter(tmp.path, "three"),
    ]
    const app = Server.Default().app
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const start = (configuration: string) =>
      app.request(root, { method: "POST", headers, body: JSON.stringify({ configuration }) })
    try {
      expect((await start("one")).status).toBe(200)
      expect((await start("two")).status).toBe(200)
      const third = await start("three")
      expect(third.status).toBe(409)
      expect(JSON.stringify(await third.json())).toContain("2 debug sessions are already running")
      const invalid = await start("nope")
      expect(invalid.status).toBe(400)
    } finally {
      for (const adapter of adapters) adapter.kill()
    }
  })

  test("investigations: list, full record with report, resume relaunches the stored target, cancel stops it", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const adapter = await fakeAdapter(tmp.path)
    const app = Server.Default().app
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const call = (method: string, url: string) => app.request(url, { method, headers })
    const events: GlobalEvent[] = []
    const listen = (event: GlobalEvent) => events.push(event)
    GlobalBus.on("event", listen)
    try {
      const project = (await (await call("GET", "/project/current")).json()) as { id: string }
      const record = {
        ...WorkbenchInvestigation.create({
          projectID: project.id,
          directory: tmp.path,
          sessionID: "ses_http",
          title: "average crashes for empty orders",
          target: { configuration: "fake" },
          host: { pid: process.pid },
          now: Date.now(),
        }),
        status: "interrupted" as const,
      }
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage.Service
          yield* storage.write(["workbench", "investigation", project.id, record.id], record)
        }),
      )
      const list = (await (await call("GET", "/workbench/investigations")).json()) as { id: string; status: string }[]
      expect(list).toEqual([expect.objectContaining({ id: record.id, status: "interrupted" })])

      const resumed = await call("POST", `/workbench/investigations/${record.id}/resume`)
      expect(resumed.status).toBe(200)
      expect(((await resumed.json()) as { status: string }).status).toBe("reproducing")
      const sessions = (await (await call("GET", root)).json()) as {
        id: string
        investigationID?: string
        state: string
      }[]
      expect(sessions).toEqual([expect.objectContaining({ investigationID: record.id })])

      const full = await until(async () => {
        const body = (await (await call("GET", `/workbench/investigations/${record.id}`)).json()) as {
          investigation: { status: string }
          evidence: { kind: string }[]
          report: string
        }
        return body.evidence.some((item) => item.kind === "debug-stop") ? body : undefined
      }, "the resumed run never produced evidence")
      expect(full.investigation.status).toBe("debugging")
      expect(full.report).toContain(`Investigation ${record.id}: average crashes for empty orders`)

      const cancelled = await call("POST", `/workbench/investigations/${record.id}/cancel`)
      expect(((await cancelled.json()) as { status: string }).status).toBe("cancelled")
      await until(async () => {
        const after = (await (await call("GET", root)).json()) as { state: string }[]
        return after.every((item) => item.state === "terminated") ? true : undefined
      }, "the investigation's debug session kept running")
      const again = await call("POST", `/workbench/investigations/${record.id}/resume`)
      expect(again.status).toBe(400)
      const updates = events.filter((event) => event.payload.type === "workbench.investigation.updated")
      expect(updates.length).toBeGreaterThan(0)
      expect(updates.every((event) => event.directory === tmp.path)).toBe(true)
    } finally {
      GlobalBus.off("event", listen)
      adapter.kill()
    }
  })
})
