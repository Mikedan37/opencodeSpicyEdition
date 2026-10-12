// Agent HQ session manager.
//
// Process-global rather than InstanceState: an agent session belongs to its identity's project, not to
// the directory a client happens to be routed to, and must stay reachable from any instance while the
// provider runs in its own project's instance. Records live in the global JSON store.
//
// Every provider event goes through one queue per session. A single consumer fiber drains it in
// batches, coalesces text deltas, assigns gap-free `seq`, keeps a capped compacted history,
// persists, and publishes. Manager-side events (user message, cancel) are recorded under the same
// per-session lock, so ordering and seq stay consistent.
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Cause, Context, Effect, Fiber, Layer, Option, Queue, Schema, Scope } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { EventV2 } from "@opencode-ai/core/event"
import { AgentProvider } from "./provider"
import { AgentRegistry } from "./registry"
import { AgentDetect } from "./providers/detect"
import { OpenCodeProvider } from "./providers/opencode"
import { ReviewChanges } from "@/review/changes" // spicy: review hook

const ACTIVE = new Set<AgentHQ.AgentSessionStatus>(["starting", "thinking", "working", "needs_approval", "blocked"])
const HISTORY_LIMIT = 2_000
// Wait this long after a delta-only batch so a streaming reply is published in fewer, larger deltas.
const DELTA_LINGER = "40 millis"
// Delta-only batches rewrite the history file at most this often; anything else persists immediately.
const PERSIST_INTERVAL = 1_000

// The stored record is the contract shape plus the owning process, so a second opencode process that
// shares the data directory neither marks this process's live sessions interrupted nor drives them.
const Stored = Schema.Struct({ ...AgentHQ.AgentSessionInfo.fields, pid: Schema.optional(Schema.Number) })
type Stored = typeof Stored.Type
const decodeStored = Schema.decodeUnknownOption(Stored)
const decodeHistory = Schema.decodeUnknownOption(Schema.Array(AgentHQ.AgentEventEnvelope))

interface Live {
  info: AgentHQ.AgentSessionInfo
  readonly agent: AgentHQ.AgentIdentity
  seq: number
  history: AgentHQ.AgentEventEnvelope[]
  persisted: number
  readonly pending: Set<string>
  readonly queue: Queue.Queue<AgentHQ.AgentEvent>
  consumer?: Fiber.Fiber<unknown>
  handle?: AgentProvider.Session
}

export interface Detail {
  readonly session: AgentHQ.AgentSessionInfo
  readonly history: readonly AgentHQ.AgentEventEnvelope[]
}

type Failure = AgentProvider.NotFoundError | AgentProvider.UnsupportedError | AgentProvider.ProviderError

