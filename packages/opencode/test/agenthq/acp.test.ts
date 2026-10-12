// AHQ-08: the ACP adapter against a real ACP agent, `opencode acp` from this tree, driven only through the
// Agent HQ HTTP routes. The agent talks to the fake model server, so no tokens are spent, and runs with its
// own HOME/XDG directories.
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

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
    httpApiLayer,
  ),
)

const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")

type Envelope = AgentHQ.AgentEventEnvelope
type EventOf<T extends AgentHQ.AgentEvent["type"]> = Extract<AgentHQ.AgentEvent, { type: T }>
const ofType = <T extends AgentHQ.AgentEvent["type"]>(list: readonly Envelope[], type: T) =>
  list.flatMap((item) => (item.event.type === type ? [item.event as EventOf<T>] : []))

/** A launcher script for `opencode acp` with isolated HOME/XDG dirs and the fake model as its only provider. */
const launcher = (llmUrl: string) =>
  Effect.gen(function* () {
    const home = yield* tmpdirScoped()
    const config = { ...testProviderConfig(llmUrl), model: "test/test-model", permission: { bash: "ask" } }
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
    "AHQ-08 ACP adapter against opencode acp: prompt, stream, permission via the route, cancel, process gone",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ git: true })
        const script = yield* launcher(llm.url)
        const call = (route: string, init?: RequestInit) =>
          Effect.gen(function* () {
            const response = yield* requestInDirectory(route, dir, init)
            return { status: response.status, body: JSON.parse(yield* response.text) as unknown }
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

        // Prompt → streamed reply with a tool that the agent must ask about.
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
        expect(ofType(after.history, "turn.completed")).toHaveLength(1)

        // Removing the identity ends the agent's whole process group.
        expect((yield* call(`/agenthq/agents/${agentID}`, { method: "DELETE" })).body).toBe(true)
        yield* pollWithTimeout(
          running.pipe(Effect.map((pids) => (pids === "" ? true : undefined))),
          "the ACP agent process survived its identity",
          "10 seconds",
        )
      }),
    120_000,
  )
})
