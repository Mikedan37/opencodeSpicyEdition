import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Deferred, Effect, Exit, Layer, Schema, Scope } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentDetect } from "../../src/agenthq/providers/detect"
import { guard } from "../../src/agenthq/providers/opencode"
import { AgentRegistry } from "../../src/agenthq/registry"
import { AgentSessions } from "../../src/agenthq/session"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Storage } from "../../src/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

// The Agent HQ services plus what the tests inspect, wired like the server wires them (the session
// projector writes opencode session rows).
const nodes = LayerNode.group([
  AgentRegistry.node,
  AgentSessions.node,
  SessionProjector.node,
  SessionStatus.node,
  InstanceStore.node,
  Storage.node,
  Database.node,
  EventV2.node,
  AppProcess.node,
  CrossSpawnSpawner.node,
])
const replacements: LayerNode.Replacements = [
  [InstanceStore.bootstrapNode, noopBootstrap],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
]
const app = AppNodeBuilder.build(nodes, replacements)

const it = testEffect(Layer.mergeAll(app, TestLLMServer.layer))

// A separate server lifetime: every service is fresh except the session database, which tests keep in
// memory (OPENCODE_DB=:memory:) and which stands in for the on-disk database a real restart keeps.
const boot = Effect.gen(function* () {
  const database = yield* Database.Service
  const scope = yield* Scope.make()
  const layer = AppNodeBuilder.build(nodes, [
    ...replacements,
    [Database.node, Layer.succeed(Database.Service, database)],
  ])
  const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope)
  return { scope, run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(context)) }
})

const fakeModel = (url: string) => ({
  model: "test/test-model",
  small_model: "test/test-model",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

type Envelope = AgentHQ.AgentEventEnvelope
type EventOf<T extends AgentHQ.AgentEvent["type"]> = Extract<AgentHQ.AgentEvent, { type: T }>

const project = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  yield* llm.reset
  const dir = yield* tmpdirScoped({ git: true, config: fakeModel(llm.url) })
  return { llm, dir }
})

const createAgent = (dir: string, name = "Fox") =>
  Effect.gen(function* () {
    const registry = yield* AgentRegistry.Service
    return yield* registry.create({
      name,
      avatar: { kind: "preset", value: "fox" },
      provider: "opencode",
      projectDirectory: dir,
    })
  })

/** Every agenthq.* event published on the bus, in order. */
const capture = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const seen: EventV2.Payload[] = []
  const off = yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type.startsWith("agenthq.")) seen.push(event)
    }),
  )
  yield* Effect.addFinalizer(() => off)
  return seen
})

const envelopes = (seen: EventV2.Payload[], sessionID: string) =>
  seen.flatMap((event) => {
    if (event.type !== AgentHQ.Event.SessionEvent.type) return []
    const envelope = (event.data as { envelope: Envelope }).envelope
    return envelope.sessionID === sessionID ? [envelope] : []
  })

const ofType = <T extends AgentHQ.AgentEvent["type"]>(list: readonly Envelope[], type: T) =>
  list.flatMap((item) => (item.event.type === type ? [item.event as EventOf<T>] : []))

const waitHistory = <A>(
  sessionID: AgentHQ.AgentSessionID,
  pick: (history: readonly Envelope[], session: AgentHQ.AgentSessionInfo) => A | undefined,
  message: string,
) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const sessions = yield* AgentSessions.Service
      const detail = yield* sessions.get(sessionID)
      return pick(detail.history, detail.session)
    }),
    message,
    "20 seconds",
  )

const turnCompleted = (sessionID: AgentHQ.AgentSessionID, count = 1) =>
  waitHistory(
    sessionID,
    (history) => (ofType(history, "turn.completed").length >= count ? history : undefined),
    `turn ${count} never completed`,
  )

// The model's title request runs beside the turn; only count real turn requests.
const modelCalls = (llm: TestLLMServer["Service"]) =>
  llm.inputs.pipe(
    Effect.map((inputs) => inputs.filter((input) => !JSON.stringify(input).includes("Generate a title")).length),
  )

