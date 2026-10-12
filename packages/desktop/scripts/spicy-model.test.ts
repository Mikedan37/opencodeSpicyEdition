import { afterAll, expect, test } from "bun:test"
import { INTRO, serveScriptedModel } from "./spicy-model"

// spicy: the scripted demo model streams OpenAI-compatible chunks, answers title requests and records aborts.
const model = serveScriptedModel({ wordDelayMs: 1, slowWordDelayMs: 20 })
afterAll(() => model.stop())

const post = (body: unknown, signal?: AbortSignal) =>
  fetch(`${model.url}/chat/completions`, { method: "POST", body: JSON.stringify(body), signal })

test("streams the scripted reply word by word and ends with [DONE]", async () => {
  const text = await post({
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }).then((res) => res.text())
  const lines = text.split("\n").filter((line) => line.startsWith("data: "))
  expect(lines.at(-1)).toBe("data: [DONE]")
  const chunks = lines.slice(0, -1).map((line) => JSON.parse(line.slice(6)))
  expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe(INTRO)
  expect(chunks.at(-1).choices[0].finish_reason).toBe("stop")
  expect(chunks.length).toBeGreaterThan(20)
})

test("answers title requests with a short title", async () => {
  const body = await post({
    stream: false,
    messages: [
      { role: "system", content: "You are a title generator. You output ONLY a thread title." },
      { role: "user", content: "anything" },
    ],
  }).then((res) => res.json())
  expect(body.choices[0].message.content).toBe("Felix demo")
})

test("records a client abort of a slow reply", async () => {
  const abort = new AbortController()
  const res = await post({ stream: true, messages: [{ role: "user", content: "something slow" }] }, abort.signal)
  await res.body!.getReader().read()
  abort.abort()
  await Bun.sleep(100)
  expect(model.requests.at(-1)).toMatchObject({ kind: "chat", prompt: "something slow", aborted: true })
})

test("plays a script: one tool call per step, then text, per conversation", async () => {
  const scripted = serveScriptedModel({
    scripts: {
      "EDIT notes": [
        { tool: "write", input: { filePath: "notes.txt", content: "hi\n" } },
        { text: "Wrote notes.txt." },
      ],
    },
  })
  try {
    const user = { role: "user", content: [{ type: "text", text: "Please EDIT notes now" }] }
    const chunks = async (messages: unknown[]) =>
      (
        await fetch(`${scripted.url}/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ stream: true, messages }),
        }).then((res) => res.text())
      )
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)))

    const first = await chunks([{ role: "system", content: "You are opencode" }, user])
    const calls = first.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
    expect(calls[0]).toMatchObject({ index: 0, type: "function", function: { name: "write", arguments: "" } })
    expect(JSON.parse(calls.map((call) => call.function.arguments).join(""))).toEqual({
      filePath: "notes.txt",
      content: "hi\n",
    })
    expect(first.at(-1).choices[0].finish_reason).toBe("tool_calls")

    const answered = [
      user,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: calls[0].id, type: "function", function: calls[0].function }],
      },
      { role: "tool", tool_call_id: calls[0].id, content: "Wrote file successfully." },
    ]
    const second = await chunks(answered)
    expect(second.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe("Wrote notes.txt.")
    expect(second.at(-1).choices[0].finish_reason).toBe("stop")
    // A step past the end of the script, and a new conversation that starts over.
    const third = await chunks([...answered, { role: "assistant", content: "Wrote notes.txt." }])
    expect(third.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe("Done.")
    expect((await chunks([user])).some((chunk) => chunk.choices[0].delta.tool_calls)).toBe(true)
    expect(scripted.requests.map((item) => item.tool ?? item.kind)).toEqual(["write", "chat", "chat", "write"])
  } finally {
    scripted.stop()
  }
})
