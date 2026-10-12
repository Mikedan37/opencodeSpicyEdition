#!/usr/bin/env bun
// spicy: end-to-end smoke of the real desktop app, driven over the Chrome DevTools Protocol. No macOS screen
// recording is involved: screenshots come from Page.captureScreenshot. The model is scripts/spicy-model.ts, so
// nothing reaches a real provider.
//
//   bun scripts/spicy-smoke.ts [--mode built|dev] [--out DIR] [--root DIR]
//
// Milestone covered: isolated launch, sidecar reachable, Dock icon loaded, open a project, bottom panel Agents tab,
// create "Felix" on the OpenCode provider, start a session, send a message, the reply streams into the workspace
// (screenshots mid-stream and after, plus the agenthq.session.event stream from the server), cancel a running turn,
// close and reopen the panel with the conversation kept, quit mid-turn and restart with the history recovered and
// the session interrupted, and no process of the app left behind after each quit.
//
// Opening a project: the app adds projects through the native folder picker, which CDP cannot drive. The smoke
// creates the project's first session through the server API (what the app does on the first prompt) and opens it
// through the app's own restore of the window's last URL. Everything after that goes through the UI.
import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import { mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { alive, cleanup, DESKTOP_DIR, launch, processTree, type Launched, type Mode } from "./spicy-launch"
import { connectRenderer, CTRL, type Renderer } from "./spicy-cdp"
import { demoConfig, INTRO, serveScriptedModel } from "./spicy-model"

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}
const mode = (arg("--mode") as Mode | undefined) ?? "built"
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")
const out = path.resolve(arg("--out") ?? path.join(import.meta.dir, "../../../docs/spicy/desktop-smoke", stamp))
await mkdir(out, { recursive: true })

type Check = { name: string; ok: boolean; ms: number; detail?: string }
// Assistant message texts in the Agents workspace, with typographic quotes and whitespace normalized (replies render
// as Markdown).
const ASSISTANT = `[...document.querySelectorAll('[data-row="message"][data-role="assistant"]')].map((row) => row.textContent.replace(/[\u2018\u2019]/g, "'").replace(/\\s+/g, " ").trim())`
const checks: Check[] = []
const shots: string[] = []
const model = serveScriptedModel()
const config = demoConfig(model.url)
let app: Launched | undefined
let renderer: Renderer | undefined

async function step<T>(name: string, run: () => Promise<T>, detail?: (value: T) => string) {
  const started = Date.now()
  try {
    const value = await run()
    checks.push({ name, ok: true, ms: Date.now() - started, detail: detail?.(value) })
    console.log(`ok    ${name}${detail ? `: ${detail(value)}` : ""}`)
    return value
  } catch (error) {
    checks.push({ name, ok: false, ms: Date.now() - started, detail: String(error) })
    console.log(`FAIL  ${name}: ${error}`)
    if (renderer) await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {})
    throw error
  }
}

