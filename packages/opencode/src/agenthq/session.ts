// Agent HQ session manager.
//
// Process-global rather than InstanceState: an agent session belongs to its identity's project, not to
// the directory a client happens to be routed to, and must stay reachable from any instance while the
// provider runs in its own project's instance. Records live in the global JSON store.
//
// Every event, from the provider or from the manager itself (user message, cancel), goes through one
// queue per session, and a single consumer fiber is the only writer: it drains the queue in batches,
// coalesces text deltas, assigns gap-free `seq`, keeps a capped compacted history, persists, and
// publishes. Events are therefore recorded in the order they were emitted; nothing taken from the
// queue can be overtaken by a later event.
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Scope } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { EventV2 } from "@opencode-ai/core/event"
import { AgentProvider } from "./provider"
import { AgentRegistry } from "./registry"
import { AgentStore } from "./store"
import { AcpProvider } from "./providers/acp"
import { ClaudeCodeProvider } from "./providers/claude-code"
import { AgentDetect } from "./providers/detect"
import { OpenCodeProvider } from "./providers/opencode"
import { AgentWorkbench } from "./workbench"
import { ReviewChanges } from "@/review/changes" // spicy: review hook

export const ACTIVE = new Set<AgentHQ.AgentSessionStatus>([
  "starting",
  "thinking",
  "working",
  "needs_approval",
  "blocked",
])
// What a turn produces. It is recorded only while the provider owes the session a turn.
const TURN = new Set<AgentHQ.AgentEvent["type"]>([
  "message.delta",
  "message",
  "reasoning",
  "tool",
  "plan",
  "file.changed",
  "turn.completed",
])
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

/** A queued event; manager events carry `done` so the caller can wait until they are recorded. */
interface Entry {
  readonly event: AgentHQ.AgentEvent
  readonly done?: Deferred.Deferred<void>
}

interface Live {
  info: AgentHQ.AgentSessionInfo
  readonly agent: AgentHQ.AgentIdentity
  seq: number
  history: AgentHQ.AgentEventEnvelope[]
  persisted: number
  readonly pending: Set<string>
  readonly queue: Queue.Queue<Entry>
  /**
   * Messages of this turn that have their final text, and tools of this turn that reached a final state: later
   * output for them is stale. Per turn, because some models number tool calls per turn.
   */
  readonly final: Set<string>
  readonly tools: Set<string>
  /** Turns the provider still owes: one per user message, closed by its end, all closed by a cancel. */
  owed: number
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
  readonly start: (agentID: AgentHQ.AgentID, input?: StartInput) => Effect.Effect<AgentHQ.AgentSessionInfo, Failure>
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

export interface StartInput {
  readonly title?: string
  /** Run somewhere other than the identity's own directory, such as a task's worktree. */
  readonly workingDirectory?: string
  readonly taskID?: AgentHQ.TaskID
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentHQSessions") {}

const customAcp: AgentHQ.ProviderStatus = {
  id: "acp",
  name: "Custom ACP agent",
  available: true,
  auth: "unknown",
  capabilities: {
    ...AcpProvider.capabilities,
    notes: ["Spawns the identity's launch command", ...(AcpProvider.capabilities.notes ?? [])],
  },
}

const sessionKey = (id: string) => ["agenthq", "session", id]
const historyKey = (id: string) => ["agenthq", "events", id]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* AgentStore.Service
    const events = yield* EventV2Bridge.Service
    const registry = yield* AgentRegistry.Service
    const review = yield* ReviewChanges.Service // spicy: review hook
    const scope = yield* Scope.Scope
    const providers: Record<AgentHQ.ProviderID, AgentProvider.Interface> = {
      opencode: yield* OpenCodeProvider.make,
      "claude-code": yield* ClaudeCodeProvider.make({
        status: yield* AgentDetect.prober("claude-code", ClaudeCodeProvider.capabilities),
        binary: () => AgentDetect.binary("claude-code"),
      }),
      cursor: yield* AgentDetect.cursor(),
      codex: yield* AgentDetect.make("codex"),
      acp: yield* AcpProvider.make({
        id: "acp",
        status: Effect.succeed(customAcp),
        launch: (agent) =>
          agent.launch?.command
            ? Effect.succeed(agent.launch)
            : Effect.fail(
                new AgentProvider.UnsupportedError({
                  provider: "acp",
                  action: "createSession",
                  message: `Agent ${agent.name} has no ACP launch command`,
                }),
              ),
      }),
    }
    const live = new Map<string, Live>()
    // `locks` serializes operations on a session (load, attach, provider calls); `writes` lets a reader see a
    // session between recorded batches, never in the middle of one.
    const locks = KeyedMutex.makeUnsafe<string>()
    const lock = (id: string) => locks.withLock(id)
    const writes = KeyedMutex.makeUnsafe<string>()

