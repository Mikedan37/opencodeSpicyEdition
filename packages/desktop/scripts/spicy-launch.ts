#!/usr/bin/env bun
// spicy: launch the desktop app with all of its state isolated under one root, plus a Chrome DevTools Protocol port
// so scripts/spicy-smoke.ts (or Chrome at chrome://inspect) can drive the renderer.
//
//   bun scripts/spicy-launch.ts [--mode built|dev] [--root DIR] [--port N] [--demo-model]
//
// Modes: "built" runs out/ (`node_modules/.bin/electron-vite build` first) with the Electron binary from
// node_modules; "dev" runs `electron-vite dev` (renderer from the Vite dev server). The packaged .app is checked by
// scripts/spicy-package-check.ts but not launched: launching a bundle registers it (and its opencode:// scheme) with
// LaunchServices.
//
// Isolation (checked by scripts/spicy-smoke.ts):
// - HOME and CFFIXED_USER_HOME point at <root>/home. Electron derives appData, the app's userData
//   (join(appData, appId)), logs, crash dumps and the Chromium profile from the CoreFoundation home; Node's homedir()
//   (Tauri migration, shell probe, git, npm) follows HOME. --user-data-dir alone is not enough: the app sets userData
//   itself.
// - Keychain: the Security framework resolves the user's keychains and their search-list preferences from HOME, so a
//   fake HOME has no default keychain and the first Safe Storage write would make macOS show "Keychain Not Found".
//   A throwaway keychain at <root>/home/Library/Keychains/login.keychain-db is made default, login and search list
//   for the fake HOME only (every `security` call runs with HOME=<root>/home; the real login keychain and its
//   preferences are never written), unlocked, without auto-lock, and deleted by cleanup(). --use-mock-keychain keeps
//   Chromium out of it; the keychain is the backstop.
// - XDG_{DATA,CONFIG,CACHE,STATE}_HOME and OPENCODE_TEST_HOME isolate the opencode server (the sidecar inherits the
//   main process environment); ZDOTDIR keeps the login-shell environment probe away from real dotfiles;
//   npm_config_offline/npm_config_cache keep the server's background @opencode-ai/plugin install off the network.
// - Seeded on a fresh root: onboarding done (it can create ~/Documents/Default Project), new layout, and
//   notifications and sounds off, so nothing pops up or plays while the app runs unattended. --mute-audio as well.
// - The app skips registering itself as the opencode:// handler when CFFIXED_USER_HOME is set (src/main/index.ts).
// Not isolated: AppKit still writes its own defaults for the bundle id (~/Library/Preferences/com.github.Electron).
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"

export type Mode = "built" | "dev"

export const DESKTOP_DIR = path.resolve(import.meta.dir, "..")
// Unpackaged runs use the dev app id (src/main/index.ts), so userData is <appData>/ai.opencode.desktop.dev.
const APP_ID = "ai.opencode.desktop.dev"
const KEEP_ENV = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"]
const SWITCHES = [
  "--use-mock-keychain",
  "--mute-audio",
  // A window behind other windows must keep rendering and running timers while it is driven over CDP.
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
]

export interface LaunchOptions {
  mode?: Mode
  root?: string // reuse a root to restart the app on the same state
  port?: number // CDP port, a free one when omitted
  config?: Record<string, unknown> // written to <root>/xdg/config/opencode/opencode.json
  env?: Record<string, string>
  log?: (line: string) => void // app stdout/stderr; inherited when omitted
}

export async function launch(options: LaunchOptions = {}) {
  const mode = options.mode ?? "built"
  const root = await realpath(await prepare(options.root ?? (await mkdtemp(path.join(tmpdir(), "spicy-desktop-")))))
  const home = path.join(root, "home")
  const userData = path.join(home, "Library", "Application Support", APP_ID)
  const keychain = provisionKeychain(home)
  if (options.config)
    await writeFile(
      path.join(root, "xdg", "config", "opencode", "opencode.json"),
      JSON.stringify(options.config, null, 2),
    )
  await seed(path.join(userData, "opencode.settings"), {
    firstLaunchOnboardingComplete: true,
    oldLayoutEligible: false,
  })
  await seed(path.join(userData, "default.dat"), {
    "settings.v3": JSON.stringify({
      notifications: { agent: false, permissions: false, errors: false },
      sounds: { agentEnabled: false, permissionsEnabled: false, errorsEnabled: false },
    }),
  })

  const port = options.port || (await freePort())
  const env: Record<string, string> = {
    ...Object.fromEntries(KEEP_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))),
    HOME: home,
    CFFIXED_USER_HOME: home,
    ZDOTDIR: home,
    TMPDIR: path.join(root, "tmp"),
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    npm_config_offline: "true",
    npm_config_cache: path.join(root, "npm-cache"),
    ...options.env,
  }
  const switches = [`--remote-debugging-port=${port}`, ...SWITCHES]
  // electron-vite always replaces ELECTRON_CLI_ARGS with whatever follows "--", so the switches go there.
  const command =
    mode === "dev"
      ? [path.join(DESKTOP_DIR, "node_modules", ".bin", "electron-vite"), "dev", "--", ...switches]
      : [electronBinary(), DESKTOP_DIR, ...switches]
  const child = spawn(command[0], command.slice(1), {
    cwd: DESKTOP_DIR,
    env,
    stdio: options.log ? ["ignore", "pipe", "pipe"] : "inherit",
    // Own process group: tooling under electron-vite signals its group on exit, which must not reach the caller.
    detached: mode === "dev",
  })
  if (options.log) {
    const log = options.log
    child.stdout?.on("data", (chunk: Buffer) => chunk.toString().split("\n").filter(Boolean).forEach(log))
    child.stderr?.on("data", (chunk: Buffer) => chunk.toString().split("\n").filter(Boolean).forEach(log))
  }
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))

  return {
    mode,
    root,
    home,
    userData,
    keychain,
    port,
    env,
    child,
    exited,
    // Quit like the OS does: SIGTERM to the Electron main process only (its handler stops the sidecar, then quits
    // and Chromium ends its helpers). Anything still alive after the timeout is killed and reported.
    stop: async (timeoutMs = 20_000) => {
      const tree = await processTree(child.pid!)
      const main =
        mode === "dev"
          ? tree.find((item) => item.ppid === child.pid && item.command.includes("/Contents/MacOS/"))?.pid
          : child.pid
      if (main) safeKill(main, "SIGTERM")
      const code = await Promise.race([exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)])
      if (code !== "timeout") return code
      for (const item of [{ pid: child.pid! }, ...tree]) safeKill(item.pid, "SIGKILL")
      return "killed" as const
    },
  }
}