async function shot(name: string) {
  const file = await renderer!.screenshot(path.join(out, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`))
  shots.push(file)
  return file
}

const lines: string[] = []
// Read-only snapshot of the owner's real keychain setup, compared after the run.
const keychainBefore = realKeychain()
const project = await createProject()
const slug = btoa(String.fromCharCode(...new TextEncoder().encode(project)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=/g, "")

try {
  // ---------------------------------------------------------------- launch
  app = await step(
    "launch isolated",
    () => launch({ mode, root: arg("--root"), config, log: (line) => lines.push(line) }),
    (value) => `root ${value.root}, DevTools port ${value.port}`,
  )
  const root = app.root
  renderer = await step("renderer over CDP", () => connectRenderer(app!.port))
  const server = await step(
    "sidecar ready",
    () => sidecar(renderer!),
    (value) => value.url,
  )
  await step("sidecar reachable from the renderer", () =>
    renderer!
      .evaluate<number>(
        `window.api.awaitInitialization().then((s) => fetch(s.url + "/global/health", { headers: { authorization: "Basic " + btoa(s.username + ":" + s.password) } })).then((r) => r.status)`,
      )
      .then(expectEqual(200)),
  )
  await step(
    "server state is isolated",
    async () => {
      const paths = await api<{ home: string; state: string; config: string }>(server, "GET", "/path")
      for (const value of [paths.home, paths.state, paths.config])
        if (!value.startsWith(root)) throw new Error(`${value} is outside ${root}`)
      return paths
    },
    (paths) => `home ${paths.home}`,
  )
  await step("home shell rendered", () =>
    renderer!.waitFor(`document.querySelector('[data-component="home-session-search"]')`, "home"),
  )
  await shot("home")
  await step(
    "dock icon loaded (log)",
    () => dockIconLog(app!.userData),
    (value) => value,
  )

  // ---------------------------------------------------------------- project and Agents tab
  await step(
    "open project",
    async () => {
      const session = await api<{ id: string }>(server, "POST", `/session?directory=${encodeURIComponent(project)}`, {
        title: "Felix demo",
      })
      await openUrl(renderer!, `/server/${btoa("sidecar").replace(/=/g, "")}/session/${session.id}`)
      await renderer!.waitFor(
        `document.querySelector('[data-component="session-prompt-dock"]')`,
        "session page",
        40_000,
      )
      return session.id
    },
    (id) => `${project} (session ${id})`,
  )
  await openAgentsTab(renderer)
  await shot("agents-empty")

  // ---------------------------------------------------------------- Felix
  await step(
    "create Felix on the OpenCode provider",
    async () => {
      await renderer!.click('[data-action="agenthq-new"]')
      await renderer!.type('[data-component="agenthq-dialog"] input[name="name"]', "Felix")
      await renderer!.click('[data-component="agenthq-dialog"] label[data-provider="opencode"] input[type="radio"]')
      await shot("create-dialog")
      await renderer!.click('[data-component="agenthq-dialog"] button[type="submit"]')
      await renderer!.waitFor(
        `document.querySelector('[data-component="agenthq-card"], [data-component="agenthq-workspace"]')`,
        "Felix in the roster",
      )
      const agents = await api<{ id: string; name: string; provider: string; projectDirectory: string }[]>(
        server,
        "GET",
        `/agenthq/agents?directory=${encodeURIComponent(project)}`,
      )
      const felix = agents.find((agent) => agent.name === "Felix")
      if (!felix || felix.provider !== "opencode" || felix.projectDirectory !== project)
        throw new Error(`unexpected agents ${JSON.stringify(agents)}`)
      return felix
    },
    (felix) => felix.id,
  )
  const sessionID = await step(
    "start a session",
    async () => {
      if (!(await renderer!.evaluate(`!!document.querySelector('[data-component="agenthq-workspace"]')`)))
        await renderer!.click('[data-component="agenthq-card"]')
      await renderer!.click('[data-action="agenthq-start-session"]')
      await renderer!.waitFor(`document.querySelector('[data-component="agenthq-composer"] textarea')`, "composer")
      return renderer!.waitFor<string>(
        `document.querySelector('[data-session]')?.getAttribute("data-session")`,
        "session id",
      )
    },
    (id) => id,
  )

  // ---------------------------------------------------------------- streamed reply
  const events = listen(server, project, sessionID)
  await step("send a message", () => send(renderer!, "Hi Felix, introduce yourself."))
  await step("reply streams into the workspace", () =>
    renderer!.waitFor(
      `(() => { const text = ${ASSISTANT}.at(-1) ?? ""; return text.length > 15 && text.length < ${INTRO.length} && ${statusIs("working")} })()`,
      "partial assistant text while working",
    ),
  )
  await shot("streaming")
  await step("turn completes with the scripted reply", async () => {
    await renderer!.waitFor(statusIs("idle"), "idle after the turn", 30_000)
    // The finished message is re-rendered as Markdown off the main thread, so wait for its text to settle.
    await renderer!
      .waitFor(`${ASSISTANT}.at(-1)?.includes(${JSON.stringify(INTRO)})`, "the full scripted reply")
      .catch(async () => {
        throw new Error(`assistant text was: ${await renderer!.evaluate<string>(`${ASSISTANT}.at(-1) ?? ""`)}`)
      })
  })
  await shot("reply")
  await step(
    "server streamed agenthq.session.event envelopes",
    async () => {
      await Bun.sleep(300)
      const types = events.envelopes.map((item) => item.event.type)
      const seqs = events.envelopes.map((item) => item.seq)
      if (!types.includes("message.delta") || !types.includes("turn.completed"))
        throw new Error(`event types: ${types.join(", ")}`)
      if (seqs.some((seq, index) => index > 0 && seq !== seqs[index - 1] + 1))
        throw new Error(`seq gap: ${seqs.join(",")}`)
      const deltas = types.filter((type) => type === "message.delta").length
      events.stop()
      return `${events.envelopes.length} envelopes, ${deltas} deltas, seq ${seqs[0]}..${seqs.at(-1)}`
    },
    (value) => value,
  )

  // ---------------------------------------------------------------- cancel
  await step("cancel a running turn", async () => {
    await send(renderer!, "Please give me a slow, very long answer.")
    await renderer!.waitFor(
      `document.querySelector('[data-action="agenthq-cancel"]') && ${ASSISTANT}.at(-1)?.includes("Paragraph 1")`,
      "slow reply streaming",
    )
    await renderer!.click('[data-action="agenthq-cancel"]')
    await renderer!.waitFor(statusIs("cancelled"), "cancelled")
    const request = model.requests.findLast((item) => item.kind === "chat" && item.prompt.includes("slow"))
    await waitUntil(() => request?.aborted === true, "the model request to be aborted")
  })
  await shot("cancelled")

  // ---------------------------------------------------------------- panel close and reopen
  await step("close and reopen the panel keeps the conversation", async () => {
    await renderer!.press("`", { code: "Backquote", keyCode: 192, modifiers: CTRL })
    await renderer!.waitFor(`!document.querySelector('#terminal-panel')`, "panel closed")
    await openAgentsTab(renderer!)
    if (!(await renderer!.evaluate(`!!document.querySelector('[data-component="agenthq-workspace"]')`)))
      await renderer!.click('[data-component="agenthq-card"]')
    await renderer!.waitFor(
      `${ASSISTANT}.some((text) => text.includes(${JSON.stringify(INTRO.slice(0, 40))}))`,
      "conversation after reopening",
    )
  })
  await shot("reopened")

  // ---------------------------------------------------------------- quit mid-turn, restart, recover
  await step("send a turn and quit while it streams", async () => {
    await send(renderer!, "One more slow story, please.")
    await renderer!.waitFor(statusIs("working"), "working")
    await renderer!.waitFor(`${ASSISTANT}.at(-1)?.includes("Paragraph 1")`, "streaming before quit")
  })
  await step(
    "no processes left after quitting",
    () => quitAndCheck(),
    (value) => value,
  )
  renderer.close()
  renderer = undefined

  app = await step("restart on the same state", () => launch({ mode, root, config, log: (line) => lines.push(line) }))
  renderer = await step("renderer over CDP after restart", () => connectRenderer(app!.port))
  const restarted = await step(
    "sidecar ready after restart",
    () => sidecar(renderer!),
    (value) => value.url,
  )
  await step("app restores the project session", () =>
    renderer!.waitFor(
      `document.querySelector('[data-component="session-prompt-dock"]')`,
      "restored session page",
      40_000,
    ),
  )
  await step(
    "session history recovered as interrupted",
    async () => {
      if (!(await renderer!.evaluate(`!!document.querySelector('[data-component="agenthq-panel"]')`)))
        await openAgentsTab(renderer!)
      if (!(await renderer!.evaluate(`!!document.querySelector('[data-component="agenthq-workspace"]')`)))
        await renderer!.click('[data-component="agenthq-card"]')
      await renderer!.waitFor(
        `document.querySelector('[data-session=${JSON.stringify(sessionID)}] [data-status="interrupted"]')`,
        "interrupted status in the session list",
      )
      await renderer!.waitFor(
        `${ASSISTANT}.some((text) => text.includes(${JSON.stringify(INTRO.slice(0, 40))}))`,
        "first reply in the recovered history",
      )
      const detail = await api<{
        session: { status: string }
        history: { event: { type: string; status?: string } }[]
      }>(restarted, "GET", `/agenthq/sessions/${sessionID}?directory=${encodeURIComponent(project)}`)
      const statuses = detail.history.flatMap((item) => (item.event.type === "status" ? [item.event.status] : []))
      if (detail.session.status !== "interrupted") throw new Error(`status ${detail.session.status}`)
      if (!statuses.includes("cancelled") || !statuses.includes("interrupted"))
        throw new Error(`history statuses ${statuses.join(",")}`)
      return `${detail.history.length} history entries, statuses ${[...new Set(statuses)].join(" > ")}`
    },
    (value) => value,
  )
  await shot("restored")
  await step(
    "no processes left after the final quit",
    () => quitAndCheck(),
    (value) => value,
  )
} catch {
  // the failing step is recorded; fall through to cleanup and the summary
} finally {
  renderer?.close()
  if (app && app.child.exitCode === null) await app.stop().catch(() => {})
  model.stop()
}