export interface Interface {
  readonly providers: () => Effect.Effect<AgentHQ.ProviderStatus[]>
  readonly list: (agentID: AgentHQ.AgentID) => Effect.Effect<AgentHQ.AgentSessionInfo[], AgentProvider.NotFoundError>
  readonly start: (
    agentID: AgentHQ.AgentID,
    input?: { readonly title?: string },
  ) => Effect.Effect<AgentHQ.AgentSessionInfo, Failure>
  readonly get: (sessionID: AgentHQ.AgentSessionID) => Effect.Effect<Detail, AgentProvider.NotFoundError>
  readonly send: (
    sessionID: AgentHQ.AgentSessionID,
    text: string,
  ) => Effect.Effect<void, Failure | AgentProvider.InvalidInputError>
  readonly cancel: (sessionID: AgentHQ.AgentSessionID) => Effect.Effect<AgentHQ.AgentSessionInfo, Failure>
  readonly respond: (
    sessionID: AgentHQ.AgentSessionID,
    requestID: string,
    optionID: string,
  ) => Effect.Effect<void, Failure | AgentProvider.InvalidInputError>
  /** Closes and deletes every session of an identity (used when the identity is removed). */
  readonly forget: (agentID: AgentHQ.AgentID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentHQSessions") {}

const sessionKey = (id: string) => ["agenthq", "session", id]
const historyKey = (id: string) => ["agenthq", "events", id]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const registry = yield* AgentRegistry.Service
    const review = yield* ReviewChanges.Service // spicy: review hook
    const scope = yield* Scope.Scope
    const providers: Record<AgentHQ.ProviderID, AgentProvider.Interface> = {
      opencode: yield* OpenCodeProvider.make,
      "claude-code": yield* AgentDetect.make("claude-code"),
      cursor: yield* AgentDetect.make("cursor"),
      codex: yield* AgentDetect.make("codex"),
    }
    const live = new Map<string, Live>()
    const locks = KeyedMutex.makeUnsafe<string>()
    const lock = (id: string) => locks.withLock(id)

    // ---------------------------------------------------------------- recording

    const record = Effect.fnUntraced(function* (session: Live, input: readonly AgentHQ.AgentEvent[]) {
      const before = session.info
      const published: AgentHQ.AgentEventEnvelope[] = []
      for (const event of coalesce(input)) {
        const info = apply(session, event)
        // A status that changes nothing (repeated busy, progress while a permission waits) is not news.
        if (event.type === "status" && info === session.info) continue
        session.info = info
        const envelope = { sessionID: session.info.id, seq: session.seq++, at: Date.now(), event }
        append(session, envelope)
        published.push(envelope)
      }
      if (published.length === 0) return
      const now = Date.now()
      if (
        published.some((item) => item.event.type !== "message.delta") ||
        now - session.persisted >= PERSIST_INTERVAL
      ) {
        session.persisted = now
        yield* storage.write(historyKey(session.info.id), session.history).pipe(Effect.orDie)
      }
      if (session.info !== before) yield* save(session)
      const where = AgentRegistry.location(session.agent.projectDirectory)
      yield* Effect.forEach(published, (envelope) => events.publish(AgentHQ.Event.SessionEvent, { envelope }, where), {
        discard: true,
      })
      if (session.info !== before) yield* events.publish(AgentHQ.Event.SessionUpdated, { session: session.info }, where)
      yield* review.observeAgent(session.info, session.agent, published) // spicy: external agents' edits become review changesets
    })

    const save = (session: Live) =>
      storage.write(sessionKey(session.info.id), { ...session.info, pid: process.pid }).pipe(Effect.orDie)

    const emitter =
      (session: Live): AgentProvider.Emit =>
      (event) => {
        Queue.offerUnsafe(session.queue, event)
      }

    // One consumer per session: the only path from a provider to history and the event bus.
    const consume = (session: Live) =>
      Effect.gen(function* () {
        const first = yield* Queue.takeAll(session.queue)
        const batch = first.every((event) => event.type === "message.delta")
          ? [...first, ...(yield* Effect.sleep(DELTA_LINGER).pipe(Effect.andThen(Queue.clear(session.queue))))]
          : first
        yield* lock(session.info.id)(record(session, batch))
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.logError("agenthq event batch failed", { sessionID: session.info.id, cause }),
        ),
        Effect.forever,
        Effect.forkIn(scope),
      )

    const register = Effect.fnUntraced(function* (session: Live) {
      live.set(session.info.id, session)
      session.consumer = yield* consume(session)
      return session
    })

    // ---------------------------------------------------------------- loading

    const readStored = Effect.fnUntraced(function* (id: string) {
      const value = yield* storage.read<unknown>(sessionKey(id)).pipe(Effect.option)
      return Option.flatMap(value, decodeStored)
    })

    const readHistory = Effect.fnUntraced(function* (id: string) {
      const value = yield* storage.read<unknown>(historyKey(id)).pipe(Effect.option)
      return Option.getOrElse(Option.flatMap(value, decodeHistory), () => [])
    })

    const missing = (id: string) => new AgentProvider.NotFoundError({ message: `Agent session not found: ${id}` })

    // Callers hold the session lock.
    const load = Effect.fnUntraced(function* (id: AgentHQ.AgentSessionID) {
      const existing = live.get(id)
      if (existing) return existing
      const stored = yield* readStored(id)
      if (Option.isNone(stored)) return yield* missing(id)
      if (!owned(stored.value))
        return yield* new AgentProvider.UnsupportedError({
          provider: stored.value.provider,
          action: "drive",
          message: `Agent session ${id} is driven by another opencode process (pid ${stored.value.pid})`,
        })
      const agent = yield* registry.get(stored.value.agentID).pipe(Effect.mapError(() => missing(id)))
      const history = [...(yield* readHistory(id))]
      return yield* register({
        info: strip(stored.value),
        agent,
        seq: (history.at(-1)?.seq ?? -1) + 1,
        history,
        persisted: Date.now(),
        pending: new Set(),
        queue: yield* Queue.unbounded<AgentHQ.AgentEvent>(),
      })
    })

    const attach = Effect.fnUntraced(function* (session: Live) {
      if (session.handle) return session.handle
      const provider = providers[session.info.provider]
      if (!provider.resumeSession || !session.info.providerSessionID)
        return yield* new AgentProvider.UnsupportedError({
          provider: session.info.provider,
          action: "resume",
          message: `${session.info.provider} sessions cannot be resumed`,
        })
      session.handle = yield* provider.resumeSession({
        agent: session.agent,
        providerSessionID: session.info.providerSessionID,
        emit: emitter(session),
      })
      return session.handle
    })

    const records = Effect.fnUntraced(function* () {
      const keys = yield* storage.list(["agenthq", "session"]).pipe(Effect.orElseSucceed(() => []))
      const found = yield* Effect.forEach(keys, (item) => readStored(item.at(-1) ?? ""), { concurrency: 8 })
      return found.flatMap((item) => Option.toArray(item))
    })

    // Sessions that were active when their process stopped become `interrupted`; history stays intact.
    const ready = yield* Effect.cached(
      Effect.gen(function* () {
        const stale = (yield* records()).filter((item) => ACTIVE.has(item.status) && owned(item))
        yield* Effect.forEach(
          stale,
          (item) =>
            lock(item.id)(
              load(item.id).pipe(
                Effect.flatMap((session) => record(session, [{ type: "status", status: "interrupted" }])),
              ),
            ).pipe(Effect.catchCause((cause) => Effect.logWarning("agenthq recovery skipped", { id: item.id, cause }))),
          { discard: true },
        )
      }),
    )

    // A graceful shutdown leaves the same trace as a crash.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        live.values(),
        (session) =>
          Effect.gen(function* () {
            if (session.handle) yield* session.handle.close
            if (!ACTIVE.has(session.info.status)) return
            yield* record(session, [...(yield* Queue.clear(session.queue)), { type: "status", status: "interrupted" }])
          }).pipe(Effect.ignoreCause),
        { discard: true },
      ),
    )

    // ---------------------------------------------------------------- providers

    const known = new Map<string, string>()
    const detect = yield* Effect.cachedWithTTL(
      Effect.forEach(Object.values(providers), (provider) => provider.status, { concurrency: "unbounded" }),
      "30 seconds",
    )

    const providerStatus = Effect.fn("AgentHQSessions.providers")(function* () {
      const list = yield* detect
      yield* Effect.forEach(
        list,
        (provider) => {
          const json = JSON.stringify(provider)
          if (known.get(provider.id) === json) return Effect.void
          known.set(provider.id, json)
          return events.publish(AgentHQ.Event.ProviderUpdated, { provider })
        },
        { discard: true },
      )
      return list
    })

    // ---------------------------------------------------------------- operations

    const list = Effect.fn("AgentHQSessions.list")(function* (agentID: AgentHQ.AgentID) {
      yield* ready
      yield* registry.get(agentID)
      return (yield* records())
        .filter((item) => item.agentID === agentID)
        .map((item) => live.get(item.id)?.info ?? strip(item))
        .toSorted((a, b) => a.createdAt - b.createdAt)
    })

    const start = Effect.fn("AgentHQSessions.start")(function* (
      agentID: AgentHQ.AgentID,
      input?: { readonly title?: string },
    ) {
      yield* ready
      const agent = yield* registry.get(agentID)
      const now = Date.now()
      const session: Live = {
        info: {
          id: AgentHQ.AgentSessionID.create(),
          agentID,
          provider: agent.provider,
          ...(input?.title ? { title: input.title } : {}),
          status: "starting",
          pendingPermissions: 0,
          createdAt: now,
          updatedAt: now,
        },
        agent,
        seq: 0,
        history: [],
        persisted: now,
        pending: new Set(),
        queue: yield* Queue.unbounded<AgentHQ.AgentEvent>(),
      }
      // Ask the provider first: an unsupported or failing provider leaves no record behind.
      const handle = yield* providers[agent.provider].createSession({
        agent,
        ...(input?.title ? { title: input.title } : {}),
        emit: emitter(session),
      })
      session.handle = handle
      session.info = { ...session.info, providerSessionID: handle.providerSessionID }
      return yield* lock(session.info.id)(
        Effect.gen(function* () {
          yield* register(session)
          yield* record(session, [{ type: "status", status: "idle" }])
          return session.info
        }),
      )
    })

    const get = Effect.fn("AgentHQSessions.get")(function* (sessionID: AgentHQ.AgentSessionID) {
      yield* ready
      const current = live.get(sessionID)
      // Under the lock, so a reader never sees an envelope before it was persisted and published.
      if (current)
        return yield* lock(sessionID)(Effect.sync(() => ({ session: current.info, history: [...current.history] })))
      const stored = yield* readStored(sessionID)
      if (Option.isNone(stored)) return yield* missing(sessionID)
      return { session: strip(stored.value), history: yield* readHistory(sessionID) }
    })

    const send = Effect.fn("AgentHQSessions.send")(function* (sessionID: AgentHQ.AgentSessionID, text: string) {
      if (!text.trim()) return yield* new AgentProvider.InvalidInputError({ message: "text must not be empty" })
      yield* ready
      yield* lock(sessionID)(
        Effect.gen(function* () {
          const session = yield* load(sessionID)
          const handle = yield* attach(session)
          yield* record(session, [
            { type: "message", messageID: crypto.randomUUID(), role: "user", text },
            { type: "status", status: "working" },
          ])
          yield* handle.send(text).pipe(
            Effect.tapError((error) =>
              record(session, [
                { type: "error", message: error.message },
                { type: "status", status: "failed" },
              ]),
            ),
          )
        }),
      )
    })

    const cancel = Effect.fn("AgentHQSessions.cancel")(function* (sessionID: AgentHQ.AgentSessionID) {
      yield* ready
      return yield* lock(sessionID)(
        Effect.gen(function* () {
          const session = yield* load(sessionID)
          if (session.handle) yield* session.handle.cancel
          if (!ACTIVE.has(session.info.status)) return session.info
          // Events the provider queued before the cancel stay ahead of it.
          yield* record(session, [
            ...(yield* Queue.clear(session.queue)),
            ...[...session.pending].map(
              (requestID): AgentHQ.AgentEvent => ({ type: "permission.resolved", requestID, outcome: "cancelled" }),
            ),
            { type: "status", status: "cancelled" },
          ])
          return session.info
        }),
      )
    })

    const respond = Effect.fn("AgentHQSessions.respond")(function* (
      sessionID: AgentHQ.AgentSessionID,
      requestID: string,
      optionID: string,
    ) {
      yield* ready
      yield* lock(sessionID)(
        Effect.gen(function* () {
          const session = yield* load(sessionID)
          if (!session.pending.has(requestID))
            return yield* new AgentProvider.NotFoundError({ message: `Permission request not found: ${requestID}` })
          const handle = yield* attach(session)
          if (!handle.respondPermission)
            return yield* new AgentProvider.UnsupportedError({
              provider: session.info.provider,
              action: "respondPermission",
              message: `${session.info.provider} does not accept permission replies`,
            })
          yield* handle.respondPermission(requestID, optionID)
        }),
      )
    })

    const forget = Effect.fn("AgentHQSessions.forget")(function* (agentID: AgentHQ.AgentID) {
      yield* ready
      const sessions = (yield* records()).filter((item) => item.agentID === agentID)
      yield* Effect.forEach(
        sessions,
        (item) =>
          lock(item.id)(
            Effect.gen(function* () {
              const session = live.get(item.id)
              live.delete(item.id)
              if (session?.handle)
                yield* session.handle.cancel.pipe(Effect.ignore, Effect.andThen(session.handle.close))
              if (session?.consumer) yield* Fiber.interrupt(session.consumer)
              yield* storage.remove(sessionKey(item.id)).pipe(Effect.ignore)
              yield* storage.remove(historyKey(item.id)).pipe(Effect.ignore)
            }),
          ),
        { discard: true },
      )
    })

    return Service.of({ providers: providerStatus, list, start, get, send, cancel, respond, forget })
  }),
)

