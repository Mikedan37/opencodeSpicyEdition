import { batch } from "solid-js"
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"

type Envelope = AgentHQ.AgentEventEnvelope
type ToolState = Extract<AgentHQ.AgentEvent, { type: "tool" }>["state"]
export type PermissionOption = Extract<AgentHQ.AgentEvent, { type: "permission.requested" }>["options"][number]

export type FeedItem =
  | {
      kind: "message"
      key: string
      role: "user" | "assistant" | "system"
      text: string
      reasoning: string
      // false while deltas stream; the server sends the complete text once the block ends
      final: boolean
    }
  | { kind: "tool"; key: string; tool: string; state: ToolState; title?: string; output?: string }
  | {
      kind: "permission"
      key: string
      requestID: string
      title: string
      tool?: string
      details?: string
      // What it is about (UX #3): an edit's diff, a command, or one line; `details` is the fallback without it.
      preview?: AgentHQ.PermissionPreview
      options: readonly PermissionOption[]
      outcome?: "allowed" | "rejected" | "cancelled"
      // optionID whose answer is in flight; the item only resolves on the server's permission.resolved event
      responding?: string
      error?: string
    }
  | { kind: "note"; key: string; tone: "file" | "turn" | "error"; text: string }

export type Feed = { status: "loading" | "ready" | "error"; error?: string; items: FeedItem[] }

export const RUNNING_STATUSES: ReadonlySet<AgentHQ.AgentSessionStatus> = new Set([
  "starting",
  "thinking",
  "working",
  "needs_approval",
  "blocked",
])

// Adapters already cap tool output; this only bounds what a single row renders.
const OUTPUT_CAP = 4000

// Per watched session: last applied seq, and whether events apply live, wait for a history load, or are dropped
// because the last load failed (the user retries).
type Intake = { seq: number; mode: "live" | "loading" | "stale"; held: Envelope[] }

export type AgentHQStore = ReturnType<typeof createAgentHQStore>

// sessionID → the `updatedAt` the user has seen. Persisted by the caller, so a session that completes while the app is
// closed still shows as finished-but-unviewed on the next start.
export type SeenStore = [Record<string, number>, SetStoreFunction<Record<string, number>>]

