// A real opencode server (in process) with a scripted model, driven through the routes the app uses: for the
// permission tests that need a session's real turn (auto-approve, saved approvals, harmless commands).
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Layer } from "effect"
import path from "path"
import { resetDatabase } from "../../fixture/db"
import { tmpdirScoped } from "../../fixture/fixture"
import { pollWithTimeout } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

export const layer = Layer.mergeAll(
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.promise(() => resetDatabase()),
      () => Effect.promise(() => resetDatabase()),
    ),
  ),
  LayerNode.compile(FSUtil.node),
  LayerNode.compile(CrossSpawnSpawner.node),
  TestLLMServer.layer,
  httpApiLayer,
)

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

// The routes the app uses, against one project directory.
export const harness = Effect.fn("harness")(function* (config: Partial<ConfigV1.Info> = {}) {
  const llm = yield* TestLLMServer
  yield* llm.reset
  const dir = yield* tmpdirScoped({ git: true, config: { ...testProviderConfig(llm.url), ...config } })
  const call = <T = unknown>(route: string, init?: RequestInit) =>
    Effect.gen(function* () {
      const response = yield* requestInDirectory(route, dir, init)
      const text = yield* response.text
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
    })
  const read = (name: string) =>
    Effect.promise(() =>
      Bun.file(path.join(dir, name))
        .text()
        .catch(() => undefined),
    )
  // Turns run a real server and processes; give them longer than the default 5s when the machine is busy.
  const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>, message: string) =>
    pollWithTimeout(effect, message, "30 seconds")
  const until = <E, R>(effect: Effect.Effect<boolean, E, R>, message: string) =>
    wait(effect.pipe(Effect.map((done) => (done ? true : undefined))), message)
  const pending = (sessionID: string) =>
    call<PermissionV1.Request[]>("/permission").pipe(
      Effect.map((result) => result.body.filter((item) => item.sessionID === sessionID)),
    )
  const asked = (sessionID: string, message: string) =>
    wait(pending(sessionID).pipe(Effect.map((list) => list[0])), message)
  const idle = (sessionID: string) =>
    until(
      call<Record<string, { type: string }>>("/session/status").pipe(
        Effect.map((result) => (result.body[sessionID]?.type ?? "idle") === "idle"),
      ),
      "the turn never finished",
    )
  const turn = (sessionID: string, text: string, agent = "build") =>
    call(
      `/session/${sessionID}/prompt_async`,
      json("POST", {
        agent,
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text }],
      }),
    )
  const create = call<{ id: string }>("/session", json("POST", {})).pipe(Effect.map((result) => result.body.id))
  // The session's tool calls so far: name, state and what came back.
  const tools = (sessionID: string) =>
    call<{ parts: { type: string; tool?: string; state?: { status: string; output?: string; error?: string } }[] }[]>(
      `/session/${sessionID}/message`,
    ).pipe(
      Effect.map((result) =>
        result.body.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.state
              ? [{ tool: part.tool!, status: part.state.status, text: part.state.output ?? part.state.error ?? "" }]
              : [],
          ),
        ),
      ),
    )
  return { llm, dir, call, read, wait, until, pending, asked, idle, turn, create, tools }
})