/** The assistant texts a client rebuilds from envelopes: deltas append, a final `message` replaces. */
const rendered = (list: readonly Envelope[]) => {
  const texts = new Map<string, string>()
  list.forEach((item) => {
    if (item.event.type === "message.delta")
      texts.set(item.event.messageID, (texts.get(item.event.messageID) ?? "") + item.event.text)
    if (item.event.type === "message" && item.event.role === "assistant")
      texts.set(item.event.messageID, item.event.text)
  })
  return [...texts.values()]
}

function is<D extends EventV2.Definition>(definition: D, event: EventV2.Payload): event is EventV2.Payload<D> {
  return event.type === definition.type
}

const contiguous = (list: readonly Envelope[]) => list.every((item, index) => item.seq === list[0].seq + index)

describe("agenthq", () => {
  it.live("AHQ-01 identity CRUD persists to the JSON store and publishes events", () =>
    Effect.gen(function* () {
      const seen = yield* capture
      const registry = yield* AgentRegistry.Service
      const storage = yield* Storage.Service
      const dir = yield* tmpdirScoped()

      const created = yield* registry.create({
        name: "  Fox  ",
        avatar: { kind: "preset", value: "fox", color: "orange" },
        provider: "opencode",
        model: "test/test-model",
        projectDirectory: dir,
      })
      expect(created.id.startsWith("agt_")).toBe(true)
      expect(created.name).toBe("Fox")
      expect(yield* storage.read<unknown>(["agenthq", "agent", created.id])).toEqual(created)

      const renamed = yield* registry.update(created.id, { name: "Owl", avatar: { kind: "emoji", value: "🦉" } })
      expect(renamed).toMatchObject({ name: "Owl", avatar: { kind: "emoji", value: "🦉" }, model: "test/test-model" })
      const cleared = yield* registry.update(created.id, { model: null, specialty: "reviews" })
      expect(cleared.model).toBeUndefined()
      expect(cleared.specialty).toBe("reviews")
      expect(yield* registry.get(created.id)).toEqual(cleared)
      expect((yield* registry.list()).map((agent) => agent.id)).toContain(created.id)

      yield* registry.remove(created.id)
      expect((yield* registry.get(created.id).pipe(Effect.flip))._tag).toBe("AgentHQ.NotFoundError")
      expect(yield* storage.read(["agenthq", "agent", created.id]).pipe(Effect.option)).toMatchObject({ _tag: "None" })

      const mine = seen.filter((event) => {
        const data = event.data as { agent?: { id: string }; id?: string }
        return data.agent?.id === created.id || data.id === created.id
      })
      expect(mine.map((event) => event.type)).toEqual([
        "agenthq.agent.updated",
        "agenthq.agent.updated",
        "agenthq.agent.updated",
        "agenthq.agent.removed",
      ])
      expect(mine.every((event) => event.location?.directory === dir)).toBe(true)

      const relative = yield* registry
        .create({
          name: "Bad",
          avatar: { kind: "initials", value: "B" },
          provider: "opencode",
          projectDirectory: "rel",
        })
        .pipe(Effect.flip)
      expect(relative._tag).toBe("AgentHQ.InvalidInputError")
      const blank = yield* registry
        .create({ name: " ", avatar: { kind: "initials", value: "B" }, provider: "opencode", projectDirectory: dir })
        .pipe(Effect.flip)
      expect(blank._tag).toBe("AgentHQ.InvalidInputError")
    }),
  )

  it.live("AHQ-02 two identities on one provider keep independent sessions and histories", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const sessions = yield* AgentSessions.Service
      const fox = yield* createAgent(dir, "Fox")
      const owl = yield* createAgent(dir, "Owl")
      const a = yield* sessions.start(fox.id)
      const b = yield* sessions.start(owl.id)
      expect(a.id).not.toBe(b.id)
      expect(a.providerSessionID).not.toBe(b.providerSessionID)

      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("question alpha"), "answer alpha")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("question beta"), "answer beta")
      yield* sessions.send(a.id, "question alpha")
      yield* sessions.send(b.id, "question beta")
      const historyA = yield* turnCompleted(a.id)
      const historyB = yield* turnCompleted(b.id)

      const texts = (history: readonly Envelope[]) => ofType(history, "message").map((event) => event.text)
      expect(texts(historyA)).toEqual(["question alpha", "answer alpha"])
      expect(texts(historyB)).toEqual(["question beta", "answer beta"])
      expect((yield* sessions.list(fox.id)).map((item) => item.id)).toEqual([a.id])
      expect((yield* sessions.list(owl.id)).map((item) => item.id)).toEqual([b.id])
    }),
  )

  it.live("AHQ-03 OpenCode session streams deltas, tool events, reasoning, completion, and persists history", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const seen = yield* capture
      const sessions = yield* AgentSessions.Service
      const storage = yield* Storage.Service
      const agent = yield* createAgent(dir)
      const started = yield* sessions.start(agent.id)
      expect(started).toMatchObject({ status: "idle", provider: "opencode", agentID: agent.id, pendingPermissions: 0 })

      yield* llm.push(reply().tool("glob", { pattern: "*.md" }))
      yield* llm.push(reply().reason("planning").text("Hello ").text("world").stop())
      yield* sessions.send(started.id, "list the markdown files")
      const history = yield* turnCompleted(started.id)

      const published = envelopes(seen, started.id)
      expect(published.map((item) => item.seq)).toEqual(published.map((_, index) => index))
      const where = seen.filter(
        (event) => event.type.startsWith("agenthq.session.") && JSON.stringify(event.data).includes(started.id),
      )
      expect(where.every((event) => event.location?.directory === dir)).toBe(true)

      const answer = ofType(published, "message").find((event) => event.role === "assistant")
      expect(answer?.text).toBe("Hello world")
      const deltas = ofType(published, "message.delta").filter((event) => event.messageID === answer?.messageID)
      expect(deltas.length).toBeGreaterThan(0)
      expect(deltas.map((event) => event.text).join("")).toBe("Hello world")
      const firstDelta = published.findIndex((item) => item.event.type === "message.delta")
      const message = published.findIndex((item) => item.event.type === "message" && item.event.role === "assistant")
      expect(firstDelta).toBeLessThan(message)

      const tools = ofType(published, "tool").filter((event) => event.tool === "glob")
      expect(tools.map((event) => event.state)).toContain("completed")
      expect(tools.at(-1)).toMatchObject({ state: "completed" })
      expect(typeof tools.at(-1)?.output).toBe("string")
      expect(ofType(published, "reasoning").map((event) => event.text)).toEqual(["planning"])
      expect(ofType(published, "turn.completed")).toEqual([
        { type: "turn.completed", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 } },
      ])

      // The persisted history is the compacted view: no deltas for a finished message, one entry per tool.
      const stored = Schema.decodeUnknownSync(Schema.Array(AgentHQ.AgentEventEnvelope))(
        yield* storage.read<unknown>(["agenthq", "events", started.id]),
      )
      expect(stored).toEqual(history)
      expect(ofType(stored, "message.delta").filter((event) => event.messageID === answer?.messageID)).toEqual([])
      expect(ofType(stored, "tool").filter((event) => event.tool === "glob")).toHaveLength(1)
      expect(ofType(stored, "message").map((event) => event.role)).toEqual(["user", "assistant"])
      expect(stored.at(-1)?.seq).toBe(published.at(-1)?.seq)

      const detail = yield* sessions.get(started.id)
      expect(detail.session).toMatchObject({ status: "idle", pendingPermissions: 0 })

      // Some models number tool calls per turn: the next turn's call reuses the id and is still recorded.
      const callID = tools.at(-1)!.callID
      yield* llm.push(reply().tool("glob", { pattern: "*.txt" }))
      yield* llm.push(reply().text("again").stop())
      yield* sessions.send(started.id, "list the text files")
      const next = (yield* turnCompleted(started.id, 2)).slice(history.length)
      const repeated = ofType(next, "tool").filter((event) => event.tool === "glob")
      expect(repeated.map((event) => event.callID)).toContain(callID)
      expect(repeated.at(-1)).toMatchObject({ state: "completed" })
      expect(ofType(next, "message").map((event) => event.text)).toEqual(["list the text files", "again"])
      // Compaction keeps one entry per tool per turn: the first turn's tool stays.
      const kept = ofType((yield* sessions.get(started.id)).history, "tool").filter((event) => event.tool === "glob")
      expect(kept.map((event) => [event.callID, event.state])).toEqual([
        [callID, "completed"],
        [callID, "completed"],
      ])
    }),
  )

  it.live("AHQ-04 a permission request surfaces and nothing proceeds until the human answers", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const sessions = yield* AgentSessions.Service
      const agent = yield* createAgent(dir)
      const started = yield* sessions.start(agent.id)

      yield* llm.push(reply().tool("bash", { command: "echo agenthq-permission", description: "Echo a marker" }))
      yield* llm.push(reply().text("done").stop())
      yield* sessions.send(started.id, "run the marker command")

      const request = yield* waitHistory(
        started.id,
        (history) => ofType(history, "permission.requested")[0],
        "permission was never requested",
      )
      expect(request.tool).toBe("bash")
      expect(request.title).toContain("echo agenthq-permission")
      expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"])

      // Hold still: the tool must not run and the model must not be called again while unanswered.
      yield* Effect.sleep("500 millis")
      const waiting = yield* sessions.get(started.id)
      expect(waiting.session).toMatchObject({ status: "needs_approval", pendingPermissions: 1 })
      expect(ofType(waiting.history, "tool").filter((event) => event.state === "completed")).toEqual([])
      expect(yield* modelCalls(llm)).toBe(1)

      const unknown = yield* sessions.respond(started.id, "per_unknown", "once").pipe(Effect.flip)
      expect(unknown._tag).toBe("AgentHQ.NotFoundError")
      yield* sessions.respond(started.id, request.requestID, "once")

      const history = yield* turnCompleted(started.id)
      expect(ofType(history, "permission.resolved")).toEqual([
        { type: "permission.resolved", requestID: request.requestID, outcome: "allowed" },
      ])
      const tool = ofType(history, "tool").find((event) => event.tool === "bash")
      expect(tool?.state).toBe("completed")
      expect(tool?.output).toContain("agenthq-permission")
      expect((yield* sessions.get(started.id)).session).toMatchObject({ status: "idle", pendingPermissions: 0 })
    }),
  )

  it.live("AHQ-05 cancel stops the running turn and leaves no work behind", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const sessions = yield* AgentSessions.Service
      const store = yield* InstanceStore.Service
      const agent = yield* createAgent(dir)
      const started = yield* sessions.start(agent.id)
      const opencodeID = Schema.decodeUnknownSync(SessionID)(started.providerSessionID)

      yield* llm.push(reply().hang())
      yield* sessions.send(started.id, "a turn that never ends")
      yield* pollWithTimeout(
        modelCalls(llm).pipe(Effect.map((count) => (count >= 1 ? true : undefined))),
        "model was never called",
      )
      expect((yield* sessions.get(started.id)).session.status).toBe("working")

      const cancelled = yield* sessions.cancel(started.id)
      expect(cancelled.status).toBe("cancelled")
      yield* pollWithTimeout(
        store
          .provide(
            { directory: dir },
            SessionStatus.Service.use((status) => status.get(opencodeID)),
          )
          .pipe(Effect.map((status) => (status.type === "idle" ? true : undefined))),
        "opencode session still busy after cancel",
      )
      yield* Effect.sleep("300 millis")
      const after = yield* sessions.get(started.id)
      expect(after.session.status).toBe("cancelled")
      expect(ofType(after.history, "turn.completed")).toEqual([])
      expect(yield* modelCalls(llm)).toBe(1)

      // The session stays usable after a cancel.
      yield* llm.push(reply().text("after cancel").stop())
      yield* sessions.send(started.id, "try again")
      const history = yield* turnCompleted(started.id)
      expect(ofType(history, "message").at(-1)?.text).toBe("after cancel")
    }),
  )

  it.live("AHQ-06 a restart marks active sessions interrupted, keeps history, and resumes", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const first = yield* boot
      const agent = yield* first.run(createAgent(dir))
      const started = yield* first.run(AgentSessions.Service.use((sessions) => sessions.start(agent.id)))
      yield* llm.push(reply().hang())
      yield* first.run(AgentSessions.Service.use((sessions) => sessions.send(started.id, "interrupt me")))
      yield* pollWithTimeout(
        modelCalls(llm).pipe(Effect.map((count) => (count >= 1 ? true : undefined))),
        "model was never called",
      )
      yield* Scope.close(first.scope, Exit.void)

      // Graceful stop: the finalizer recorded the interruption.
      const second = yield* boot
      const graceful = yield* second.run(AgentSessions.Service.use((sessions) => sessions.get(started.id)))
      expect(graceful.session.status).toBe("interrupted")
      expect(ofType(graceful.history, "message").map((event) => event.text)).toEqual(["interrupt me"])
      expect(ofType(graceful.history, "status").map((event) => event.status)).toEqual([
        "idle",
        "working",
        "interrupted",
      ])
      expect(contiguous(graceful.history)).toBe(true)

      // Crash: the record still says "working" and no finalizer ran.
      yield* second.run(
        Storage.Service.use((storage) =>
          storage.write(["agenthq", "session", started.id], {
            ...graceful.session,
            status: "working",
            pid: process.pid,
          }),
        ),
      )
      yield* Scope.close(second.scope, Exit.void)
      const third = yield* boot
      const crashed = yield* third.run(AgentSessions.Service.use((sessions) => sessions.get(started.id)))
      expect(crashed.session.status).toBe("interrupted")
      expect(crashed.history.slice(0, graceful.history.length)).toEqual([...graceful.history])

      // Resume is supported for OpenCode: the provider session is still in the session DB.
      yield* llm.push(reply().text("resumed").stop())
      yield* third.run(AgentSessions.Service.use((sessions) => sessions.send(started.id, "continue")))
      const resumed = yield* third.run(turnCompleted(started.id))
      expect(ofType(resumed, "message").map((event) => event.text)).toEqual(["interrupt me", "continue", "resumed"])
      // History is compacted (the reply's deltas folded into its message), so seq only has to increase.
      expect(resumed.every((item, index) => index === 0 || item.seq > resumed[index - 1].seq)).toBe(true)
      yield* Scope.close(third.scope, Exit.void)
    }),
  )

  it.live("AHQ-07 missing or unsupported providers report available=false with a reason", () =>
    Effect.gen(function* () {
      const bin = yield* tmpdirScoped()
      const script = (name: string, body: string) =>
        Effect.promise(async () => {
          await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`)
          await fs.chmod(path.join(bin, name), 0o755)
        })
      yield* script("claude", 'echo "2.1.296 (Claude Code)"')
      yield* script(
        "cursor-agent",
        'if [ "$1" = "--version" ]; then echo 2025.09.12-4852336; else printf "Commands:\\n  agent  Start\\n"; fi',
      )

      const claude = yield* AgentDetect.status("claude-code", { env: { PATH: bin } })
      expect(claude).toMatchObject({ id: "claude-code", available: true, version: "2.1.296", auth: "unknown" })
      expect(claude.capabilities.permissionRequests).toBe(false)
      const cursor = yield* AgentDetect.status("cursor", { env: { PATH: bin } })
      expect(cursor).toMatchObject({
        available: false,
        version: "2025.09.12-4852336",
        reason: "cursor-agent 2025.09.12 has no ACP mode; update cursor-agent",
      })
      const codex = yield* AgentDetect.status("codex", { env: { PATH: bin } })
      expect(codex).toMatchObject({ available: false, reason: "codex not found on PATH" })

      yield* script(
        "cursor-agent",
        'if [ "$1" = "--version" ]; then echo 2026.01.01; else printf "Commands:\\n  acp  Start ACP\\n"; fi',
      )
      // With an ACP command, Cursor is driven through the ACP adapter and reports its capabilities.
      const acpCursor = yield* (yield* AgentDetect.cursor({ PATH: bin })).status
      expect(acpCursor).toMatchObject({ available: true, version: "2026.01.01" })
      expect(acpCursor.capabilities).toMatchObject({ streaming: true, permissionRequests: true, cancel: true })

      // Through the manager: opencode is always there, every unavailable provider says why, and
      // provider.updated is published once per change, not on every call.
      const seen = yield* capture
      const sessions = yield* AgentSessions.Service
      const list = yield* sessions.providers()
      expect(list.map((item) => item.id).toSorted()).toEqual(["acp", "claude-code", "codex", "cursor", "opencode"])
      expect(list.find((item) => item.id === "opencode")).toMatchObject({ available: true })
      expect(list.filter((item) => !item.available).every((item) => !!item.reason)).toBe(true)
      yield* sessions.providers()
      expect(seen.filter((event) => event.type === "agenthq.provider.updated")).toHaveLength(5)

      // A provider without an adapter fails with a typed error and leaves no session behind.
      const registry = yield* AgentRegistry.Service
      const agent = yield* registry.create({
        name: "Cod",
        avatar: { kind: "initials", value: "C" },
        provider: "codex",
        projectDirectory: bin,
      })
      const failure = yield* sessions.start(agent.id).pipe(Effect.flip)
      expect(failure._tag).toBe("AgentHQ.UnsupportedError")
      expect(yield* sessions.list(agent.id)).toEqual([])
    }),
  )

  it.live("AHQ-10 one event stream per session with gap-free seq that a reconnect resumes from", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const seen = yield* capture
      const agent = yield* createAgent(dir)
      const first = yield* boot
      const started = yield* first.run(AgentSessions.Service.use((sessions) => sessions.start(agent.id)))
      yield* llm.push(reply().text("one").stop())
      yield* first.run(AgentSessions.Service.use((sessions) => sessions.send(started.id, "first")))
      yield* first.run(turnCompleted(started.id))
      yield* Scope.close(first.scope, Exit.void)

      // A new server lifetime: the session is not attached. Concurrent callers share one load and attach.
      const sessions = yield* AgentSessions.Service
      const before = yield* sessions.get(started.id)
      const resumeFrom = before.history.at(-1)!.seq
      yield* llm.push(reply().text("two").stop())
      yield* Effect.all(
        [
          sessions.send(started.id, "second"),
          sessions.respond(started.id, "per_missing", "once").pipe(Effect.flip),
          sessions.respond(started.id, "per_missing", "once").pipe(Effect.flip),
          sessions.get(started.id),
        ],
        { concurrency: "unbounded" },
      )
      const history = yield* turnCompleted(started.id, 2)

      // The client resumes from the last seq it saw: the next live envelope is exactly resumeFrom + 1.
      const live = envelopes(seen, started.id).filter((item) => item.seq > resumeFrom)
      expect(live[0]?.seq).toBe(resumeFrom + 1)
      expect(contiguous(live)).toBe(true)
      expect(new Set(live.map((item) => item.seq)).size).toBe(live.length)
      expect(
        ofType(live, "message")
          .filter((event) => event.role === "assistant")
          .map((event) => event.text),
      ).toEqual(["two"])
      expect(ofType(live, "turn.completed")).toHaveLength(1)
      expect(history.at(-1)?.seq).toBe(live.at(-1)?.seq)
    }),
  )

  it.live(
    "AHQ-08b ACP contract: plan, thoughts, diffs, reject_always, crash → disconnected → resume without replay",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const registry = yield* AgentRegistry.Service
        const sessions = yield* AgentSessions.Service
        const agent = yield* registry.create({
          name: "Scripted",
          avatar: { kind: "initials", value: "S" },
          provider: "acp",
          projectDirectory: dir,
          launch: {
            command: process.execPath,
            args: [path.join(import.meta.dir, "../fixture/agenthq/fake-acp-agent.ts")],
          },
        })
        const started = yield* sessions.start(agent.id)
        expect(started.providerSessionID).toBe("fake-session")

        yield* sessions.send(started.id, "plan")
        const planned = yield* turnCompleted(started.id)
        expect(ofType(planned, "plan")).toEqual([
          {
            type: "plan",
            entries: [
              { content: "read the file", status: "completed", priority: "high" },
              { content: "edit the file", status: "in_progress", priority: "medium" },
            ],
          },
        ])
        expect(ofType(planned, "reasoning").map((event) => event.text)).toEqual(["thinking"])
        // Text before a tool call is complete once the tool starts.
        const kinds = planned.map((item) => item.event.type)
        expect(kinds.indexOf("message", kinds.indexOf("message") + 1)).toBeLessThan(kinds.indexOf("tool"))
        expect(ofType(planned, "tool")).toEqual([
          { type: "tool", callID: "t1", tool: "edit", state: "completed", title: "Edit x.txt", output: "edited" },
        ])
        expect(ofType(planned, "file.changed")).toEqual([{ type: "file.changed", path: "/tmp/agenthq-x.txt" }])
        expect(ofType(planned, "turn.completed")).toEqual([{ type: "turn.completed", stopReason: "end_turn" }])

        yield* sessions.send(started.id, "ask")
        const request = yield* waitHistory(
          started.id,
          (history) => ofType(history, "permission.requested")[0],
          "scripted agent never asked",
        )
        expect(request).toMatchObject({ title: "Delete everything", tool: "delete", details: '{"path":"/"}' })
        expect(request.options).toEqual([
          { id: "yes", label: "Allow", kind: "allow_once" },
          { id: "never", label: "Never", kind: "reject_always" },
        ])
        expect((yield* sessions.respond(started.id, request.requestID, "maybe").pipe(Effect.flip))._tag).toBe(
          "AgentHQ.InvalidInputError",
        )
        yield* sessions.respond(started.id, request.requestID, "never")
        const answered = yield* turnCompleted(started.id, 2)
        expect(ofType(answered, "permission.resolved")).toEqual([
          { type: "permission.resolved", requestID: request.requestID, outcome: "rejected" },
        ])
        expect(ofType(answered, "message").at(-1)?.text).toBe("answer: never")

        yield* sessions.send(started.id, "crash")
        const crashed = yield* waitHistory(
          started.id,
          (history, session) => (session.status === "disconnected" ? history : undefined),
          "the crash was never reported",
        )
        expect(ofType(crashed, "error").at(-1)?.message).toContain("code 3")
        expect(ofType(crashed, "error").at(-1)?.message).toContain("boom")

        // The next message starts a new agent process and reattaches with session/load; the replay is ignored.
        yield* sessions.send(started.id, "back again")
        const resumed = yield* turnCompleted(started.id, 3)
        const texts = ofType(resumed, "message").map((event) => event.text)
        expect(texts.at(-1)).toBe("echo: back again")
        expect(texts).not.toContain("old reply")
        expect(texts).not.toContain("old question")
      }),
  )

  it.live("AHQ-11 a cancel racing a streamed delta never leaves turn output after the final text", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const seen = yield* capture
      const events = yield* EventV2.Service
      const sessions = yield* AgentSessions.Service
      const agent = yield* createAgent(dir)
      const started = yield* sessions.start(agent.id)
      // The provider's second delta opens the race: the manager has taken it from its queue and is waiting to
      // coalesce more when the cancel arrives and the provider reports the aborted text part as final.
      const second = yield* Deferred.make<void>()
      const off = yield* events.listen((event) =>
        Effect.sync(() => {
          if (is(SessionV1.Event.PartDelta, event) && event.data.delta === "this ")
            Deferred.doneUnsafe(second, Exit.void)
        }),
      )
      yield* Effect.addFinalizer(() => off)
      yield* llm.push(reply().text("Paragraph 1: ").text("this ").hang())
      yield* sessions.send(started.id, "write three paragraphs")
      yield* Deferred.await(second).pipe(Effect.timeout("20 seconds"))
      // Inside the manager's 40 ms coalescing window; this sleep is the race being reproduced.
      yield* Effect.sleep("5 millis")
      yield* sessions.cancel(started.id)
      yield* Effect.sleep("300 millis")

      const turn = new Set(["message.delta", "message", "reasoning", "tool", "plan", "file.changed", "turn.completed"])
      for (const list of [envelopes(seen, started.id), [...(yield* sessions.get(started.id)).history]]) {
        const cancelled = list.findIndex((item) => item.event.type === "status" && item.event.status === "cancelled")
        expect(cancelled).toBeGreaterThan(-1)
        expect(
          list.slice(cancelled + 1).filter((item) => turn.has(item.event.type) && item.event.type !== "message"),
        ).toEqual([])
        const final = list.findIndex((item) => item.event.type === "message" && item.event.role === "assistant")
        if (final === -1) continue
        const id = (list[final]!.event as EventOf<"message">).messageID
        expect(
          list.slice(final + 1).filter((item) => item.event.type === "message.delta" && item.event.messageID === id),
        ).toEqual([])
      }
      // What a client rebuilds from the stream (deltas append, a final message replaces) is exactly the text.
      expect(rendered(envelopes(seen, started.id))).toEqual(["Paragraph 1: this "])
    }),
  )

  it.live("AHQ-11b late output for a finished message or tool is dropped for any provider (scripted ACP)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const seen = yield* capture
      const registry = yield* AgentRegistry.Service
      const sessions = yield* AgentSessions.Service
      const agent = yield* registry.create({
        name: "Late",
        avatar: { kind: "initials", value: "L" },
        provider: "acp",
        projectDirectory: dir,
        launch: {
          command: process.execPath,
          args: [path.join(import.meta.dir, "../fixture/agenthq/fake-acp-agent.ts")],
        },
      })
      const started = yield* sessions.start(agent.id)
      yield* sessions.send(started.id, "late")
      yield* turnCompleted(started.id)
      // The agent's late updates arrive 30 ms after its answer.
      yield* Effect.sleep("300 millis")
      const published = envelopes(seen, started.id)
      const final = published.findIndex((item) => item.event.type === "message" && item.event.role === "assistant")
      expect((published[final]!.event as EventOf<"message">).text).toBe("first")
      expect(published.slice(final + 1).filter((item) => item.event.type === "message.delta")).toEqual([])
      expect(ofType(published, "tool").map((event) => event.state)).toEqual(["completed"])
      expect(rendered(published)).toEqual(["first"])
    }),
  )

  it.live("AHQ-12 the provider's generated session title reaches the Agent HQ session", () =>
    Effect.gen(function* () {
      const { llm, dir } = yield* project
      const sessions = yield* AgentSessions.Service
      const agent = yield* createAgent(dir)
      const started = yield* sessions.start(agent.id)
      expect(started.title).toBeUndefined()
      yield* llm.text("hello back")
      yield* sessions.send(started.id, "hello")
      // The fake model answers opencode's title request with "E2E Title".
      const titled = yield* waitHistory(
        started.id,
        (_, session) => (session.title === "E2E Title" ? session : undefined),
        "the session title never arrived",
      )
      expect(titled.title).toBe("E2E Title")
      expect((yield* sessions.list(agent.id)).find((item) => item.id === started.id)?.title).toBe("E2E Title")
    }),
  )

  it.effect("guard turns allow into ask except for read-only tools and keeps deny", () =>
    Effect.sync(() => {
      const rules = guard([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "git status", action: "allow" },
        { permission: "bash", pattern: "rm *", action: "deny" },
        { permission: "read", pattern: "*.env", action: "ask" },
      ])
      const decide = (permission: string, pattern: string) => Permission.evaluate(permission, pattern, rules).action
      expect(decide("bash", "ls")).toBe("ask")
      expect(decide("bash", "git status")).toBe("ask")
      expect(decide("bash", "rm -rf /")).toBe("deny")
      expect(decide("edit", "src/a.ts")).toBe("ask")
      expect(decide("some_mcp_tool", "*")).toBe("ask")
      expect(decide("glob", "*.md")).toBe("allow")
      expect(decide("read", "a.ts")).toBe("allow")
      expect(decide("read", "x.env")).toBe("ask")
      expect(decide("question", "*")).toBe("deny")
    }),
  )
})
