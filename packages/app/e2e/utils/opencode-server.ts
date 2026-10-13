// A real `opencode serve` from this checkout for e2e specs, with isolated data, config, state and cache dirs, and a
// scripted OpenAI-compatible model. Specs bind the app's default server port (PLAYWRIGHT_SERVER_PORT), so a busy port
// (another real-server spec) is waited for.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
export const serverPort = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? 4096)

export async function startServer(root: string, port = serverPort) {
  for (let attempt = 0; ; attempt++) {
    const started = await spawnServer(root, port).catch((error: unknown) => error as Error)
    if (!(started instanceof Error)) return started
    if (attempt >= 90 || !/EADDRINUSE|in use|ServeError/i.test(started.message)) throw started
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

async function spawnServer(root: string, port: number) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_SHARE: "true",
    OPENCODE_MODELS_PATH: path.join(repo, "packages/opencode/test/tool/fixtures/models-api.json"),
    OPENCODE_SERVER_PASSWORD: undefined,
  }
  const child = spawn("bun", ["run", "./src/index.ts", "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: path.join(repo, "packages/opencode"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  let output = ""
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`opencode server did not start:\n${output}`)), 90_000)
    const onData = (data: Buffer) => {
      output += data.toString()
      const match = output.match(/listening on (http:\/\/\S+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    void exited.then(() => {
      clearTimeout(timer)
      reject(new Error(`opencode server exited:\n${output}`))
    })
  })
  return {
    url,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
      await exited
      clearTimeout(timer)
    },
  }
}

// A git project whose opencode.json points at `modelURL` (test/test-model), with formatters, LSP and sharing off.
export async function createProject(directory: string, modelURL = "http://127.0.0.1:9/v1") {
  await fs.mkdir(directory, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "e2e@opencode.test")
  git("config", "user.name", "E2E")
  git("config", "commit.gpgsign", "false")
  await fs.writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      model: "test/test-model",
      small_model: "test/test-model",
      formatter: false,
      lsp: false,
      share: "disabled",
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: modelURL },
        },
      },
    }),
  )
  git("add", "opencode.json")
  git("commit", "-q", "-m", "init")
}

export type Reply = { tool: string; args: unknown } | { text: string }

// OpenAI-compatible chat completions stream: every main-agent request takes the next scripted reply; title requests
// (which carry no tools) always get `title`.
export async function fakeModel(script: Reply[], title = "E2E") {
  const replies = [...script]
  let calls = 0
  const server = createServer(async (request, response) => {
    const body = JSON.parse((await read(request)) || "{}") as { tools?: unknown[] }
    const reply: Reply = body.tools?.length ? (replies.shift() ?? { text: "Done." }) : { text: title }
    const chunk = (delta: object, finish?: string) => ({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
      ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    send(chunk({ role: "assistant" }))
    if ("tool" in reply) {
      const id = `call_${calls++}`
      send(chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: reply.tool, arguments: "" } }] }))
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }))
      send(chunk({}, "tool_calls"))
    } else {
      send(chunk({ content: reply.text }))
      send(chunk({}, "stop"))
    }
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    remaining: () => replies.length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function read(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}
