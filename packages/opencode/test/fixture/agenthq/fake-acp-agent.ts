// A scripted ACP agent for Agent HQ contract tests. The prompt text picks the script:
//   "plan"  → plan, thought, text, an edit tool with a diff, end_turn
//   "ask"   → asks permission (allow_once / reject_always) and reports the answer
//   "late"  → a message and a finished tool, then after its answer a late chunk and tool update for them
//   "crash" → writes to stderr and exits with code 3
//   other   → echoes the text
// session/load replays one old exchange, which the client must not record again.
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk"

const output = new WritableStream<Uint8Array>({
  write: (chunk) =>
    new Promise<void>((resolve, reject) => process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()))),
})
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on("end", () => controller.close())
  },
})

new AgentSideConnection(
  (client): Agent => {
    const say = (sessionId: string, text: string) =>
      client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      })
    return {
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
      newSession: async () => ({ sessionId: "fake-session" }),
      loadSession: async (params) => {
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } },
        })
        await say(params.sessionId, "old reply")
        return {}
      },
      authenticate: async () => ({}),
      cancel: async () => {},
      prompt: async (params) => {
        const sessionId = params.sessionId
        const text = params.prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        if (text === "crash") {
          process.stderr.write("boom\n")
          process.exit(3)
        }
        if (text === "plan") {
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "plan",
              entries: [
                { content: "read the file", status: "completed", priority: "high" },
                { content: "edit the file", status: "in_progress", priority: "medium" },
              ],
            },
          })
          await client.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
          })
          await say(sessionId, "planned")
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "t1",
              title: "Edit x.txt",
              kind: "edit",
              status: "pending",
            },
          })
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "t1",
              status: "completed",
              content: [
                { type: "diff", path: "/tmp/agenthq-x.txt", oldText: "", newText: "x" },
                { type: "content", content: { type: "text", text: "edited" } },
              ],
            },
          })
          return { stopReason: "end_turn" }
        }
        if (text === "late") {
        await client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "first" } },
        })
        await client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "t9", title: "Read", kind: "read", status: "completed" },
        })
        // Out of protocol on purpose: updates for a finished message and tool after the turn's answer.
        setTimeout(() => {
          void client.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " late" } },
          })
          void client.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: "t9", status: "in_progress" },
          })
        }, 30)
        return { stopReason: "end_turn" }
      }
      if (text === "ask") {
          const answer = await client.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t2", title: "Delete everything", kind: "delete", rawInput: { path: "/" } },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "never", name: "Never", kind: "reject_always" },
            ],
          })
          await say(
            sessionId,
            answer.outcome.outcome === "selected" ? `answer: ${answer.outcome.optionId}` : "answer: cancelled",
          )
          return { stopReason: "end_turn" }
        }
        await say(sessionId, `echo: ${text}`)
        return { stopReason: "end_turn" }
      },
    }
  },
  ndJsonStream(output, input),
)