export function createAgentHQStore(seenStore: SeenStore = createStore<Record<string, number>>({})) {
  const [seen, setSeen] = seenStore
  const [state, setState] = createStore({
    providers: [] as AgentHQ.ProviderStatus[],
    agents: [] as AgentHQ.AgentIdentity[],
    sessions: {} as Record<string, AgentHQ.AgentSessionInfo>,
    feeds: {} as Record<string, Feed>,
  })
  const watchers = new Map<string, number>()
  const intake = new Map<string, Intake>()
  let queue: Envelope[] = []
  let frame: number | undefined

  // Stream deltas land at most once per animation frame, one store write per message.
  function flush() {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    if (queue.length === 0) return
    const events = coalesceDeltas(queue)
    queue = []
    batch(() =>
      events.forEach((envelope) => {
        if (!state.feeds[envelope.sessionID]) return
        if (envelope.event.type !== "status")
          return setState(
            "feeds",
            envelope.sessionID,
            "items",
            produce((items) => applyEvent(items, envelope)),
          )
        if (state.sessions[envelope.sessionID])
          setState("sessions", envelope.sessionID, { status: envelope.event.status })
      }),
    )
  }

  // "gap" means the caller must reload this session's history; later events are held until it arrives.
  function receive(envelope: Envelope): "queued" | "held" | "ignored" | "gap" {
    const entry = intake.get(envelope.sessionID)
    if (!entry || entry.mode === "stale") return "ignored"
    if (entry.mode === "loading") {
      entry.held.push(envelope)
      return "held"
    }
    if (envelope.seq <= entry.seq) return "ignored"
    if (envelope.seq !== entry.seq + 1) {
      entry.mode = "loading"
      entry.held = [envelope]
      return "gap"
    }
    entry.seq = envelope.seq
    queue.push(envelope)
    // Hidden windows get no animation frames; flush directly once a backlog builds so the queue stays bounded.
    if (queue.length >= 2000) flush()
    if (frame === undefined && queue.length > 0) frame = requestAnimationFrame(flush)
    return "queued"
  }

  function loadHistory(info: AgentHQ.AgentSessionInfo, history: readonly Envelope[]): "ready" | "gap" | "ignored" {
    const entry = intake.get(info.id)
    if (!entry) return "ignored"
    flush()
    const sorted = history.toSorted((a, b) => a.seq - b.seq)
    const items: FeedItem[] = []
    sorted.forEach((envelope) => applyEvent(items, envelope))
    const held = entry.held
    entry.seq = sorted.at(-1)?.seq ?? -1
    entry.mode = "live"
    entry.held = []
    batch(() => {
      setState("sessions", info.id, reconcile(info))
      setSeen(info.id, info.updatedAt)
      setState("feeds", info.id, { status: "ready", error: undefined })
      setState("feeds", info.id, "items", reconcile(items, { key: "key" }))
    })
    return held.some((envelope) => receive(envelope) === "gap") ? "gap" : "ready"
  }

  function failHistory(sessionID: string, error: string) {
    const entry = intake.get(sessionID)
    if (!entry) return
    entry.mode = "stale"
    entry.held = []
    setState("feeds", sessionID, { status: "error", error })
  }

  // Returns true when the caller must load history: only the first watcher of a session subscribes.
  function watch(sessionID: string) {
    const count = watchers.get(sessionID) ?? 0
    watchers.set(sessionID, count + 1)
    const info = state.sessions[sessionID]
    if (info) setSeen(sessionID, info.updatedAt)
    if (count > 0) return false
    intake.set(sessionID, { seq: -1, mode: "loading", held: [] })
    setState("feeds", sessionID, { status: "loading", items: [] })
    return true
  }

  function unwatch(sessionID: string) {
    const count = (watchers.get(sessionID) ?? 0) - 1
    if (count > 0) return void watchers.set(sessionID, count)
    watchers.delete(sessionID)
    intake.delete(sessionID)
    queue = queue.filter((envelope) => envelope.sessionID !== sessionID)
    setState(
      "feeds",
      produce((feeds) => {
        delete feeds[sessionID]
      }),
    )
  }

  // Retry after a failed load; returns false when nobody watches the session anymore.
  function retry(sessionID: string) {
    const entry = intake.get(sessionID)
    if (!entry) return false
    entry.mode = "loading"
    entry.held = []
    setState("feeds", sessionID, { status: "loading", error: undefined })
    return true
  }

  function upsertSession(info: AgentHQ.AgentSessionInfo) {
    batch(() => {
      // Updates are seen while a view shows the session. A session met for the first time counts as seen unless
      // it arrives completed, so a completion nobody watched earns an attention badge.
      if (watchers.has(info.id)) setSeen(info.id, info.updatedAt)
      if (!watchers.has(info.id) && seen[info.id] === undefined)
        setSeen(info.id, info.status === "completed" ? 0 : info.updatedAt)
      setState("sessions", info.id, reconcile(info))
    })
  }

  function setResponding(sessionID: string, requestID: string, optionID?: string, error?: string) {
    if (!state.feeds[sessionID]) return
    setState(
      "feeds",
      sessionID,
      "items",
      (item) => item.key === `permission:${requestID}`,
      produce((item) => {
        if (item.kind !== "permission") return
        item.responding = optionID
        item.error = error
      }),
    )
  }

  return {
    state,
    seen,
    receive,
    flush,
    loadHistory,
    failHistory,
    watch,
    unwatch,
    retry,
    upsertSession,
    setResponding,
    setProviders: (providers: readonly AgentHQ.ProviderStatus[]) =>
      setState("providers", reconcile([...providers], { key: "id" })),
    upsertProvider: (provider: AgentHQ.ProviderStatus) => {
      const index = state.providers.findIndex((item) => item.id === provider.id)
      if (index === -1) return setState("providers", state.providers.length, provider)
      setState("providers", index, reconcile(provider))
    },
    setAgents: (agents: readonly AgentHQ.AgentIdentity[]) => setState("agents", reconcile([...agents], { key: "id" })),
    upsertAgent: (agent: AgentHQ.AgentIdentity) => {
      const index = state.agents.findIndex((item) => item.id === agent.id)
      if (index === -1) return setState("agents", state.agents.length, agent)
      setState("agents", index, reconcile(agent))
    },
    removeAgent: (id: string) => setState("agents", (list) => list.filter((item) => item.id !== id)),
    // Initial load: sessions met for the first time count as seen; marks of sessions that no longer exist are dropped.
    setSessions: (sessions: readonly AgentHQ.AgentSessionInfo[]) =>
      batch(() => {
        setState("sessions", reconcile(Object.fromEntries(sessions.map((session) => [session.id, session]))))
        setSeen(
          reconcile(Object.fromEntries(sessions.map((session) => [session.id, seen[session.id] ?? session.updatedAt]))),
        )
      }),
  }
}

