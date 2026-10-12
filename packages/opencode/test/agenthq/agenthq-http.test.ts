import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
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
    httpApiLayer,
  ),
)

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("agenthq http", () => {
  it.live("routes map domain errors to the documented status codes and bodies", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const call = (path: string, init?: RequestInit) =>
        Effect.gen(function* () {
          const response = yield* requestInDirectory(path, dir, init)
          return { status: response.status, body: JSON.parse(yield* response.text) as unknown }
        })

      // projectDirectory defaults to the directory the request is routed to.
      const created = yield* call(
        "/agenthq/agents",
        json("POST", { name: "Cod", avatar: { kind: "initials", value: "C" }, provider: "codex" }),
      )
      expect(created.status).toBe(200)
      expect(created.body).toMatchObject({ name: "Cod", provider: "codex", projectDirectory: dir })
      const agentID = (created.body as { id: string }).id

      expect(
        yield* call(
          "/agenthq/agents",
          json("POST", {
            name: "X",
            avatar: { kind: "preset", value: "fox" },
            provider: "opencode",
            projectDirectory: "rel",
          }),
        ),
      ).toEqual({
        status: 400,
        body: { _tag: "InvalidRequestError", message: "projectDirectory must be absolute: rel" },
      })
      expect(yield* call(`/agenthq/agents/${agentID}/sessions`, json("POST", {}))).toEqual({
        status: 409,
        body: { _tag: "ConflictError", message: "Codex sessions are not supported by Agent HQ yet", resource: "codex" },
      })
      expect(yield* call("/agenthq/sessions/ags_missing")).toEqual({
        status: 404,
        body: { name: "NotFoundError", data: { message: "Agent session not found: ags_missing" } },
      })
      expect((yield* call("/agenthq/sessions/ags_missing/messages", json("POST", { text: " " }))).status).toBe(400)

      expect((yield* call(`/agenthq/agents/${agentID}`, { method: "DELETE" })).body).toBe(true)
      expect((yield* call(`/agenthq/agents/${agentID}`, { method: "DELETE" })).status).toBe(404)
    }),
  )
})
