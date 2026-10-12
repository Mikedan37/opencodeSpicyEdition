import { afterAll, expect, test } from "bun:test"
import { INTRO, serveScriptedModel } from "./spicy-model"

// spicy: the scripted demo model streams OpenAI-compatible chunks, answers title requests and records aborts.
const model = serveScriptedModel({ wordDelayMs: 1, slowWordDelayMs: 20 })
afterAll(() => model.stop())

const post = (body: unknown, signal?: AbortSignal) =>
  fetch(`${model.url}/chat/completions`, { method: "POST", body: JSON.stringify(body), signal })

test("streams the scripted reply word by word and ends with [DONE]", async () => {
  const text = await post({ stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
    (res) => res.text(),
  )
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