if (app) {
  const home = app.home
  const keychain = app.keychain
  await step("throwaway keychain: no Safe Storage item (mock keychain)", async () => {
    const found = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "OpenCode Dev Safe Storage", keychain],
      {
        env: { HOME: home, CFFIXED_USER_HOME: home, PATH: "/usr/bin:/bin" },
      },
    )
    if (found.status === 0) throw new Error("Chromium wrote its Safe Storage key despite --use-mock-keychain")
  }).catch(() => {})
  await step("throwaway keychain deleted", async () => {
    cleanup(home)
    if (existsSync(keychain)) throw new Error(`${keychain} still exists`)
  }).catch(() => {})
}
const keychainAfter = realKeychain()
await step("real keychain untouched", async () => {
  if (JSON.stringify(keychainBefore) !== JSON.stringify(keychainAfter))
    throw new Error(`before ${JSON.stringify(keychainBefore)} after ${JSON.stringify(keychainAfter)}`)
}).catch(() => {})

const failed = checks.filter((item) => !item.ok)
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      mode,
      root: app?.root,
      project,
      keychain: { before: keychainBefore, after: keychainAfter },
      screenshots: shots,
      modelRequests: model.requests.map((item) => ({ kind: item.kind, prompt: item.prompt, aborted: item.aborted })),
      checks,
      appLogTail: failed.length ? lines.slice(-40) : undefined,
    },
    null,
    2,
  ),
)
process.exit(failed.length ? 1 : 0)