    // ---------------------------------------------------------------- recording

    // Only the session's consumer (and the shutdown finalizer, once consumers are gone) calls this.
    const record = Effect.fnUntraced(function* (session: Live, input: readonly AgentHQ.AgentEvent[]) {
      const before = session.info
      const published: AgentHQ.AgentEventEnvelope[] = []
      for (const next of coalesce(input)) {
        if (stale(session, next)) continue
        // A turn that ends answers its open permission requests, so nothing is left waiting.
        const ending = next.type === "turn.completed" || (next.type === "status" && !ACTIVE.has(next.status))
        const closing = ending
          ? [...session.pending].map(
              (requestID): AgentHQ.AgentEvent => ({ type: "permission.resolved", requestID, outcome: "cancelled" }),
            )
          : []
        for (const event of [...closing, next]) {
          account(session, event)
          const info = apply(session, event)
          // A status that changes nothing (repeated busy, progress while a permission waits) is not news.
          if (event.type === "status" && info === session.info) continue
          session.info = info
          track(session, event)
          // A provider that lost its process or instance is detached; the next message attaches again.
          if (event.type === "status" && event.status === "disconnected" && session.handle) {
            yield* session.handle.close
            session.handle = undefined
          }
          const envelope = { sessionID: session.info.id, seq: session.seq++, at: Date.now(), event }
          append(session, envelope)
          published.push(envelope)
        }
      }
      if (published.length === 0) return
      const now = Date.now()
      if (
        published.some((item) => item.event.type !== "message.delta") ||
        now - session.persisted >= PERSIST_INTERVAL
      ) {
        session.persisted = now
        yield* store.write(historyKey(session.info.id), session.history).pipe(Effect.orDie)
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
      store.write(sessionKey(session.info.id), { ...session.info, pid: process.pid }).pipe(Effect.orDie)

    const emitter =
      (session: Live): AgentProvider.Emit =>
      (event) => {
        Queue.offerUnsafe(session.queue, { event })
      }

    /** Queue manager events behind everything already emitted and wait until they are recorded. */
    const submit = Effect.fnUntraced(function* (session: Live, events: readonly AgentHQ.AgentEvent[]) {
      const done = yield* Deferred.make<void>()
      events.forEach((event, index) =>
        Queue.offerUnsafe(session.queue, index === events.length - 1 ? { event, done } : { event }),
      )
      if (events.length > 0) yield* Deferred.await(done)
    })

    // One consumer per session: the only writer of its history and the only path to the event bus.
    const consume = (session: Live) =>
      Effect.gen(function* () {
        const first = yield* Queue.takeAll(session.queue)
        const batch = first.every((entry) => entry.event.type === "message.delta")
          ? [...first, ...(yield* Effect.sleep(DELTA_LINGER).pipe(Effect.andThen(Queue.clear(session.queue))))]
          : first
        yield* writes
          .withLock(session.info.id)(
            record(
              session,
              batch.map((entry) => entry.event),
            ),
          )
          .pipe(
            Effect.ensuring(
              Effect.forEach(batch, (entry) => (entry.done ? Deferred.succeed(entry.done, undefined) : Effect.void), {
                discard: true,
              }),
            ),
          )
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

    const readStored = (id: string) => store.find(sessionKey(id), decodeStored)

    // An unreadable history is never treated as empty: whoever loads the session quarantines it first.
    const readHistory = (id: string) => store.read(historyKey(id), decodeHistory)

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
      // A history that cannot be read is moved aside before anything is recorded, so it is never overwritten; a read
      // error fails the load for the same reason.
      const read = yield* readHistory(id).pipe(Effect.orDie)
      const reason = read._tag === "corrupt" ? read.reason : undefined
      const quarantined = reason ? yield* store.quarantine(historyKey(id), reason).pipe(Effect.orDie) : undefined
      const history = read._tag === "found" ? [...read.value] : []
      const session = yield* register({
        info: strip(stored.value),
        agent: placed(agent, stored.value.workingDirectory),
        seq: (history.at(-1)?.seq ?? -1) + 1,
        history,
        persisted: Date.now(),
        pending: new Set(),
        queue: yield* Queue.unbounded<Entry>(),
        final: new Set(),
        tools: new Set(),
        owed: 0,
      })
      if (quarantined)
        yield* submit(session, [
          {
            type: "error",
            message: `This session's history could not be read (${reason}); it was quarantined as ${path.basename(quarantined)}`,
          },
          { type: "status", status: "interrupted" },
        ])
      return session
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
        workbench: yield* AgentWorkbench.server(session.agent.workingDirectory ?? session.agent.projectDirectory),
      })
      return session.handle
    })

    const records = Effect.fnUntraced(function* () {
      const ids = yield* store.list(["agenthq", "session"])
      const found = yield* Effect.forEach(ids, readStored, { concurrency: 8 })
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
                Effect.flatMap((session) => submit(session, [{ type: "status", status: "interrupted" }])),
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
            // The consumers are already stopped, so this is the only writer left.
            const queued = (yield* Queue.clear(session.queue)).map((entry) => entry.event)
            yield* record(session, [...queued, { type: "status", status: "interrupted" }])
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

    const start = Effect.fn("AgentHQSessions.start")(function* (agentID: AgentHQ.AgentID, input?: StartInput) {
      yield* ready
      const agent = placed(yield* registry.get(agentID), input?.workingDirectory)
      const now = Date.now()
      const session: Live = {
        info: {
          id: AgentHQ.AgentSessionID.create(),
          agentID,
          provider: agent.provider,
          ...(input?.title ? { title: input.title } : {}),
          ...(input?.taskID ? { taskID: input.taskID } : {}),
          ...(input?.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
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
        queue: yield* Queue.unbounded<Entry>(),
        final: new Set(),
        tools: new Set(),
        owed: 0,
      }
      // Ask the provider first: an unsupported or failing provider leaves no record behind.
      const handle = yield* providers[agent.provider].createSession({
        agent,
        ...(input?.title ? { title: input.title } : {}),
        emit: emitter(session),
        workbench: yield* AgentWorkbench.server(agent.workingDirectory ?? agent.projectDirectory),
      })
      session.handle = handle
      session.info = { ...session.info, providerSessionID: handle.providerSessionID }
      return yield* lock(session.info.id)(
        Effect.gen(function* () {
          yield* register(session)
          yield* submit(session, [{ type: "status", status: "idle" }])
          return session.info
        }),
      )
    })

    const get = Effect.fn("AgentHQSessions.get")(function* (sessionID: AgentHQ.AgentSessionID) {
      yield* ready
      const current = live.get(sessionID)
      // Between recorded batches, so a reader never sees an envelope before it was persisted and published.
      if (current)
        return yield* writes.withLock(sessionID)(
          Effect.sync(() => ({ session: current.info, history: [...current.history] })),
        )
      const stored = yield* readStored(sessionID)
      if (Option.isNone(stored)) return yield* missing(sessionID)
      const history = yield* readHistory(sessionID).pipe(Effect.orElseSucceed(() => ({ _tag: "missing" }) as const))
      // The process that drives the session quarantines an unreadable history and reports it, as a load does.
      if (history._tag === "corrupt" && owned(stored.value)) {
        const session = yield* lock(sessionID)(load(sessionID)).pipe(Effect.mapError(() => missing(sessionID)))
        return yield* writes.withLock(sessionID)(
          Effect.sync(() => ({ session: session.info, history: [...session.history] })),
        )
      }
      return { session: strip(stored.value), history: history._tag === "found" ? history.value : [] }
    })

    const send = Effect.fn("AgentHQSessions.send")(function* (sessionID: AgentHQ.AgentSessionID, text: string) {
      if (!text.trim()) return yield* new AgentProvider.InvalidInputError({ message: "text must not be empty" })
      yield* ready
      yield* lock(sessionID)(
        Effect.gen(function* () {
          const session = yield* load(sessionID)
          const handle = yield* attach(session)
          yield* submit(session, [
            { type: "message", messageID: crypto.randomUUID(), role: "user", text },
            { type: "status", status: "working" },
          ])
          yield* handle.send(text).pipe(
            Effect.tapError((error) =>
              submit(session, [
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
          // Queued behind whatever the provider emitted while cancelling; a session with no active turn stays as
          // it is, and open permission requests are answered `cancelled` when the status is recorded.
          yield* submit(session, [{ type: "status", status: "cancelled" }])
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
              yield* store.remove(sessionKey(item.id)).pipe(Effect.ignore)
              yield* store.remove(historyKey(item.id)).pipe(Effect.ignore)
            }),
          ),
        { discard: true },
      )
    })

    return Service.of({ providers: providerStatus, list, start, get, send, cancel, respond, forget })
  }),
)

/** The identity as a session sees it: a task session runs in the task's working directory. */
function placed(agent: AgentHQ.AgentIdentity, workingDirectory: string | undefined): AgentHQ.AgentIdentity {
  return workingDirectory ? { ...agent, workingDirectory } : agent
}

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

/**
 * Output that can no longer be right, whichever provider sends it: anything more for a message that already has
 * its final text, a tool update after the tool finished, or turn output when no turn is owed (after the turn
 * ended or was cancelled, until the next user message).
 */
function stale(session: Live, event: AgentHQ.AgentEvent) {
  if (event.type === "message" && event.role === "user") return false
  if ((event.type === "message" || event.type === "message.delta") && session.final.has(event.messageID)) return true
  if (event.type === "tool" && session.tools.has(event.callID)) return true
  return session.owed === 0 && TURN.has(event.type)
}

/** Turn bookkeeping for `stale`; runs for every recorded event, before a no-op status is skipped. */
function account(session: Live, event: AgentHQ.AgentEvent) {
  if (event.type === "message" && event.role === "user") {
    session.owed++
    session.final.clear()
    session.tools.clear()
  }
  if (event.type === "turn.completed" || (event.type === "status" && event.status === "failed"))
    session.owed = Math.max(0, session.owed - 1)
  if (event.type === "status" && ["cancelled", "disconnected", "interrupted"].includes(event.status)) session.owed = 0
}

function track(session: Live, event: AgentHQ.AgentEvent) {
  if (event.type === "message") session.final.add(event.messageID)
  if (event.type === "tool" && (event.state === "completed" || event.state === "error")) session.tools.add(event.callID)
}

function apply(session: Live, event: AgentHQ.AgentEvent): AgentHQ.AgentSessionInfo {
  const info = session.info
  const next = (patch: Partial<AgentHQ.AgentSessionInfo>) => ({ ...info, ...patch, updatedAt: Date.now() })
  switch (event.type) {
    case "status":
      if (info.status === event.status) return info
      if (event.status === "cancelled" && !ACTIVE.has(info.status)) return info
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
    case "title":
      return event.title === info.title ? info : next({ title: event.title })
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
  // A final message replaces its deltas and a tool update its earlier states, within the current turn only:
  // some models number tool calls per turn, and an earlier turn's entries must stay.
  if (event.type === "message" || event.type === "tool") {
    const turn = session.history.findLastIndex((item) => item.event.type === "message" && item.event.role === "user")
    const replaced = (item: AgentHQ.AgentEventEnvelope) =>
      event.type === "tool"
        ? item.event.type === "tool" && item.event.callID === event.callID
        : item.event.type === "message.delta" && item.event.messageID === event.messageID
    session.history = [
      ...session.history.slice(0, turn + 1),
      ...session.history.slice(turn + 1).filter((item) => !replaced(item)),
    ]
  }
  session.history.push(envelope)
  if (session.history.length > HISTORY_LIMIT) session.history.splice(0, session.history.length - HISTORY_LIMIT)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    AgentRegistry.node,
    AgentStore.node,
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
