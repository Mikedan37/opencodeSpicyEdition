import { describe, expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { createAgentHQStore } from "@/agenthq/store"

const sid = "ags_frames" as AgentHQ.AgentSessionID

const info = {
  id: sid,
  agentID: "agt_frames",
  provider: "opencode",
  status: "working",
  pendingPermissions: 0,
  createdAt: 1,
  updatedAt: 1,
} as AgentHQ.AgentSessionInfo

describe("agent hq streaming", () => {
  test("token deltas reach the store once per frame and touch only their message", () => {
    createRoot((dispose) => {
      const store = createAgentHQStore()
      store.watch(sid)
      store.loadHistory(info, [
        { sessionID: sid, seq: 0, at: 0, event: { type: "message", messageID: "u1", role: "user", text: "Hi" } },
      ])
      const writes = { user: 0, reply: [] as string[], list: 0 }
      createComputed(() => {
        const item = store.state.feeds[sid]?.items[0]
        if (item?.kind === "message") writes.user += item.text.length > 0 ? 1 : 0
      })
      createComputed(() => {
        const item = store.state.feeds[sid]?.items[1]
        if (item?.kind === "message") writes.reply.push(item.text)
      })
      createComputed(() => {
        store.state.feeds[sid]?.items.length
        writes.list++
      })

      const send = (seq: number, text: string) =>
        store.receive({ sessionID: sid, seq, at: seq, event: { type: "message.delta", messageID: "a1", text } })
      Array.from({ length: 50 }, (_, index) => send(index + 1, "x"))
      store.flush()
      Array.from({ length: 50 }, (_, index) => send(index + 51, "y"))
      store.flush()

      expect(writes.reply).toEqual(["x".repeat(50), "x".repeat(50) + "y".repeat(50)])
      expect(writes.user).toBe(1)
      // initial run + the one append that created the reply row
      expect(writes.list).toBe(2)
      dispose()
    })
  })
})