export type Launched = Awaited<ReturnType<typeof launch>>

// Removes the throwaway keychain (call after the app has quit for the last time).
export function cleanup(home: string) {
  const keychain = path.join(home, "Library", "Keychains", "login.keychain-db")
  if (existsSync(keychain)) security(home, "delete-keychain", keychain)
}

function provisionKeychain(home: string) {
  const keychain = path.join(home, "Library", "Keychains", "login.keychain-db")
  if (!existsSync(keychain)) security(home, "create-keychain", "-p", "", keychain)
  security(home, "default-keychain", "-d", "user", "-s", keychain)
  security(home, "list-keychains", "-d", "user", "-s", keychain)
  security(home, "unlock-keychain", "-p", "", keychain)
  security(home, "set-keychain-settings", keychain) // no timeout, no lock on sleep
  // Refuse to launch unless the fake HOME resolves to the throwaway keychain.
  const resolved = security(home, "default-keychain", "-d", "user").replace(/"/g, "").trim()
  if (resolved !== keychain)
    throw new Error(`fake HOME resolves the default keychain to "${resolved}", not ${keychain}`)
  return keychain
}

// Runs `security` against the fake HOME only. The real home is refused outright.
function security(home: string, ...args: string[]) {
  if (path.resolve(home) === path.resolve(userInfo().homedir))
    throw new Error("refusing to run security on the real home")
  const result = spawnSync("/usr/bin/security", args, {
    env: { HOME: home, CFFIXED_USER_HOME: home, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`security ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

// Every descendant of `pid`, from one `ps` snapshot.
export async function processTree(pid: number) {
  const out = await new Response(Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,command="]).stdout).text()
  const rows = out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
  const result: typeof rows = []
  const queue = [pid]
  while (queue.length) {
    const parent = queue.shift()!
    for (const row of rows.filter((item) => item.ppid === parent)) {
      result.push(row)
      queue.push(row.pid)
    }
  }
  return result
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function electronBinary() {
  if (!existsSync(path.join(DESKTOP_DIR, "out", "main", "index.js")))
    throw new Error("no build in out/; run node_modules/.bin/electron-vite build")
  return path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
}

async function prepare(root: string) {
  for (const dir of [
    "home/Library/Application Support/" + APP_ID,
    "home/Library/Keychains",
    "tmp",
    "npm-cache",
    "xdg/data",
    "xdg/config/opencode",
    "xdg/cache",
    "xdg/state",
  ])
    await mkdir(path.join(root, dir), { recursive: true })
  return root
}

// Only on a fresh root, so restarts keep whatever the app stored.
async function seed(file: string, value: Record<string, unknown>) {
  if (!existsSync(file)) await writeFile(file, JSON.stringify(value))
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function safeKill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch {}
}

if (import.meta.main) {
  const arg = (name: string) => {
    const index = process.argv.indexOf(name)
    return index > 0 ? process.argv[index + 1] : undefined
  }
  const { serveScriptedModel, demoConfig } = await import("./spicy-model")
  const model = process.argv.includes("--demo-model") ? serveScriptedModel() : undefined
  const app = await launch({
    mode: (arg("--mode") as Mode | undefined) ?? "built",
    root: arg("--root"),
    port: arg("--port") ? Number(arg("--port")) : undefined,
    config: model ? demoConfig(model.url) : undefined,
  })
  console.log(`isolated root: ${app.root}`)
  console.log(`DevTools: http://127.0.0.1:${app.port}/json/list`)
  if (model) console.log(`scripted model: ${model.url}`)
  const quit = () =>
    void app
      .stop()
      .then(() => cleanup(app.home))
      .finally(() => process.exit(0))
  process.on("SIGINT", quit)
  process.on("SIGTERM", quit)
  await app.exited
  cleanup(app.home)
  model?.stop()
}
