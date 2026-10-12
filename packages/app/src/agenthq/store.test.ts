import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { agentAttention, agentSessions, coalesceDeltas, createAgentHQStore } from "./store"

const sid = "ags_one" as AgentHQ.AgentSessionID
const agentID = "agt_one" as AgentHQ.AgentID

const env = (seq: number, event: AgentHQ.AgentEvent, sessionID = sid): AgentHQ.AgentEventEnvelope => ({
  sessionID,
  seq,
  at: seq,
  event,
})
const delta = (messageID: string, text: string): AgentHQ.AgentEvent => ({ type: "message.delta", messageID, text })
const info = (status: AgentHQ.AgentSessionStatus, extra: Partial<AgentHQ.AgentSessionInfo> = {}) =>
  ({
    id: sid,
    agentID,
    provider: "opencode",
    status,
    pendingPermissions: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as AgentHQ.AgentSessionInfo

function withStore(run: (store: ReturnType<typeof createAgentHQStore>) => void) {
  createRoot((dispose) => {
    run(createAgentHQStore())
    dispose()
  })
}

function messageText(store: ReturnType<typeof createAgentHQStore>, messageID: string) {
  const item = store.state.feeds[sid]?.items.find((entry) => entry.key === `message:${messageID}`)
  return item?.kind === "message" ? item.text : undefined
}

describe("agent hq store", () => {
  test("buffers message deltas until the frame flushes", () => {
    withStore((store) => {
      store.watch(sid)
      store.loadHistory(info("working"), [])
      ;["Hel", "lo", " world"].forEach((text, index) => store.receive(env(index, delta("m1", text))))
      expect(store.state.feeds[sid]?.items).toHaveLength(0)
      store.flush()
      expect(store.state.feeds[sid]?.items).toEqual([
        { kind: "message", key: "message:m1", role: "assistant", text: "Hello world", reasoning: "", final: false },
      ])
    })
  })

  test("a complete message replaces its streamed text and ends streaming; reasoning is replaced", () => {
    withStore((store) => {
      store.watch(sid)
      store.loadHistory(info("working"), [])
      store.receive(env(0, delta("m1", "Hel")))
      store.receive(env(1, { type: "reasoning", messageID: "r1", text: "Plan" }))
      store.receive(env(2, { type: "reasoning", messageID: "r1", text: "Plan, revised" }))
      store.flush()
      const item = (key: string) => store.state.feeds[sid]?.items.find((entry) => entry.key === key)
      expect(item("message:m1")).toMatchObject({ text: "Hel", final: false })
      expect(item("message:r1")).toMatchObject({ text: "", reasoning: "Plan, revised", final: true })

      store.receive(env(3, { type: "message", messageID: "m1", role: "assistant", text: "Hello **world**" }))
      store.flush()
      expect(item("message:m1")).toMatchObject({ text: "Hello **world**", final: true })
    })
  })

  test("coalesces only consecutive deltas of the same message, keeping event order", () => {
    const tool: AgentHQ.AgentEvent = { type: "tool", callID: "c1", tool: "bash", state: "started" }
    const result = coalesceDeltas([
      env(0, delta("m1", "a")),
      env(1, delta("m1", "b")),
      env(2, tool),
      env(3, delta("m1", "c")),
      env(4, delta("m2", "x")),
      env(5, delta("m2", "y"), "ags_two" as AgentHQ.AgentSessionID),
    ])
    expect(
      result.map((item) => [item.seq, item.event.type === "message.delta" ? item.event.text : item.event.type]),
    ).toEqual([
      [1, "ab"],
      [2, "tool"],
      [3, "c"],
      [4, "x"],
      [5, "y"],
    ])
  })

  test("a seq gap holds later events and resyncs from history", () => {
    withStore((store) => {
      store.watch(sid)
      store.loadHistory(info("working"), [
        env(1, delta("a1", " there")),
        env(0, { type: "message", messageID: "a1", role: "assistant", text: "Hi" }),
      ])
      expect(messageText(store, "a1")).toBe("Hi there")

      expect(store.receive(env(1, delta("a1", " again")))).toBe("ignored")
      expect(store.receive(env(2, delta("a1", ",")))).toBe("queued")
      expect(store.receive(env(4, delta("a1", "!")))).toBe("gap")
      expect(store.receive(env(5, { type: "turn.completed", stopReason: "end_turn" }))).toBe("held")
      store.flush()
      expect(messageText(store, "a1")).toBe("Hi there,")

      const history = [
        env(0, { type: "message", messageID: "a1", role: "assistant", text: "Hi" }),
        env(1, delta("a1", " there")),
        env(2, delta("a1", ",")),
        env(3, delta("a1", " friend")),
        env(4, delta("a1", "!")),
      ]
      expect(store.loadHistory(info("working"), history)).toBe("ready")
      store.flush()
      expect(messageText(store, "a1")).toBe("Hi there, friend!")
      expect(store.state.feeds[sid]?.items.at(-1)).toEqual({
        kind: "note",
        key: "note:5",
        tone: "turn",
        text: "end_turn",
      })
      expect(store.receive(env(6, delta("a1", " Bye")))).toBe("queued")
    })
  })

  test("a gap inside held events asks for another resync", () => {
    withStore((store) => {
      store.watch(sid)
      expect(store.receive(env(0, delta("a1", "x")))).toBe("held")
      expect(store.receive(env(3, delta("a1", "z")))).toBe("held")
      expect(store.loadHistory(info("working"), [])).toBe("gap")
    })
  })

  test("a failed history load drops events until retried", () => {
    withStore((store) => {
      store.watch(sid)
      store.failHistory(sid, "boom")
      expect(store.state.feeds[sid]).toMatchObject({ status: "error", error: "boom" })
      expect(store.receive(env(0, delta("a1", "lost")))).toBe("ignored")

      expect(store.retry(sid)).toBe(true)
      expect(store.receive(env(1, delta("a1", " kept")))).toBe("held")
      expect(store.loadHistory(info("working"), [env(0, delta("a1", "found"))])).toBe("ready")
      store.flush()
      expect(messageText(store, "a1")).toBe("found kept")
      expect(store.state.feeds[sid]?.status).toBe("ready")
    })
  })

  test("permission requests stay pending until the server resolves them", () => {
    withStore((store) => {
      store.watch(sid)
      store.loadHistory(info("needs_approval", { pendingPermissions: 1 }), [
        env(0, {
          type: "permission.requested",
          requestID: "p1",
          title: "Run npm test",
          tool: "bash",
          options: [
            { id: "allow", label: "Allow once", kind: "allow_once" },
            { id: "deny", label: "Reject", kind: "reject_once" },
          ],
        }),
      ])
      const item = () => {
        const entry = store.state.feeds[sid]?.items[0]
        return entry?.kind === "permission" ? entry : undefined
      }
      expect(item()?.requestID).toBe("p1")
      expect(item()?.outcome).toBeUndefined()

      store.setResponding(sid, "p1", "allow")
      expect(item()?.responding).toBe("allow")
      expect(item()?.outcome).toBeUndefined()
      store.setResponding(sid, "p1", undefined, "network down")
      expect(item()?.responding).toBeUndefined()
      expect(item()?.outcome).toBeUndefined()
      expect(item()?.error).toBe("network down")

      store.setResponding(sid, "p1", "deny")
      store.receive(env(1, { type: "permission.resolved", requestID: "p1", outcome: "rejected" }))
      store.flush()
      expect(item()?.outcome).toBe("rejected")
      expect(item()?.responding).toBeUndefined()
    })
  })

  test("tool events update one row and cap its output", () => {
    withStore((store) => {
      store.watch(sid)
      store.loadHistory(info("working"), [
        env(0, { type: "tool", callID: "c1", tool: "bash", state: "started", title: "npm test" }),
        env(1, { type: "tool", callID: "c1", tool: "bash", state: "completed", output: "x".repeat(5000) }),
      ])
      const items = store.state.feeds[sid]?.items ?? []
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ kind: "tool", state: "completed", title: "npm test" })
      expect(items[0]?.kind === "tool" ? items[0].output?.length : 0).toBe(4001)
    })
  })

  test("watching a session twice subscribes once", () => {
    withStore((store) => {
      expect(store.watch(sid)).toBe(true)
      expect(store.watch(sid)).toBe(false)
      store.loadHistory(info("idle"), [])
      store.unwatch(sid)
      expect(store.state.feeds[sid]).toBeDefined()
      expect(store.receive(env(0, delta("a1", "still here")))).toBe("queued")
      store.unwatch(sid)
      expect(store.state.feeds[sid]).toBeUndefined()
      expect(store.receive(env(1, delta("a1", "gone")))).toBe("ignored")
      store.flush()
    })
  })

  test("attention: approvals first, failures only when latest, unseen completions", () => {
    withStore((store) => {
      const attention = () => agentAttention(agentSessions(store.state.sessions, agentID), store.state.unseen)
      store.setSessions([info("working")])
      expect(attention()).toBeUndefined()

      store.upsertSession(info("completed", { updatedAt: 2 }))
      expect(attention()).toBe("completed")
      store.watch(sid)
      expect(attention()).toBeUndefined()
      store.unwatch(sid)

      store.upsertSession(info("failed", { updatedAt: 3 }))
      expect(attention()).toBe("failed")
      store.upsertSession({ ...info("idle", { updatedAt: 4 }), id: "ags_newer" as AgentHQ.AgentSessionID })
      expect(attention()).toBeUndefined()

      store.upsertSession(info("failed", { updatedAt: 3, pendingPermissions: 1 }))
      expect(attention()).toBe("needs_approval")
    })
  })

  test("session updates replace optional fields instead of merging them", () => {
    withStore((store) => {
      store.upsertSession(info("failed", { error: "crashed" }))
      store.upsertSession(info("idle"))
      expect(store.state.sessions[sid]?.error).toBeUndefined()
    })
  })
})
