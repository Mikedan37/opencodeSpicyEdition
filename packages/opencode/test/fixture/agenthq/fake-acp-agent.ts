// A scripted ACP agent for Agent HQ contract tests. The prompt text picks the script:
//   "plan"  → plan, thought, text, an edit tool with a diff, end_turn
//   "ask"   → asks permission (allow_once / reject_always) and reports the answer
//   "late"  → a message and a finished tool, then after its answer a late chunk and tool update for them
//   "crash" → writes to stderr and exits with code 3
//   "hang"  → says "working", waits for session/cancel, then (out of protocol) says more and ends cancelled
//   "run"   → asks to execute `npm test` in <cwd>/pkg (rawInput command and cwd) and reports the answer
//   "codex-edit" → like codex-acp 2.2.2: the diff of hello.txt in a tool_call update, then a request with only its
//              locations; writes the file only when allowed, else fails the call
//   "change" → like AgentKit: proposes a change (apply / skip), with its diff; on apply writes src/fixed.txt in the session's cwd and
//              reports it as a diff with an absolute path and oldText null, then asks about an edit outside the
//              approved places (keep / undo)
//   other   → echoes the text
// session/load replays one old exchange, which the client must not record again.
// With FAKE_ACP_RECORD set, session/new writes its params (cwd, mcpServers) to that file.
// With FAKE_ACP_NO_LOAD set, it advertises no session/load, like AgentKit, and refuses one.
// With FAKE_ACP_STATE set, like AgentKit it keeps a folder <FAKE_ACP_STATE>/<pid> while it runs and removes it a moment
// after its input ends; a kill leaves it behind.
// With FAKE_ACP_AUTH_REQUIRED set, like a Cursor that is not logged in, session/new answers auth_required; a call to
// authenticate (which in Cursor opens a browser login) is recorded in <FAKE_ACP_RECORD>.authenticate.
import { AgentSideConnection, ndJsonStream, RequestError, type Agent } from "@agentclientprotocol/sdk"
import { mkdirSync, rmSync } from "fs"
import path from "path"

const state = process.env.FAKE_ACP_STATE && path.join(process.env.FAKE_ACP_STATE, String(process.pid))
if (state) mkdirSync(state, { recursive: true })

const output = new WritableStream<Uint8Array>({
  write: (chunk) =>
    new Promise<void>((resolve, reject) => process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()))),
})
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on("end", () => {
      controller.close()
      if (state) setTimeout(() => rmSync(state, { recursive: true, force: true }), 200)
    })
  },
})

// Resolves the prompt that "hang" holds open.
let cancelled: (() => void) | undefined
const noLoad = !!process.env.FAKE_ACP_NO_LOAD
let cwd = process.cwd()
let sessions = 0

new AgentSideConnection(
  (client): Agent => {
    const say = (sessionId: string, text: string) =>
      client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      })
    return {
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: !noLoad } }),
      newSession: async (params) => {
        if (process.env.FAKE_ACP_AUTH_REQUIRED) throw RequestError.authRequired()
        // Contract tests read what the client sent when they ask for it.
        if (process.env.FAKE_ACP_RECORD) await Bun.write(process.env.FAKE_ACP_RECORD, JSON.stringify(params))
        cwd = params.cwd
        // Without session/load every process starts sessions of its own.
        return { sessionId: noLoad ? `fake-session-${process.pid}-${++sessions}` : "fake-session" }
      },
      loadSession: async (params) => {
        if (noLoad) throw new Error("session/load is not supported")
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } },
        })
        await say(params.sessionId, "old reply")
        return {}
      },
      authenticate: async () => {
        if (process.env.FAKE_ACP_RECORD) await Bun.write(`${process.env.FAKE_ACP_RECORD}.authenticate`, "called")
        return {}
      },
      cancel: async () => cancelled?.(),
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
        if (text === "change") {
          const proposal = await client.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: "t-apply",
              title: "Apply the fix",
              kind: "edit",
              content: [{ type: "diff", path: `${cwd}/src/fixed.txt`, oldText: null, newText: "fixed\n" }],
            },
            options: [
              { optionId: "apply", name: "Apply", kind: "allow_once" },
              { optionId: "skip", name: "Skip", kind: "reject_once" },
            ],
          })
          if (proposal.outcome.outcome === "cancelled") return { stopReason: "cancelled" }
          if (proposal.outcome.optionId !== "apply") {
            await say(sessionId, "skipped")
            return { stopReason: "end_turn" }
          }
          const file = `${cwd}/src/fixed.txt`
          await Bun.write(file, "fixed\n")
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "t-apply",
              status: "completed",
              content: [{ type: "diff", path: file, oldText: null, newText: "fixed\n" }],
            },
          })
          const outside = await client.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t-outside", title: "An edit outside the approved files", kind: "edit" },
            options: [
              { optionId: "keep", name: "Keep", kind: "allow_once" },
              { optionId: "undo", name: "Undo", kind: "reject_once" },
            ],
          })
          await say(
            sessionId,
            outside.outcome.outcome === "selected" ? `outside: ${outside.outcome.optionId}` : "outside: cancelled",
          )
          return { stopReason: "end_turn" }
        }
        if (text === "hang") {
          await say(sessionId, "working")
          await new Promise<void>((resolve) => (cancelled = resolve))
          await say(sessionId, " after the cancel")
          return { stopReason: "cancelled" }
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
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "m1",
                content: { type: "text", text: " late" },
              },
            })
            void client.sessionUpdate({
              sessionId,
              update: { sessionUpdate: "tool_call_update", toolCallId: "t9", status: "in_progress" },
            })
          }, 30)
          return { stopReason: "end_turn" }
        }
        if (text === "codex-edit") {
          // Like codex-acp 2.2.2: the diff comes in the call's update, then the request names only the call and its
          // locations; a refusal fails the call.
          const file = `${cwd}/hello.txt`
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "t-codex",
              title: "Editing files",
              kind: "edit",
              status: "in_progress",
              content: [{ type: "diff", path: file, oldText: null, newText: "hi\n" }],
            },
          })
          const answer = await client.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t-codex", title: "Edit files", kind: "edit", locations: [{ path: file }] },
            options: [
              { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
              { optionId: "cancel", name: "No", kind: "reject_once" },
            ],
          })
          const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow_once"
          if (allowed) await Bun.write(file, "hi\n")
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "t-codex",
              status: allowed ? "completed" : "failed",
            },
          })
          await say(sessionId, allowed ? "wrote hello.txt" : "did not write hello.txt")
          return { stopReason: "end_turn" }
        }
        if (text === "run") {
          const answer = await client.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: "t-run",
              title: "`npm test`",
              kind: "execute",
              rawInput: { command: ["npm", "test"], cwd: `${cwd}/pkg` },
            },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          })
          await say(
            sessionId,
            answer.outcome.outcome === "selected" ? `run: ${answer.outcome.optionId}` : "run: cancelled",
          )
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
