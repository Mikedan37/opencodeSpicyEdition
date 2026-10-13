import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Layer } from "effect"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

// The main chat asks before edits and bash; PUT /workbench/sessions/:id/auto-approve lets them run without asking in
// that session only. Real server routes and permission flow, fake model.
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
    TestLLMServer.layer,
    httpApiLayer,
  ),
)

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

// The routes the app uses, against one project directory.
const harness = Effect.fn("harness")(function* () {
  const llm = yield* TestLLMServer
  yield* llm.reset
  const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
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
  const turn = (sessionID: string, text: string) =>
    call(
      `/session/${sessionID}/prompt_async`,
      json("POST", {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text }],
      }),
    )
  const create = call<{ id: string }>("/session", json("POST", {})).pipe(Effect.map((result) => result.body.id))
  return { llm, dir, call, read, wait, until, pending, asked, idle, turn, create }
})

describe("main chat permissions", () => {
  it.live("an edit waits for the human; with auto-approve on, that session's edits and bash run without asking", () =>
    Effect.gen(function* () {
      const { llm, call, read, until, pending, asked: waitAsk, idle, turn, create } = yield* harness()
      // Both switches together, as the composer turns them on.
      const autoApprove = (sessionID: string, enabled?: boolean) =>
        call<{ edits: boolean; commands: boolean }>(
          `/workbench/sessions/${sessionID}/auto-approve`,
          enabled === undefined ? undefined : json("PUT", { edits: enabled, commands: enabled }),
        ).pipe(Effect.map((result) => result.body.edits && result.body.commands))

      // The build agent asks before an edit, and nothing is written until the human answers.
      const session = yield* create
      yield* llm.tool("write", { filePath: "a.txt", content: "one\n" })
      yield* llm.text("done")
      yield* turn(session, "write a.txt")
      const asked = yield* waitAsk(session, "the edit never asked")
      expect(asked.permission).toBe("edit")
      expect(yield* read("a.txt")).toBeUndefined()
      expect((yield* call(`/permission/${asked.id}/reply`, json("POST", { reply: "once" }))).status).toBe(200)
      yield* until(read("a.txt").pipe(Effect.map((text) => text === "one\n")), "the approved edit never applied")
      yield* idle(session)

      // Auto-approve on: the next edit and a shell command run without asking.
      expect(yield* autoApprove(session)).toBe(false)
      expect(yield* autoApprove(session, true)).toBe(true)
      expect(yield* autoApprove(session)).toBe(true)
      yield* llm.tool("write", { filePath: "a.txt", content: "two\n" })
      yield* llm.tool("bash", { command: "printf ran > b.txt", description: "Write b.txt" })
      yield* llm.text("done")
      yield* turn(session, "write a.txt again and run a command")
      yield* until(read("b.txt").pipe(Effect.map((text) => text === "ran")), "the auto-approved turn never ran bash")
      yield* idle(session)
      expect(yield* read("a.txt")).toBe("two\n")
      expect(yield* pending(session)).toEqual([])

      // Another session still asks.
      const other = yield* create
      yield* llm.tool("write", { filePath: "c.txt", content: "other\n" })
      yield* llm.text("done")
      yield* turn(other, "write c.txt")
      const otherAsk = yield* waitAsk(other, "the other session's edit never asked")
      expect(otherAsk.permission).toBe("edit")
      yield* call(`/permission/${otherAsk.id}/reply`, json("POST", { reply: "reject" }))
      yield* idle(other)
      expect(yield* read("c.txt")).toBeUndefined()

      // Off again.
      expect(yield* autoApprove(session, false)).toBe(false)
      expect((yield* call(`/workbench/sessions/ses_missing/auto-approve`)).status).toBe(404)
    }),
  )

  it.live(
    '"Always allow in this project" answers the ask, then the project\'s other sessions skip it until removed',
    () =>
      Effect.gen(function* () {
        const { llm, call, read, until, asked, idle, turn, create } = yield* harness()
        type Rules = { rules: { permission: string; pattern: string }[] }
        const rule = { permission: "edit", pattern: "*" }

        const first = yield* create
        yield* llm.tool("write", { filePath: "a.txt", content: "one\n" })
        yield* llm.text("done")
        yield* turn(first, "write a.txt")
        const ask = yield* asked(first, "the edit never asked")
        const saved = yield* call<Rules>(`/workbench/permissions/${ask.id}/save`, { method: "POST" })
        expect(saved).toEqual({ status: 200, body: { rules: [rule] } })
        yield* until(read("a.txt").pipe(Effect.map((text) => text === "one\n")), "the saved ask never ran")
        yield* idle(first)
        // It is no longer pending, so saving it again is a 404.
        expect((yield* call(`/workbench/permissions/${ask.id}/save`, { method: "POST" })).status).toBe(404)

        // Another session of the project edits without asking.
        const second = yield* create
        yield* llm.tool("write", { filePath: "b.txt", content: "two\n" })
        yield* llm.text("done")
        yield* turn(second, "write b.txt")
        yield* until(read("b.txt").pipe(Effect.map((text) => text === "two\n")), "the saved rule did not apply")
        yield* idle(second)
        expect((yield* call<Rules>("/workbench/approvals")).body).toEqual({ rules: [rule] })

        // Removed: the next edit asks again.
        expect((yield* call<Rules>("/workbench/approvals", json("DELETE", rule))).body).toEqual({ rules: [] })
        yield* llm.tool("write", { filePath: "c.txt", content: "three\n" })
        yield* llm.text("done")
        yield* turn(second, "write c.txt")
        const again = yield* asked(second, "the removed rule still applied")
        yield* call(`/permission/${again.id}/reply`, json("POST", { reply: "reject" }))
        yield* idle(second)
        expect(yield* read("c.txt")).toBeUndefined()
      }),
  )
})
