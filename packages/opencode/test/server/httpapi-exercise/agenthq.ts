// Spicy Agent HQ route scenarios. Seeds write records straight into the isolated JSON store, the same
// files AgentRegistry and AgentSessions read.
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
import path from "path"
import { array, boolean, check, object } from "./assertions"
import { http, route } from "./dsl"
import { exerciseDataDirectory } from "./environment"
import type { Scenario, ScenarioContext } from "./types"

const file = (key: string[]) => path.join(exerciseDataDirectory, "storage", ...key) + ".json"
const store = (key: string[], value: unknown) =>
  Effect.promise(() => Bun.write(file(key), JSON.stringify(value))).pipe(Effect.asVoid)
const stored = (key: string[]) => Effect.promise(() => Bun.file(file(key)).exists())

const seedAgent = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    if (!ctx.directory) throw new Error("agenthq scenarios need a project directory")
    const now = Date.now()
    const agent = {
      id: AgentHQ.AgentID.create(),
      name: "Exercise",
      avatar: { kind: "preset", value: "fox" },
      provider: "opencode",
      projectDirectory: ctx.directory,
      createdAt: now,
      updatedAt: now,
    }
    yield* store(["agenthq", "agent", agent.id], agent)
    return agent
  })

const seedSession = (ctx: ScenarioContext, providerSessionID?: string) =>
  Effect.gen(function* () {
    const agent = yield* seedAgent(ctx)
    const now = Date.now()
    const session = {
      id: AgentHQ.AgentSessionID.create(),
      agentID: agent.id,
      provider: "opencode",
      ...(providerSessionID ? { providerSessionID } : {}),
      status: "interrupted",
      pendingPermissions: 0,
      createdAt: now,
      updatedAt: now,
    }
    yield* store(["agenthq", "session", session.id], session)
    yield* store(
      ["agenthq", "events", session.id],
      [{ sessionID: session.id, seq: 0, at: now, event: { type: "status", status: "interrupted" } }],
    )
    return { agent, session }
  })

const seedTask = (ctx: ScenarioContext, status: string, dependsOn: string[] = []) =>
  Effect.gen(function* () {
    const agent = yield* seedAgent(ctx)
    const now = Date.now()
    const task = {
      id: AgentHQ.TaskID.create(),
      title: "Exercise task",
      assignee: agent.id,
      dependsOn,
      status,
      isolated: false,
      createdAt: now,
      updatedAt: now,
    }
    yield* store(["agenthq", "task", task.id], task)
    return { agent, task }
  })

