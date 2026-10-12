// AHQ-08: the ACP adapter against a real ACP agent, `opencode acp` from this tree, driven only through the
// Agent HQ HTTP routes of a real listener with a password, the way the desktop app runs the server. The agent
// talks to the fake model server, so no tokens are spent, and runs with its own HOME/XDG directories. Agent HQ
// gives it the Workbench MCP server (`opencode workbench mcp` from this tree), which reaches the listener with
// the credentials from its environment.
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import net from "node:net"
import path from "path"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")

type Envelope = AgentHQ.AgentEventEnvelope
type EventOf<T extends AgentHQ.AgentEvent["type"]> = Extract<AgentHQ.AgentEvent, { type: T }>
const ofType = <T extends AgentHQ.AgentEvent["type"]>(list: readonly Envelope[], type: T) =>
  list.flatMap((item) => (item.event.type === type ? [item.event as EventOf<T>] : []))

const auth = { username: "opencode", password: "ahq-bridge-secret" }
const TOOLS = ["workbench_problems", "workbench_check", "workbench_doctor"].map((name) => `opencode-workbench_${name}`)

/** A real listener with a password; Agent HQ hands its URL to the Workbench bridge. */
const listener = Effect.acquireRelease(
  Effect.promise(async () => {
    const saved = {
      flag: [Flag.OPENCODE_SERVER_USERNAME, Flag.OPENCODE_SERVER_PASSWORD],
      env: [process.env.OPENCODE_SERVER_USERNAME, process.env.OPENCODE_SERVER_PASSWORD],
    }
    Flag.OPENCODE_SERVER_USERNAME = process.env.OPENCODE_SERVER_USERNAME = auth.username
    Flag.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD = auth.password
    // An explicit free port: port 0 would try 4096 first, which a developer's own opencode may be using.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo
        probe.close(() => resolve(port))
      })
    })
    return { saved, server: await Server.listen({ hostname: "127.0.0.1", port }) }
  }),
  ({ saved, server }) =>
    Effect.promise(async () => {
      await server.stop(true)
      await disposeAllInstances()
      ;[Flag.OPENCODE_SERVER_USERNAME, Flag.OPENCODE_SERVER_PASSWORD] = saved.flag
      const [username, password] = saved.env
      if (username === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = username
      if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = password
    }),
)

/** A launcher script for `opencode acp` with isolated HOME/XDG dirs and the fake model as its only provider. */
const launcher = (llmUrl: string) =>
  Effect.gen(function* () {
    const home = yield* tmpdirScoped()
    const permission = { bash: "ask", "opencode-workbench_*": "ask" }
    const config = { ...testProviderConfig(llmUrl), model: "test/test-model", permission }
    const env = {
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
    }
    const script = path.join(home, "opencode-acp")
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify(config))
      await fs.writeFile(
        script,
        [
          "#!/bin/sh",
          ...Object.entries(env).map(([key, value]) => `export ${key}='${value}'`),
          `export OPENCODE_CONFIG_CONTENT="$(cat '${path.join(home, "config.json")}')"`,
          `exec '${process.execPath}' run '${cliEntry}' acp "$@"`,
        ].join("\n"),
      )
      await fs.chmod(script, 0o755)
    })
    return script
  })