// ---------------------------------------------------------------- helpers

// The owner's keychain setup as the real HOME sees it: attributes only, never secrets.
function realKeychain() {
  const run = (...args: string[]) => spawnSync("/usr/bin/security", args, { encoding: "utf8" })
  const item = run("find-generic-password", "-s", "OpenCode Dev Safe Storage")
  return {
    prefsFile: existsSync(path.join(userInfo().homedir, "Library", "Preferences", "com.apple.security.plist")),
    searchList: run("list-keychains", "-d", "user").stdout.replace(/\s+/g, " ").trim(),
    defaultKeychain: run("default-keychain", "-d", "user").stdout.trim(),
    safeStorageItem:
      item.status === 0
        ? item.stdout
            .split("\n")
            .filter((line) => /"(cdat|mdat)"/.test(line))
            .map((line) => line.trim().replace(/^"(\w+)".*"(\d+Z)\\000"$/, "$1=$2"))
            .join(" ")
        : "absent",
  }
}

async function createProject() {
  const dir = path.join(
    arg("--root") ??
      (await $`mktemp -d ${path.join(process.env.TMPDIR ?? "/tmp", "spicy-project-XXXXXX")}`.text()).trim(),
    "felix-demo",
  )
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "README.md"), "# Felix demo\n\nA scratch project for the Spicy desktop smoke run.\n")
  await $`git init -q && git add README.md && git -c user.email=smoke@spicy.local -c user.name=spicy-smoke commit -qm init`.cwd(
    dir,
  )
  return realpathSync(dir)
}

async function sidecar(renderer: Renderer) {
  const init = await renderer.waitFor<{ url: string; username: string; password: string }>(
    "window.api && window.api.awaitInitialization()",
    "sidecar credentials",
    60_000,
  )
  return { url: init.url, auth: "Basic " + btoa(`${init.username}:${init.password}`) }
}