export const agenthqScenarios: Scenario[] = [
  http.protected.get("/agenthq/providers", "agenthq.providers").json(200, (body) => {
    array(body)
    const ids = body.map((item) => (item as { id?: unknown }).id)
    check(
      ["opencode", "claude-code", "cursor", "codex"].every((id) => ids.includes(id)),
      "all providers listed",
    )
    check(
      body.some(
        (item) =>
          (item as { id?: unknown; available?: unknown }).id === "opencode" &&
          (item as { available?: unknown }).available === true,
      ),
      "opencode is always available",
    )
  }),
  http.protected
    .get("/agenthq/agents", "agenthq.agents.list")
    .seeded(seedAgent)
    .json(
      200,
      (body, ctx) => {
        array(body)
        check(
          body.some((item) => (item as { id?: unknown }).id === ctx.state.id),
          "seeded agent is listed",
        )
      },
      "status",
    ),
  http.protected
    .post("/agenthq/agents", "agenthq.agents.create")
    .at((ctx) => ({
      path: "/agenthq/agents",
      headers: ctx.headers(),
      body: { name: "Fox", avatar: { kind: "preset", value: "fox" }, provider: "opencode" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(typeof body.id === "string" && body.id.startsWith("agt_"), "created agent has an agt_ id")
          check(body.projectDirectory === ctx.directory, "projectDirectory defaults to the request instance")
          check(yield* stored(["agenthq", "agent", String(body.id)]), "agent persisted in the JSON store")
        }),
      "status",
    ),
  http.protected
    .patch("/agenthq/agents/{agentID}", "agenthq.agents.update")
    .seeded(seedAgent)
    .at((ctx) => ({
      path: route("/agenthq/agents/{agentID}", { agentID: ctx.state.id }),
      headers: ctx.headers(),
      body: { name: "Renamed", model: "test/test-model" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.name === "Renamed" && body.model === "test/test-model", "update returns the patched identity")
      },
      "status",
    ),
  http.protected
    .delete("/agenthq/agents/{agentID}", "agenthq.agents.remove")
    .seeded((ctx) => seedSession(ctx))
    .at((ctx) => ({
      path: route("/agenthq/agents/{agentID}", { agentID: ctx.state.agent.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          boolean(body)
          check(!(yield* stored(["agenthq", "agent", ctx.state.agent.id])), "agent record removed")
          check(!(yield* stored(["agenthq", "session", ctx.state.session.id])), "its sessions removed")
          check(!(yield* stored(["agenthq", "events", ctx.state.session.id])), "their histories removed")
        }),
      "status",
    ),
  http.protected
    .get("/agenthq/agents/{agentID}/sessions", "agenthq.sessions.list")
    .seeded((ctx) => seedSession(ctx))
    .at((ctx) => ({
      path: route("/agenthq/agents/{agentID}/sessions", { agentID: ctx.state.agent.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        array(body)
        check(
          body.length === 1 && (body[0] as { id?: unknown }).id === ctx.state.session.id,
          "lists the agent's session",
        )
      },
      "status",
    ),
  http.protected
    .post("/agenthq/agents/{agentID}/sessions", "agenthq.sessions.start")
    .seeded(seedAgent)
    .at((ctx) => ({
      path: route("/agenthq/agents/{agentID}/sessions", { agentID: ctx.state.id }),
      headers: ctx.headers(),
      body: { title: "Exercise session" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(typeof body.id === "string" && body.id.startsWith("ags_"), "session has an ags_ id")
        check(body.status === "idle", "a started session is idle")
        check(
          typeof body.providerSessionID === "string" && body.providerSessionID.startsWith("ses"),
          "backed by an opencode session",
        )
      },
      "status",
    ),
  http.protected
    .get("/agenthq/sessions/{sessionID}", "agenthq.sessions.get")
    .seeded((ctx) => seedSession(ctx))
    .at((ctx) => ({
      path: route("/agenthq/sessions/{sessionID}", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        object(body.session)
        check(body.session.id === ctx.state.session.id, "returns the session")
        array(body.history)
        check(body.history.length === 1, "returns its history")
      },
      "status",
    ),
  http.protected
    .post("/agenthq/sessions/{sessionID}/messages", "agenthq.sessions.message")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const opencode = yield* ctx.session({ title: "Agent HQ backing session" })
        yield* ctx.llmText("agent reply")
        return yield* seedSession(ctx, opencode.id)
      }),
    )
    .at((ctx) => ({
      path: route("/agenthq/sessions/{sessionID}/messages", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { text: "hello agent" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(body === true, "message accepted")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/agenthq/sessions/{sessionID}/cancel", "agenthq.sessions.cancel")
    .seeded((ctx) => seedSession(ctx))
    .at((ctx) => ({
      path: route("/agenthq/sessions/{sessionID}/cancel", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.session.id, "cancel returns the session")
      },
      "status",
    ),
  http.protected
    .post("/agenthq/sessions/{sessionID}/permissions/{requestID}", "agenthq.sessions.permission")
    .seeded((ctx) => seedSession(ctx))
    .at((ctx) => ({
      path: route("/agenthq/sessions/{sessionID}/permissions/{requestID}", {
        sessionID: ctx.state.session.id,
        requestID: "per_missing",
      }),
      headers: ctx.headers(),
      body: { optionID: "once" },
    }))
    .status(404),
  http.protected
    .get("/agenthq/tasks", "agenthq.tasks.list")
    .seeded((ctx) => seedTask(ctx, "ready"))
    .json(
      200,
      (body, ctx) => {
        array(body)
        check(
          body.some((item) => (item as { id?: unknown }).id === ctx.state.task.id),
          "seeded task is listed",
        )
      },
      "status",
    ),
  http.protected
    .post("/agenthq/tasks", "agenthq.tasks.create")
    .seeded(seedAgent)
    .at((ctx) => ({
      path: "/agenthq/tasks",
      headers: ctx.headers(),
      body: { title: "Write the notes", assignee: ctx.state.id },
    }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(typeof body.id === "string" && body.id.startsWith("tsk_"), "task has a tsk_ id")
          check(body.status === "ready", "a task without dependencies is ready")
          check(yield* stored(["agenthq", "task", String(body.id)]), "task persisted in the JSON store")
        }),
      "status",
    ),
  http.protected
    .get("/agenthq/tasks/{taskID}", "agenthq.tasks.get")
    .seeded((ctx) => seedTask(ctx, "ready"))
    .at((ctx) => ({ path: route("/agenthq/tasks/{taskID}", { taskID: ctx.state.task.id }), headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.task.id, "returns the task")
      },
      "status",
    ),
  http.protected
    .patch("/agenthq/tasks/{taskID}", "agenthq.tasks.update")
    .seeded((ctx) => seedTask(ctx, "ready"))
    .at((ctx) => ({
      path: route("/agenthq/tasks/{taskID}", { taskID: ctx.state.task.id }),
      headers: ctx.headers(),
      body: { title: "Renamed task" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.title === "Renamed task", "update returns the edited task")
      },
      "status",
    ),
  http.protected
    .delete("/agenthq/tasks/{taskID}", "agenthq.tasks.remove")
    .seeded((ctx) => seedTask(ctx, "ready"))
    .at((ctx) => ({ path: route("/agenthq/tasks/{taskID}", { taskID: ctx.state.task.id }), headers: ctx.headers() }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          boolean(body)
          check(!(yield* stored(["agenthq", "task", ctx.state.task.id])), "task record removed")
        }),
      "status",
    ),
  http.protected
    .post("/agenthq/tasks/{taskID}/start", "agenthq.tasks.start")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmText("task done")
        return yield* seedTask(ctx, "ready")
      }),
    )
    .at((ctx) => ({
      path: route("/agenthq/tasks/{taskID}/start", { taskID: ctx.state.task.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(body.status === "running", "a started task is running")
          object(body.result)
          check(typeof body.result.sessionID === "string", "the task runs as a session of its assignee")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/agenthq/tasks/{taskID}/cancel", "agenthq.tasks.cancel")
    .seeded((ctx) => seedTask(ctx, "ready"))
    .at((ctx) => ({
      path: route("/agenthq/tasks/{taskID}/cancel", { taskID: ctx.state.task.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.status === "cancelled", "cancel returns the cancelled task")
      },
      "status",
    ),
  http.protected
    .get("/agenthq/tasks/{taskID}/review", "agenthq.tasks.review")
    .seeded((ctx) => seedTask(ctx, "review"))
    .at((ctx) => ({
      path: route("/agenthq/tasks/{taskID}/review", { taskID: ctx.state.task.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.taskID === ctx.state.task.id && body.mergeable === true, "a review without a branch is mergeable")
      },
      "status",
    ),
  http.protected
    .post("/agenthq/tasks/{taskID}/approve", "agenthq.tasks.approve")
    .seeded((ctx) => seedTask(ctx, "review"))
    .at((ctx) => ({
      path: route("/agenthq/tasks/{taskID}/approve", { taskID: ctx.state.task.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.status === "done", "approving a task in review finishes it")
      },
      "status",
    ),
  http.protected
    .get("/agenthq/messages", "agenthq.messages.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const agent = yield* seedAgent(ctx)
        const message = {
          id: AgentHQ.AgentMessageID.create(),
          from: "user",
          to: agent.id,
          text: "hello",
          evidenceIDs: [],
          at: Date.now(),
          delivery: "failed",
          kind: "user",
          hops: 0,
          relay: false,
          reason: "seeded",
        }
        yield* store(["agenthq", "message", message.id], message)
        return { agent, message }
      }),
    )
    .at((ctx) => ({ path: `/agenthq/messages?agentID=${ctx.state.agent.id}`, headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        array(body)
        check(
          body.length === 1 && (body[0] as { id?: unknown }).id === ctx.state.message.id,
          "lists the agent's message",
        )
      },
      "status",
    ),
  http.protected
    .post("/agenthq/messages", "agenthq.messages.send")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmText("got it")
        return yield* seedAgent(ctx)
      }),
    )
    .at((ctx) => ({
      path: "/agenthq/messages",
      headers: ctx.headers(),
      body: { to: ctx.state.id, text: "hello agent" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(body.delivery === "delivered" && body.from === "user", "the message reached the agent's session")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
]