describe("agenthq acp", () => {
  it.live(
    "AHQ-08 ACP adapter against opencode acp: prompt, stream, permission via the route, Workbench tools, cancel, process gone",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const { server } = yield* listener
        const dir = yield* tmpdirScoped({ git: true })
        const script = yield* launcher(llm.url)
        const call = (route: string, init: RequestInit = {}) =>
          Effect.promise(async () => {
            const headers = new Headers(init.headers)
            headers.set("authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`)
            headers.set("x-opencode-directory", dir)
            const response = await fetch(new URL(route, server.url), { ...init, headers })
            return { status: response.status, body: JSON.parse(await response.text()) as unknown }
          })
        const post = (route: string, body: unknown) =>
          call(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        const detail = (sessionID: string) =>
          call(`/agenthq/sessions/${sessionID}`).pipe(
            Effect.map((result) => result.body as { session: AgentHQ.AgentSessionInfo; history: Envelope[] }),
          )
        const waitFor = <A>(sessionID: string, pick: (history: Envelope[]) => A | undefined, message: string) =>
          pollWithTimeout(detail(sessionID).pipe(Effect.map((item) => pick(item.history))), message, "60 seconds")
        // `--cwd <dir>` makes the agent's command line unique, so its process is easy to find.
        const running = Effect.promise(async () => {
          const found = Bun.spawnSync(["pgrep", "-f", `acp --cwd ${dir}`])
          return found.stdout.toString().trim()
        })
        // The Workbench MCP server the agent started for this session, with its full command line.
        const bridge = Effect.promise(async () => {
          const found = Bun.spawnSync(["pgrep", "-lf", `workbench mcp --url ${server.url.origin} --directory ${dir}`])
          return found.stdout.toString().trim()
        })

        // Positive control: the listener refuses a request without the password.
        const anonymous = yield* Effect.promise(() => fetch(new URL("/agenthq/agents", server.url)))
        expect(anonymous.status).toBe(401)

        const created = yield* post("/agenthq/agents", {
          name: "Relay",
          avatar: { kind: "preset", value: "robot" },
          provider: "acp",
          launch: { command: script, args: ["--cwd", dir] },
        })
        expect(created.status).toBe(200)
        const agentID = (created.body as AgentHQ.AgentIdentity).id

        const started = yield* post(`/agenthq/agents/${agentID}/sessions`, {})
        expect(started.status).toBe(200)
        const session = started.body as AgentHQ.AgentSessionInfo
        expect(session).toMatchObject({ provider: "acp", status: "idle" })
        expect(session.providerSessionID?.startsWith("ses")).toBe(true)
        expect(yield* running).not.toBe("")

        // The agent never inherits this server's credentials. Being opencode itself, it runs its own listener with a
        // password of its own: unknown to the parent, and still required.
        const pid = (yield* running).split("\n")[0]!
        const environment = Bun.spawnSync(["ps", "-E", "-ww", "-p", pid, "-o", "command="]).stdout.toString()
        const own = environment.match(/(?:^|\s)OPENCODE_SERVER_PASSWORD=(\S+)/)?.[1]
        expect(own).toMatch(/^[0-9a-f-]{36}$/)
        expect(environment).not.toContain(auth.password)
        expect(environment).not.toMatch(/(?:^|\s)OPENCODE_SERVER_USERNAME=/)
        const port = Bun.spawnSync(["lsof", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"])
          .stdout.toString()
          .match(/^n.*:(\d+)$/m)?.[1]
        expect(port).toBeDefined()
        const agentListener = (password?: string) =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}/agenthq/agents`, {
              headers: password ? { authorization: `Basic ${btoa(`opencode:${password}`)}` } : {},
            }).then((response) => response.status),
          )
        expect(yield* agentListener()).toBe(401)
        expect(yield* agentListener(auth.password)).toBe(401)
        expect(yield* agentListener(own)).toBe(200)

        // Prompt → streamed reply with a tool that the agent must ask about.
        const before = (yield* llm.hits).length
        yield* llm.push(reply().tool("bash", { command: "echo acp-permission", description: "Echo a marker" }))
        yield* llm.push(reply().text("acp ").text("done").stop())
        expect((yield* post(`/agenthq/sessions/${session.id}/messages`, { text: "run the marker" })).body).toBe(true)
        const request = yield* waitFor(
          session.id,
          (history) => ofType(history, "permission.requested")[0],
          "the ACP agent never asked for permission",
        )
        expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"])
        const waiting = yield* detail(session.id)
        expect(waiting.session).toMatchObject({ status: "needs_approval", pendingPermissions: 1 })
        expect(ofType(waiting.history, "tool").filter((event) => event.state === "completed")).toEqual([])

        const answered = yield* post(`/agenthq/sessions/${session.id}/permissions/${request.requestID}`, {
          optionID: request.options.find((option) => option.kind === "allow_once")!.id,
        })
        expect(answered.body).toBe(true)
        const history = yield* waitFor(
          session.id,
          (list) => (ofType(list, "turn.completed").length > 0 ? list : undefined),
          "the ACP turn never completed",
        )
        expect(ofType(history, "permission.resolved")).toEqual([
          { type: "permission.resolved", requestID: request.requestID, outcome: "allowed" },
        ])
        const tool = ofType(history, "tool").at(-1)
        expect(tool?.state).toBe("completed")
        expect(tool?.output).toContain("acp-permission")
        expect(ofType(history, "message").map((event) => [event.role, event.text])).toEqual([
          ["user", "run the marker"],
          ["assistant", "acp done"],
        ])
        expect(ofType(history, "turn.completed")).toEqual([{ type: "turn.completed", stopReason: "end_turn" }])
        expect((yield* detail(session.id)).session).toMatchObject({ status: "idle", pendingPermissions: 0 })

        // The model was offered the three Workbench tools.
        const asked = (yield* llm.hits)
          .slice(before)
          .find((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
        TOOLS.forEach((tool) => expect(JSON.stringify(asked?.body)).toContain(tool))

        // A Workbench tool call asks the human first, then reaches the listener through the bridge.
        yield* llm.push(reply().tool(TOOLS[0], {}))
        yield* llm.push(reply().text("no problems").stop())
        yield* post(`/agenthq/sessions/${session.id}/messages`, { text: "list the problems" })
        const ask = yield* waitFor(
          session.id,
          (list) => ofType(list, "permission.requested").find((item) => item.requestID !== request.requestID),
          "the Workbench tool call never asked for permission",
        )
        expect(
          ofType((yield* detail(session.id)).history, "tool").filter((item) => item.state === "completed"),
        ).toHaveLength(1)
        yield* post(`/agenthq/sessions/${session.id}/permissions/${ask.requestID}`, {
          optionID: ask.options.find((option) => option.kind === "allow_once")!.id,
        })
        const checked = yield* waitFor(
          session.id,
          (list) => (ofType(list, "turn.completed").length > 1 ? list : undefined),
          "the Workbench turn never completed",
        )
        // The bridge's summary of the listener's problems: its URL and credentials worked.
        const problems = ofType(checked, "tool").filter((item) => item.title === TOOLS[0])
        expect(problems.at(-1)?.state).toBe("completed")
        expect(problems.at(-1)?.output).toMatch(/^\d+ errors, \d+ warnings, \d+ info, \d+ hints/)
        const command = yield* bridge
        expect(command).toContain(`--directory ${dir}`)
        expect(command).not.toContain(auth.password)

        // Cancel a turn that would never end on its own.
        const calls = (yield* llm.hits).length
        yield* llm.push(reply().hang())
        yield* post(`/agenthq/sessions/${session.id}/messages`, { text: "wait forever" })
        yield* pollWithTimeout(
          llm.hits.pipe(
            Effect.map((hits) =>
              hits.slice(calls).some((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
                ? true
                : undefined,
            ),
          ),
          "the hanging turn never reached the model",
          "30 seconds",
        )
        const cancelled = yield* post(`/agenthq/sessions/${session.id}/cancel`, {})
        expect((cancelled.body as AgentHQ.AgentSessionInfo).status).toBe("cancelled")
        yield* Effect.sleep("500 millis")
        const after = yield* detail(session.id)
        expect(after.session.status).toBe("cancelled")
        expect(ofType(after.history, "turn.completed")).toHaveLength(2)

        // Removing the identity ends the agent's whole process group.
        expect((yield* call(`/agenthq/agents/${agentID}`, { method: "DELETE" })).body).toBe(true)
        yield* pollWithTimeout(
          running.pipe(Effect.map((pids) => (pids === "" ? true : undefined))),
          "the ACP agent process survived its identity",
          "10 seconds",
        )
        yield* pollWithTimeout(
          bridge.pipe(Effect.map((pids) => (pids === "" ? true : undefined))),
          "the Workbench bridge survived its agent",
          "10 seconds",
        )
      }),
    120_000,
  )
})