async function api<T>(server: { url: string; auth: string }, method: string, route: string, body?: unknown) {
  const res = await fetch(server.url + route, {
    method,
    headers: { authorization: server.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

// The server's directory-scoped event stream, filtered to one Agent HQ session.
function listen(server: { url: string; auth: string }, directory: string, sessionID: string) {
  const envelopes: { seq: number; event: { type: string } }[] = []
  const abort = new AbortController()
  void fetch(`${server.url}/event?directory=${encodeURIComponent(directory)}`, {
    headers: { authorization: server.auth, accept: "text/event-stream" },
    signal: abort.signal,
  })
    .then(async (res) => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value
        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""
        for (const part of parts) {
          const data = part
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("")
          if (!data) continue
          const event = JSON.parse(data) as {
            type: string
            properties?: { envelope?: { sessionID: string; seq: number; event: { type: string } } }
          }
          const envelope = event.properties?.envelope
          if (event.type === "agenthq.session.event" && envelope?.sessionID === sessionID) envelopes.push(envelope)
        }
      }
    })
    .catch(() => {})
  return { envelopes, stop: () => abort.abort() }
}

// Open a route the way the app restores a window: store it as the window's last URL and reload.
async function openUrl(renderer: Renderer, url: string) {
  await renderer.evaluate(
    `window.api.getWindowID().then((id) => { localStorage.setItem("opencode.desktop.window." + id + ".last-active-url", ${JSON.stringify(url)}); location.reload(); return id })`,
  )
}

async function openAgentsTab(renderer: Renderer) {
  await step("open the bottom panel (ctrl+`)", async () => {
    // A restarted app restores the panel (and its tab) by itself.
    if (await renderer.evaluate(`!!document.querySelector('#terminal-panel')`)) return
    await renderer.press("`", { code: "Backquote", keyCode: 192, modifiers: CTRL })
    await renderer.waitFor(`document.querySelector('#terminal-panel [data-workbench-tab="agents"]')`, "workbench tabs")
    // Opening the panel starts a terminal whose focus request hands the tab bar back to the terminals; let it settle.
    await renderer.waitFor(`document.querySelector('#terminal-panel [data-component="terminal"]')`, "terminal")
    await Bun.sleep(1_500)
  })
  await step("Agents tab", async () => {
    await renderer.click('[data-workbench-tab="agents"]')
    await renderer.waitFor(
      `document.querySelector('[data-component="workbench-panel"][data-tab="agents"] [data-component="agenthq-panel"]')`,
      "Agents panel",
    )
    await renderer.waitFor(
      `document.querySelector('[data-action="agenthq-new"], [data-component="agenthq-workspace"]')`,
      "roster or workspace",
    )
  })
}

async function send(renderer: Renderer, text: string) {
  await renderer.type('[data-component="agenthq-composer"] textarea', text)
  await renderer.click('[data-action="agenthq-send"]')
}

function statusIs(status: string) {
  return `document.querySelector('[data-component="agenthq-workspace"] [data-status]')?.getAttribute("data-status") === ${JSON.stringify(status)}`
}

async function dockIconLog(userData: string) {
  const logs = path.join(userData, "logs")
  const runs = (await readdir(logs)).sort()
  const text = await readFile(path.join(logs, runs.at(-1)!, "window.log"), "utf8")
  const match = text.match(/dock icon \{[^}]*?path: '([^']+)'[^}]*?loaded: (true|false)/)
  if (!match) throw new Error("no dock icon entry in window.log")
  if (match[2] !== "true") throw new Error(`dock icon not loaded from ${match[1]}`)
  return `loaded ${match[1]}`
}

// Quit through the app's own SIGTERM handler, then prove that every process of the app is gone: the recorded tree
// (renderer, GPU, network, the "opencode server" sidecar and the terminal shells it spawned) and anything still
// running from this checkout's Electron binary.
async function quitAndCheck() {
  // This checkout's Electron, never another install's processes. pgrep takes a regex and the path holds "+"
  // (electron@42.3.3+...), so it is escaped.
  const binary = realpathSync(path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "Electron.app"))
  const pattern = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const running = async () => (await $`pgrep -fl ${pattern}`.nothrow().text()).trim().split("\n").filter(Boolean)
  const before = await running()
  if (before.length === 0)
    throw new Error(`pgrep finds nothing for ${binary} while the app runs; the check would prove nothing`)
  const tree = await processTree(app!.child.pid!)
  const sidecarPid = tree.find((item) => item.command.includes("node.mojom.NodeService"))?.pid
  const shells = tree.filter((item) => sidecarPid && item.ppid === sidecarPid)
  const code = await app!.stop()
  if (code === "killed") throw new Error("the app did not quit within 20 s and was killed")
  await waitUntil(() => tree.every((item) => !alive(item.pid)), "the app's processes to exit", 10_000)
  const after = await running()
  if (after.length) throw new Error(`still running: ${after.join("; ")}`)
  return `${tree.length + 1} processes gone (sidecar pid ${sidecarPid ?? "?"}, ${shells.length} terminal shell(s)); pgrep matched ${before.length} before, 0 after`
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(100)
  }
}

function expectEqual<T>(expected: T) {
  return (value: T) => {
    if (value !== expected) throw new Error(`expected ${expected}, got ${value}`)
    return value
  }
}
