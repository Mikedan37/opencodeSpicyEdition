import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expectSessionTitle } from "../utils/waits"

// Spicy review against a real opencode server (isolated XDG dirs) whose model is a scripted OpenAI-compatible stub:
// a session edits two files, the "Agent changes" review renders their hunks inline, one hunk is accepted, one is
// rejected (after a stale-hunk 409 is explained), one is rejected from the file view, and the files on disk match.
// Run with PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there, so the app's default server is
// this one too.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const port = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? 4096)

const TEN = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
const A_EDITED = TEN.replace("two\n", "TWO\n").replace("nine\n", "NINE\n")
const B = "alpha\nbeta\ngamma\n"
const B_EDITED = "alpha\nBETA\ngamma\n"

test.use({ viewport: { width: 1600, height: 1000 } })

test("agent changes: hunks render inline, accept one, reject one, files on disk match", async ({ page }, info) => {
  test.setTimeout(240_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-review-e2e-")))
  const project = path.join(root, "project")
  const model = await fakeModel([
    { tool: "write", args: { filePath: "a.txt", content: A_EDITED } },
    { tool: "write", args: { filePath: "b.txt", content: B_EDITED } },
    { text: "Edited a.txt and b.txt." },
    // The Agent HQ agent's turn.
    { tool: "write", args: { filePath: "c.txt", content: "from ada\n" } },
    { text: "Wrote c.txt." },
  ])
  await createProject(project, model.url)
  const server = await startServer(root, port)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  const read = (name: string) => fs.readFile(path.join(project, name), "utf8")
  try {
    const api = (route: string, init?: RequestInit) =>
      fetch(`${server.url}${route}?directory=${encodeURIComponent(project)}`, init)
    const session = (await (await api("/session", json({}))).json()) as { id: string }
    const prompt = await api(
      `/session/${session.id}/message`,
      json({
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "Edit a.txt and b.txt" }],
      }),
    )
    expect(prompt.status).toBe(200)
    expect(await read("a.txt")).toBe(A_EDITED)
    expect(await read("b.txt")).toBe(B_EDITED)

    // An Agent HQ agent on the OpenCode provider: its edit asks first, and the test answers like the human would.
    const agent = (await (
      await api(
        "/agenthq/agents",
        json({ name: "Ada", avatar: { kind: "preset", value: "fox" }, provider: "opencode" }),
      )
    ).json()) as { id: string }
    const hq = (await (await api(`/agenthq/agents/${agent.id}/sessions`, json({}))).json()) as {
      id: string
      providerSessionID: string
    }
    expect((await api(`/agenthq/sessions/${hq.id}/messages`, json({ text: "Write c.txt" }))).status).toBe(200)
    let requestID = ""
    await expect
      .poll(async () => {
        const detail = (await (await api(`/agenthq/sessions/${hq.id}`)).json()) as {
          history: { event: { type: string; requestID?: string } }[]
        }
        requestID = detail.history.find((item) => item.event.type === "permission.requested")?.event.requestID ?? ""
        return requestID
      })
      .not.toBe("")
    expect((await api(`/agenthq/sessions/${hq.id}/permissions/${requestID}`, json({ optionID: "once" }))).status).toBe(
      200,
    )
    await expect.poll(() => read("c.txt").catch(() => "")).toBe("from ada\n")
    await expect.poll(async () => ((await (await api("/review/changesets")).json()) as unknown[]).length).toBe(2)
    await expect.poll(() => model.remaining()).toBe(0)

    // The review panel open with its file list, as the other review specs start.
    await page.addInitScript(() => {
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ review: { panelOpened: true } }))
      localStorage.setItem(
        "opencode.global.dat:review-panel-v2",
        JSON.stringify({ sidebarOpened: true, sidebarWidth: 320, expandMode: "collapse" }),
      )
    })
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expectSessionTitle(page, "Review e2e")
    await openAgentChanges(page)

    // One changeset per session, named after its agent: the Agent HQ agent's, and the plain OpenCode session's with
    // both files pending; a.txt's two hunks render inline.
    await expect(page.locator('[data-component="review-changeset"]')).toHaveCount(2)
    await expect(
      page.locator(
        `[data-component="review-changeset"][data-changeset="chg_${hq.providerSessionID}"] [data-component="review-agent"]`,
      ),
    ).toContainText("Ada")
    const changeset = page.locator(`[data-component="review-changeset"][data-changeset="chg_${session.id}"]`)
    await expect(changeset.locator('[data-component="review-agent"]')).toContainText("OpenCode")
    await expect(changeset.locator('[data-component="review-file-row"][data-path="a.txt"]')).toHaveAttribute(
      "data-state",
      "pending",
    )
    await expect(changeset.locator('[data-component="review-file-row"][data-path="b.txt"]')).toHaveAttribute(
      "data-state",
      "pending",
    )
    await changeset.locator('[data-component="review-file-row"][data-path="a.txt"]').click()
    const hunks = page.locator('[data-component="review-hunk"]')
    await expect(hunks).toHaveCount(2)
    await shot("1-review-panel")
    // At the desktop app's default 1280×800 window the hunk bars wrap between their items, never inside a label.
    await resize(page, 1280, 800)
    await expect.poll(() => wrappedLabels(hunks)).toEqual([])
    await shot("1b-review-panel-1280")
    await resize(page, 1600, 1000)

    // Accept the focused (first) hunk with the keyboard: the file stays as the agent wrote it, the hunk moves to the
    // reviewed list.
    await expect(hunks.nth(0)).toHaveAttribute("data-focused", "")
    // The emulated "Desktop Chrome" device reports Win32, so the app binds mod to Ctrl.
    await page.keyboard.press("Control+Shift+KeyY")
    await expect(hunks).toHaveCount(1)
    await expect(page.locator('[data-component="review-decided-hunk"][data-state="accepted"]')).toHaveCount(1)
    expect(await read("a.txt")).toBe(A_EDITED)

    // The human edits the second hunk's line after it was listed: rejecting the listed hunk is refused and explained,
    // and the panel shows the current change instead.
    await fs.writeFile(path.join(project, "a.txt"), A_EDITED.replace("NINE\n", "Nine\n"))
    await hunks.nth(0).locator('[data-action="reject"]').click()
    const notice = page.locator('[data-component="review-notice"]')
    await expect(notice).toHaveAttribute("data-reason", "editedSince")
    await expect(notice).toContainText("You edited these lines since")
    await shot("2-stale-hunk-explained")
    expect(await read("a.txt")).toBe(A_EDITED.replace("NINE\n", "Nine\n"))

    // Reject the current version of that hunk: exactly the accepted change remains on disk.
    await hunks.nth(0).locator('[data-action="reject"]').click()
    await expect(hunks).toHaveCount(0)
    await expect(page.locator('[data-component="review-decided-hunk"][data-state="rejected"]')).toHaveCount(1)
    await expect(changeset.locator('[data-component="review-file-row"][data-path="a.txt"]')).toHaveAttribute(
      "data-state",
      "accepted",
    )
    expect(await read("a.txt")).toBe(TEN.replace("two\n", "TWO\n"))
    await shot("3-a-reviewed")

    // b.txt in the file view: the review bar and the inline hunk, rejected there.
    await changeset.locator('[data-component="review-file-row"][data-path="b.txt"]').click()
    await page.locator('[data-action="open-file"]').click()
    const file = page.locator('[data-component="review-file"][data-path="b.txt"]')
    await expect(file.locator('[data-component="review-bar"]')).toContainText("Agent changes")
    await expect(file.locator('[data-component="review-hunk"]')).toHaveCount(1)
    await shot("4-file-view-inline")
    // The same at 1280×800 for the file view's review bar and its hunk bar.
    await resize(page, 1280, 800)
    await expect
      .poll(() => wrappedLabels(file.locator('[data-component="review-bar"], [data-component="review-hunk"]')))
      .toEqual([])
    await shot("4b-file-view-1280")
    await resize(page, 1600, 1000)
    await file.locator('[data-component="review-hunk"] [data-action="reject"]').click()
    await expect(file).toHaveCount(0)
    expect(await read("b.txt")).toBe(B)
    await page.locator("#session-side-panel-review-tab").click()
    await expect(changeset.locator('[data-component="review-file-row"][data-path="b.txt"]')).toHaveAttribute(
      "data-state",
      "rejected",
    )
    await shot("5-all-reviewed")
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The side panel animates its width after a window resize; this waits for the settled layout.
async function resize(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() =>
    document.getAnimations().every((item) => !(item instanceof CSSTransition) || item.transitionProperty !== "width"),
  )
}

