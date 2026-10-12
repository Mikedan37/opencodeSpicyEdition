#!/usr/bin/env bun
// spicy: a deterministic OpenAI-compatible chat endpoint for demos and smoke runs. It streams scripted replies
// word by word from localhost, so an OpenCode session runs through the real server and UI without a network
// call, an API key or tokens. (Product scripts must not import test code; the idea comes from
// packages/opencode/test/lib/llm-server.ts.)
//
//   bun scripts/spicy-model.ts [--port 4599]   serve until Ctrl-C and print the matching opencode.json
//
// Replies: a prompt containing "slow" gets a long reply at 120 ms per word (time to cancel or quit mid-turn);
// title requests get a short title; anything else gets the introduction below at 70 ms per word.

export const INTRO =
  "Hi, I'm Felix, an OpenCode agent answering from the Spicy scripted demo model. " +
  "Every word of this reply streams from a local OpenAI-compatible endpoint, so the Agents workspace shows " +
  "the same deltas, completion and history a real model would produce, without spending a single token. " +
  "Ask me for something slow to watch a turn get cancelled."

const SLOW = Array.from(
  { length: 40 },
  (_, index) =>
    `Paragraph ${index + 1}: this deliberately slow answer keeps streaming so the turn can be cancelled or the app quit while it runs.`,
).join(" ")

export type ScriptedRequest = {
  id: number
  kind: "title" | "chat"
  prompt: string
  startedAt: number
  finishedAt?: number
  aborted: boolean
}

export function serveScriptedModel(options: { port?: number; wordDelayMs?: number; slowWordDelayMs?: number } = {}) {
  const requests: ScriptedRequest[] = []
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "scripted", object: "model", owned_by: "spicy" }] })
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })

      const body = (await req.json()) as { messages?: Message[]; stream?: boolean }
      const messages = body.messages ?? []
      const title = messages.some((item) => item.role === "system" && text(item).includes("title generator"))
      const prompt = text(messages.findLast((item) => item.role === "user"))
      const record: ScriptedRequest = {
        id: requests.length + 1,
        kind: title ? "title" : "chat",
        prompt,
        startedAt: Date.now(),
        aborted: false,
      }
      requests.push(record)
      const slow = !title && /\bslow\b/i.test(prompt)
      const reply = title ? "Felix demo" : slow ? SLOW : INTRO
      const delay = title ? 0 : slow ? (options.slowWordDelayMs ?? 120) : (options.wordDelayMs ?? 70)

      if (!body.stream) {
        record.finishedAt = Date.now()
        return Response.json({
          id: `chatcmpl-${record.id}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "scripted",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: usage(prompt, reply),
        })
      }

      const encoder = new TextEncoder()
      const chunk = (delta: Record<string, unknown>, finish?: string, extra?: Record<string, unknown>) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: `chatcmpl-${record.id}`,
            object: "chat.completion.chunk",
            created: Math.floor(record.startedAt / 1000),
            model: "scripted",
            choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
            ...extra,
          })}\n\n`,
        )
      const words = reply.split(/(?<= )/)
      let cancelled = false
      req.signal.addEventListener("abort", () => {
        cancelled = true
        record.aborted = true
      })
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(chunk({ role: "assistant", content: "" }))
            for (const word of words) {
              if (cancelled) return
              if (delay) await Bun.sleep(delay)
              if (cancelled) return
              controller.enqueue(chunk({ content: word }))
            }
            controller.enqueue(chunk({}, "stop", { usage: usage(prompt, reply) }))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            record.finishedAt = Date.now()
            controller.close()
          },
          cancel() {
            cancelled = true
            record.aborted = true
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  }
}

// opencode.json for the isolated config dir: the scripted model is the only enabled provider and the default
// model, so nothing reaches a real provider.
export function demoConfig(baseURL: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: "spicy-demo/scripted",
    small_model: "spicy-demo/scripted",
    enabled_providers: ["spicy-demo"],
    autoupdate: false,
    share: "disabled",
    provider: {
      "spicy-demo": {
        name: "Spicy demo (scripted)",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "spicy-demo", baseURL },
        models: {
          scripted: {
            id: "scripted",
            name: "Scripted demo model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2026-10-12",
            limit: { context: 128000, output: 8000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
      },
    },
  }
}

type Message = { role?: string; content?: string | { type?: string; text?: string }[] | null }

function text(message: Message | undefined) {
  if (!message?.content) return ""
  if (typeof message.content === "string") return message.content
  return message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("")
}

function usage(prompt: string, reply: string) {
  const input = Math.ceil(prompt.length / 4)
  const output = Math.ceil(reply.length / 4)
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--port")
  const model = serveScriptedModel({ port: flag > 0 ? Number(process.argv[flag + 1]) : 4599 })
  console.log(`scripted model on ${model.url}`)
  console.log(JSON.stringify(demoConfig(model.url), null, 2))
}