function strip(stored: Stored): AgentHQ.AgentSessionInfo {
  const { pid: _, ...info } = stored
  return info
}

function owned(stored: Stored) {
  if (stored.pid === undefined || stored.pid === process.pid) return true
  return !alive(stored.pid)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

// Merge adjacent deltas of the same message inside one batch.
function coalesce(events: readonly AgentHQ.AgentEvent[]) {
  return events.reduce<AgentHQ.AgentEvent[]>((out, event) => {
    const last = out.at(-1)
    if (event.type === "message.delta" && last?.type === "message.delta" && last.messageID === event.messageID) {
      out[out.length - 1] = { ...last, text: last.text + event.text }
      return out
    }
    out.push(event)
    return out
  }, [])
}

function apply(session: Live, event: AgentHQ.AgentEvent): AgentHQ.AgentSessionInfo {
  const info = session.info
  const next = (patch: Partial<AgentHQ.AgentSessionInfo>) => ({ ...info, ...patch, updatedAt: Date.now() })
  switch (event.type) {
    case "status":
      if (info.status === event.status) return info
      // Provider progress must not hide a permission request that is still waiting for the human.
      if (session.pending.size > 0 && (event.status === "working" || event.status === "thinking")) return info
      if (event.status === "working") return next({ status: event.status, error: undefined })
      if (!ACTIVE.has(event.status)) session.pending.clear()
      return next({ status: event.status, pendingPermissions: session.pending.size })
    case "permission.requested":
      session.pending.add(event.requestID)
      return next({ status: "needs_approval", pendingPermissions: session.pending.size })
    case "permission.resolved":
      if (!session.pending.delete(event.requestID)) return info
      return next({
        pendingPermissions: session.pending.size,
        status: session.pending.size === 0 && info.status === "needs_approval" ? "working" : info.status,
      })
    case "turn.completed":
      session.pending.clear()
      return next({ status: "idle", pendingPermissions: 0 })
    case "error":
      return next({ error: event.message })
    default:
      return info
  }
}

// History is a compacted view: a completed message replaces its deltas, a tool keeps only its latest
// state, consecutive deltas of one message merge, and only the newest HISTORY_LIMIT entries stay.
// The last entry always carries the newest seq.
function append(session: Live, envelope: AgentHQ.AgentEventEnvelope) {
  const event = envelope.event
  const last = session.history.at(-1)
  if (
    event.type === "message.delta" &&
    last?.event.type === "message.delta" &&
    last.event.messageID === event.messageID
  ) {
    session.history[session.history.length - 1] = {
      ...envelope,
      event: { ...event, text: last.event.text + event.text },
    }
    return
  }
  if (event.type === "message")
    session.history = session.history.filter(
      (item) => !(item.event.type === "message.delta" && item.event.messageID === event.messageID),
    )
  if (event.type === "tool")
    session.history = session.history.filter(
      (item) => !(item.event.type === "tool" && item.event.callID === event.callID),
    )
  session.history.push(envelope)
  if (session.history.length > HISTORY_LIMIT) session.history.splice(0, session.history.length - HISTORY_LIMIT)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    AgentRegistry.node,
    Storage.node,
    EventV2Bridge.node,
    EventV2.node,
    InstanceStore.node,
    Session.node,
    SessionPrompt.node,
    Permission.node,
    Agent.node,
    AppProcess.node,
    ReviewChanges.node, // spicy: review hook
  ],
})

export * as AgentSessions from "./session"