// Labels of the buttons inside `scope` whose text spans more than one line.
function wrappedLabels(scope: Locator) {
  return scope.locator('[data-component="button-v2"]').evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const tops = new Set<number>()
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const range = document.createRange()
          range.selectNodeContents(walker.currentNode)
          for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top))
        }
        return tops.size > 1
      })
      .map((button) => button.textContent),
  )
}

async function openAgentChanges(page: Page) {
  const panel = page.locator("#review-panel")
  await panel.locator('[data-component="select-v2"]').click()
  await page.locator('[data-component="menu-v2-item"]', { hasText: "Agent changes" }).click()
  await expect(panel.locator('[data-component="select-v2"]')).toContainText("Agent changes")
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

async function createProject(directory: string, modelURL: string) {
  await fs.mkdir(directory, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "review-e2e@opencode.test")
  git("config", "user.name", "Review E2E")
  git("config", "commit.gpgsign", "false")
  await fs.writeFile(path.join(directory, "a.txt"), TEN)
  await fs.writeFile(path.join(directory, "b.txt"), B)
  git("add", "a.txt", "b.txt")
  git("commit", "-q", "-m", "init")
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
}

// A real `opencode serve` from this checkout, with its own data, config, state and cache dirs.
async function startServer(root: string, port: number) {
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

type Reply = { tool: string; args: unknown } | { text: string }

// OpenAI-compatible chat completions stream: every main-agent request takes the next scripted reply; title requests
// (which carry no tools) always get a title.
async function fakeModel(script: Reply[]) {
  const replies = [...script]
  let calls = 0
  const server = createServer(async (request, response) => {
    const body = JSON.parse((await text(request)) || "{}") as { tools?: unknown[] }
    const reply: Reply = body.tools?.length ? (replies.shift() ?? { text: "Done." }) : { text: "Review e2e" }
    const chunk = (delta: object, finish?: string) => ({
      id: "chatcmpl-review-e2e",
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

function text(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}