export function coalesceDeltas(envelopes: readonly Envelope[]) {
  return envelopes.reduce<Envelope[]>((output, next) => {
    const last = output.at(-1)
    if (
      last?.event.type === "message.delta" &&
      next.event.type === "message.delta" &&
      last.sessionID === next.sessionID &&
      last.event.messageID === next.event.messageID
    ) {
      output[output.length - 1] = { ...next, event: { ...next.event, text: last.event.text + next.event.text } }
      return output
    }
    output.push(next)
    return output
  }, [])
}

// Folds one event into a feed. Used on plain arrays (history) and on store drafts (live).
export function applyEvent(items: FeedItem[], envelope: Envelope) {
  const event = envelope.event
  if (event.type === "message" || event.type === "message.delta" || event.type === "reasoning") {
    const key = `message:${event.messageID}`
    const item = items.findLast((entry) => entry.key === key)
    if (item?.kind !== "message") {
      items.push({
        kind: "message",
        key,
        role: event.type === "message" ? event.role : "assistant",
        text: event.type === "reasoning" ? "" : event.text,
        reasoning: event.type === "reasoning" ? event.text : "",
        final: event.type !== "message.delta",
      })
      return
    }
    if (event.type === "message") {
      item.role = event.role
      item.text = event.text
      item.final = true
      return
    }
    if (event.type === "message.delta") {
      item.text += event.text
      return
    }
    // The server sends a reasoning block's full text once (a rewrite repeats it): replace, never append.
    item.reasoning = event.text
    return
  }
  if (event.type === "tool") {
    const key = `tool:${event.callID}`
    const output =
      event.output !== undefined && event.output.length > OUTPUT_CAP
        ? event.output.slice(0, OUTPUT_CAP) + "…"
        : event.output
    const item = items.findLast((entry) => entry.key === key)
    if (item?.kind !== "tool") {
      items.push({ kind: "tool", key, tool: event.tool, state: event.state, title: event.title, output })
      return
    }
    item.state = event.state
    if (event.title !== undefined) item.title = event.title
    if (output !== undefined) item.output = output
    return
  }
  if (event.type === "permission.requested") {
    const key = `permission:${event.requestID}`
    if (items.some((entry) => entry.key === key)) return
    items.push({
      kind: "permission",
      key,
      requestID: event.requestID,
      title: event.title,
      tool: event.tool,
      details: event.details,
      preview: event.preview,
      options: event.options,
    })
    return
  }
  if (event.type === "permission.resolved") {
    const item = items.findLast((entry) => entry.key === `permission:${event.requestID}`)
    if (item?.kind !== "permission") return
    item.outcome = event.outcome
    item.responding = undefined
    return
  }
  const key = `note:${envelope.seq}`
  if (event.type === "file.changed") return void items.push({ kind: "note", key, tone: "file", text: event.path })
  if (event.type === "turn.completed")
    return void items.push({ kind: "note", key, tone: "turn", text: event.stopReason ?? "" })
  if (event.type === "error") return void items.push({ kind: "note", key, tone: "error", text: event.message })
}

// Newest first.
export function agentSessions(sessions: Record<string, AgentHQ.AgentSessionInfo>, agentID: string) {
  return Object.values(sessions)
    .filter((session) => session.agentID === agentID)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
}

// A session that stopped working (the server reports a finished turn as `idle`) after the user last looked at it.
export function isUnseen(session: AgentHQ.AgentSessionInfo, seen: Record<string, number>) {
  return (
    (session.status === "completed" || session.status === "idle") &&
    session.updatedAt > (seen[session.id] ?? session.updatedAt)
  )
}

// `sessions` must be newest first; a failed session only counts while it is the latest one.
export function agentAttention(
  sessions: readonly AgentHQ.AgentSessionInfo[],
  seen: Record<string, number>,
): "needs_approval" | "failed" | "completed" | undefined {
  if (sessions.some((session) => session.status === "needs_approval" || session.pendingPermissions > 0))
    return "needs_approval"
  if (sessions[0]?.status === "failed") return "failed"
  if (sessions.some((session) => isUnseen(session, seen))) return "completed"
}
