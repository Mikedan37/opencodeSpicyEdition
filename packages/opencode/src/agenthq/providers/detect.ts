// Detection for external agent CLIs: `which` + `--version` (plus `--help` for cursor's ACP command and
// `codex login status`) with a short timeout. Never reads credentials or the environment: `auth` is "ok" or
// "required" only where the CLI itself answers, and "unknown" otherwise.
import { Global } from "@opencode-ai/core/global"
import { AppProcess } from "@opencode-ai/core/process"
import { existsSync, realpathSync, statSync } from "fs"
import os from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentProvider } from "../provider"
import { AcpProvider } from "./acp"

export const CLIS = {
  "claude-code": { name: "Claude Code", binary: "claude" },
  cursor: { name: "Cursor", binary: "cursor-agent" },
  codex: { name: "Codex", binary: "codex" },
} as const
export type CliID = keyof typeof CLIS

export interface Env {
  readonly PATH?: string
}

const none: AgentHQ.ProviderCapabilities = {
  streaming: false,
  toolEvents: false,
  permissionRequests: false,
  cancel: false,
  resume: false,
  models: false,
  mcpTools: false,
  notes: ["Agent HQ adapter not implemented yet; sessions cannot start"],
}

/** Absolute path of the CLI on PATH, or undefined. */
export function binary(id: CliID, env: Env = { PATH: process.env.PATH }) {
  return which(CLIS[id].binary, { PATH: env.PATH ?? "" }) ?? undefined
}

/** Detected status of a CLI; `capabilities` are what Agent HQ can do with it once it is available. */
export const status = Effect.fn("AgentHQ.detect.status")(function* (
  id: CliID,
  input: { readonly env?: Env; readonly capabilities?: AgentHQ.ProviderCapabilities } = {},
) {
  const proc = yield* AppProcess.Service
  const cli = CLIS[id]
  const run = (bin: string, args: string[]) =>
    proc
      .run(ChildProcess.make(bin, args, { stdin: "ignore", env: AgentProvider.agentEnv() }), { timeout: "3 seconds" })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8").trim() : "")),
        Effect.orElseSucceed(() => ""),
      )
  const base = { id, name: cli.name, auth: "unknown", capabilities: input.capabilities ?? none } as const
  const bin = binary(id, input.env)
  if (!bin) return { ...base, available: false, reason: `${cli.binary} not found on PATH` }
  // The first version-looking token: "2.1.296 (Claude Code)", "codex-cli 0.162.1", "2026.10.01-1a2b3c".
  const version = (yield* run(bin, ["--version"])).match(/\d+\.\d+[\w.+-]*/)?.[0]
  if (!version) return { ...base, available: false, reason: `${cli.binary} --version failed or timed out` }
  // cursor-agent's headless -p mode runs every tool without approval; only an ACP mode would be usable.
  if (id === "cursor" && !/^\s+acp\b/m.test(yield* run(bin, ["--help"])))
    return {
      ...base,
      version,
      available: false,
      reason: "Cursor's CLI has no ACP mode; Agent HQ needs approvals routed to you",
    }
  return { ...base, version, available: true }
})

/** A status probe bound to this process's spawner, for providers built elsewhere. */
export const prober = Effect.fn("AgentHQ.detect.prober")(function* (
  id: CliID,
  capabilities: AgentHQ.ProviderCapabilities,
  env?: Env,
) {
  const proc = yield* AppProcess.Service
  const probe: Effect.Effect<AgentHQ.ProviderStatus> = status(id, { env, capabilities }).pipe(
    Effect.provideService(AppProcess.Service, proc),
  )
  return probe
})

// Codex through Zed's ACP bridge. `untrusted` makes Codex ask before anything but known-safe reads (every edit, every
// other command); approved commands still run in its workspace-write sandbox; and every approval goes to the human
// as `session/request_permission`, never to Codex's own reviewer. Set explicitly, whatever ~/.codex/config.toml says.
export const CODEX_BRIDGE = "@zed-industries/codex-acp@0.16.0"
export const CODEX_POLICY = [
  "-c",
  'approval_policy="untrusted"',
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  'approvals_reviewer="user"',
]

/** What to spawn for Codex: `codex-acp` from PATH, else the pinned bridge through npx; undefined when neither runs. */
export function codexLaunch(env: Env = { PATH: process.env.PATH }) {
  const PATH = env.PATH ?? ""
  const own = which("codex-acp", { PATH })
  if (own) return { command: own, args: CODEX_POLICY }
  const npx = which("npx", { PATH })
  if (npx) return { command: npx, args: ["-y", CODEX_BRIDGE, ...CODEX_POLICY] }
  return undefined
}

const codexCapabilities: AgentHQ.ProviderCapabilities = {
  ...AcpProvider.capabilities,
  notes: [
    `Runs Zed's ACP bridge (codex-acp from PATH, else npx ${CODEX_BRIDGE})`,
    "Codex asks before every edit and every command but known-safe reads; approved commands run in its workspace-write sandbox",
    ...(AcpProvider.capabilities.notes ?? []),
  ],
}

/** Codex through Zed's ACP bridge; available when codex is installed, logged in, and the bridge can run. */
export const codex = Effect.fn("AgentHQ.detect.codex")(function* (env?: Env) {
  const proc = yield* AppProcess.Service
  const detected: Effect.Effect<AgentHQ.ProviderStatus> = Effect.gen(function* () {
    const found: AgentHQ.ProviderStatus = yield* status("codex", { env, capabilities: codexCapabilities })
    if (!found.available) return found
    // Only the exit code: codex checks its own login, and nothing it prints is kept.
    const login = ChildProcess.make(binary("codex", env)!, ["login", "status"], {
      stdin: "ignore",
      env: AgentProvider.agentEnv(),
    })
    const loggedIn = yield* proc.run(login, { timeout: "5 seconds" }).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    )
    if (!loggedIn)
      return {
        ...found,
        available: false,
        auth: "required" as const,
        reason: "Codex is not logged in; run `codex login`",
      }
    if (!codexLaunch(env))
      return {
        ...found,
        available: false,
        auth: "ok" as const,
        reason: "Codex needs Zed's codex-acp bridge: put codex-acp or npx on PATH",
      }
    return { ...found, auth: "ok" as const }
  }).pipe(Effect.provideService(AppProcess.Service, proc))
  return yield* AcpProvider.make({
    id: "codex",
    status: detected,
    launch: () =>
      Effect.gen(function* () {
        const current = yield* detected
        const launch = codexLaunch(env)
        if (!current.available || !launch)
          return yield* new AgentProvider.UnsupportedError({
            provider: "codex",
            action: "createSession",
            message: current.reason ?? "Codex is unavailable",
          })
        return launch
      }),
  })
})

// AgentKit through its bridge's ACP mode (`agentkit-bridge acp`, shipped inside OpenCode Native). An identity's
// `launch` replaces the bridge (its args, or `acp` when it has none); otherwise the bridge is found as below.
export const AGENTKIT_BRIDGE = "agentkit-bridge"
// OpenCode Native's bundle id (its Info.plist), for LaunchServices' index of every copy on this Mac.
export const AGENTKIT_BUNDLE_ID = "local.opencode.spicy.native"

/** What the trust check reads of a file; `fs.Stats` has all of it. */
export interface FileFacts {
  readonly uid: number
  readonly mode: number
  readonly size: number
  readonly mtimeMs: number
  readonly ino: number
}

export interface AgentKitEnv extends Env {
  /** Explicit bridge binary; when set, nothing else is searched. */
  readonly OPENCODE_AGENTKIT_BRIDGE?: string
  /** Folders holding `OpenCode Native.app` (default /Applications and ~/Applications). */
  readonly applications?: readonly string[]
  /** OpenCode Native apps wherever they are (default: LaunchServices through mdfind, macOS only). */
  readonly finder?: Effect.Effect<readonly string[], unknown>
  /** Whether any of these paths is quarantined (default: `quarantined` below). */
  readonly quarantined?: (paths: readonly string[]) => Effect.Effect<boolean>
  /** The file system as the trust check sees it (default: realpathSync and statSync). */
  readonly files?: { readonly realpath: (file: string) => string; readonly stat: (file: string) => FileFacts }
}

/** The bridge the human chose: OPENCODE_AGENTKIT_BRIDGE (alone when set), else PATH. */
export function agentkitBridge(
  env: AgentKitEnv = { PATH: process.env.PATH, OPENCODE_AGENTKIT_BRIDGE: process.env.OPENCODE_AGENTKIT_BRIDGE },
) {
  if (env.OPENCODE_AGENTKIT_BRIDGE)
    return existsSync(env.OPENCODE_AGENTKIT_BRIDGE) ? env.OPENCODE_AGENTKIT_BRIDGE : undefined
  return which(AGENTKIT_BRIDGE, { PATH: env.PATH ?? "" }) ?? undefined
}

/**
 * Whether any of these paths carries macOS's `com.apple.quarantine` attribute (downloaded, not yet opened). Only lists
 * attribute names, with the system's own `xattr`; an answer it cannot give counts as quarantined. Elsewhere, false.
 */
export const quarantined = Effect.fn("AgentHQ.detect.quarantined")(function* (paths: readonly string[]) {
  if (process.platform !== "darwin") return false
  const proc = yield* AppProcess.Service
  return yield* proc
    .run(ChildProcess.make("/usr/bin/xattr", [...paths], { stdin: "ignore", env: AgentProvider.agentEnv() }), {
      timeout: "3 seconds",
    })
    .pipe(
      Effect.map(
        (result) => result.exitCode !== 0 || /\bcom\.apple\.quarantine\b/.test(result.stdout.toString("utf8")),
      ),
      Effect.orElseSucceed(() => true),
    )
})

const agentkitCapabilities: AgentHQ.ProviderCapabilities = {
  ...AcpProvider.capabilities,
  notes: [
    "Runs `agentkit-bridge acp` (OPENCODE_AGENTKIT_BRIDGE, PATH, OpenCode Native.app in Applications, or the newest copy LaunchServices knows), or the identity's launch command",
    "A copy of OpenCode Native found in Applications or by LaunchServices runs only if it is yours, local and not quarantined",
    "Every change is proposed first and applied only when you allow it",
    ...(AcpProvider.capabilities.notes ?? []),
  ],
}

/** AgentKit; available when the bridge's usage lists an `acp` mode. Probing starts no session and no daemon. */
export const agentkit = Effect.fn("AgentHQ.detect.agentkit")(function* (env?: AgentKitEnv) {
  const proc = yield* AppProcess.Service
  const files = env?.files ?? { realpath: (file: string) => realpathSync(file), stat: (file: string) => statSync(file) }
  const isQuarantined =
    env?.quarantined ??
    ((paths: readonly string[]) => quarantined(paths).pipe(Effect.provideService(AppProcess.Service, proc)))
  const base = { id: "agentkit", name: "AgentKit", auth: "unknown", capabilities: agentkitCapabilities } as const
  const run = (bin: string, args: string[]) =>
    proc
      .run(ChildProcess.make(bin, args, { stdin: "ignore", env: AgentProvider.agentEnv() }), { timeout: "3 seconds" })
      .pipe(
        Effect.map((result) => result.stdout.toString("utf8") + result.stderr.toString("utf8")),
        Effect.orElseSucceed(() => ""),
      )

  // What a bridge says about itself, asked once per binary (real path, size, mtime, inode): provider lists never run a
  // binary again until it changes. One question at a time, so two lists never ask the same binary twice.
  // ponytail: keyed on the file that runs; a wrapper script on PATH hides a change behind it until the server restarts.
  const known = new Map<string, { readonly acp: boolean; readonly version?: string }>()
  const asking = Semaphore.makeUnsafe(1)
  const identity = (bin: string) => {
    try {
      const real = files.realpath(bin)
      const stat = files.stat(real)
      return [real, stat.size, stat.mtimeMs, stat.ino].join("\n")
    } catch {
      return undefined
    }
  }
  const about = (bin: string) =>
    asking.withPermit(
      Effect.gen(function* () {
        const key = identity(bin)
        if (!key) return { acp: false }
        const cached = known.get(key)
        if (cached) return cached
        // agentkit-bridge 0.1.0 prints its usage, "app-server | mcp | acp [--local-only] | ...", for --help (exit 64).
        const acp = /\bacp\b/.test(yield* run(bin, ["--help"]))
        const version = acp ? (yield* run(bin, ["--version"])).match(/\d+\.\d+[\w.+-]*/)?.[0] : undefined
        const answer = { acp, ...(version ? { version } : {}) }
        known.set(key, answer)
        return answer
      }),
    )

  // A copy of OpenCode Native nobody pointed us at runs only if it is local and the human's own: under the home folder
  // or /Applications and not on a mounted image, owned by this user or root, neither the bridge nor its folder
  // writable by group or others, and neither the app nor the bridge quarantined. Checked on resolved paths, before
  // anything of it runs; the resolved bridge is what runs.
  const vet = (app: string) =>
    Effect.gen(function* () {
      const local = (() => {
        try {
          const bundle = files.realpath(app)
          const bin = files.realpath(path.join(app, "Contents", "MacOS", AGENTKIT_BRIDGE))
          const roots = [files.realpath(Global.Path.home), "/Applications"]
          const inside = (file: string) =>
            !file.startsWith("/Volumes/") && roots.some((root) => file.startsWith(`${root}/`))
          const uid = process.getuid?.()
          const owned = (file: string) => {
            const stat = files.stat(file)
            return (stat.uid === uid || stat.uid === 0) && (stat.mode & 0o022) === 0
          }
          if (!inside(bundle) || !inside(bin)) return undefined
          if (![bin, path.dirname(bin), path.join(bundle, "Contents", "MacOS")].every(owned)) return undefined
          return { bundle, bin, at: files.stat(bin).mtimeMs }
        } catch {
          return undefined
        }
      })()
      if (!local || (yield* isQuarantined([local.bundle, local.bin]))) return undefined
      return local
    })
  /** The newest bridge with an ACP mode among these copies of OpenCode Native, of those that pass the check. */
  const newest = (apps: readonly string[]) =>
    Effect.gen(function* () {
      const vetted = (yield* Effect.forEach(new Set(apps), vet)).filter((item) => item !== undefined)
      const usable = yield* Effect.filter(vetted, (item) => about(item.bin).pipe(Effect.map((facts) => facts.acp)))
      return usable.toSorted((a, b) => b.at - a.at)[0]
    })

  // Read-only and quiet: Spotlight's index, no network, no UI. Any failure finds nothing.
  const spotlight =
    process.platform === "darwin"
      ? proc
          .run(
            ChildProcess.make("mdfind", [`kMDItemCFBundleIdentifier == '${AGENTKIT_BUNDLE_ID}'`], {
              stdin: "ignore",
              env: AgentProvider.agentEnv(),
            }),
            { timeout: "3 seconds" },
          )
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 ? result.stdout.toString("utf8").split("\n").filter(Boolean) : [],
            ),
          )
      : Effect.succeed([])
  const indexed = (env?.finder ?? spotlight).pipe(Effect.catchCause(() => Effect.succeed([] as readonly string[])))
  // OpenCode Native.app in Applications, else the newest copy LaunchServices knows; chosen again on each provider list.
  // ponytail: one choice per process; per-identity overrides cover anything finer.
  let discovered: { readonly bundle: string; readonly bin: string } | undefined
  const discover = Effect.gen(function* () {
    const installed = (env?.applications ?? ["/Applications", path.join(os.homedir(), "Applications")]).map((folder) =>
      path.join(folder, "OpenCode Native.app"),
    )
    discovered = (yield* newest(installed)) ?? (yield* newest(yield* indexed))
    return discovered
  })
  const explicit = () => (env ? env.OPENCODE_AGENTKIT_BRIDGE : process.env.OPENCODE_AGENTKIT_BRIDGE)
  // As the human set it (the env var, alone when set, then PATH), else a found copy.
  const locate = (refresh: boolean) =>
    Effect.gen(function* () {
      const chosen = agentkitBridge(env)
      if (chosen || explicit()) return chosen ? { bin: chosen } : undefined
      return refresh || !discovered ? yield* discover : discovered
    })

  const detected: Effect.Effect<AgentHQ.ProviderStatus> = Effect.gen(function* () {
    const found = yield* locate(true)
    if (!found) return { ...base, available: false, reason: "AgentKit bridge not found" }
    const facts = yield* about(found.bin)
    if (!facts.acp) return { ...base, available: false, reason: "this AgentKit bridge has no ACP mode yet" }
    // The human sees what will run.
    const capabilities = {
      ...agentkitCapabilities,
      notes: [`Bridge: ${found.bin}`, ...(agentkitCapabilities.notes ?? [])],
    }
    return { ...base, capabilities, available: true, ...(facts.version ? { version: facts.version } : {}) }
  }).pipe(Effect.provideService(AppProcess.Service, proc))
  return yield* AcpProvider.make({
    id: "agentkit",
    status: detected,
    launch: (agent) =>
      Effect.gen(function* () {
        if (agent.launch?.command)
          return { command: agent.launch.command, args: agent.launch.args.length ? [...agent.launch.args] : ["acp"] }
        const refuse = (message: string) =>
          new AgentProvider.UnsupportedError({ provider: "agentkit", action: "createSession", message })
        // The choice the last provider list made and showed, unless there is none yet. A found copy is checked again
        // right before it runs and must still resolve to the bridge that list showed.
        const found = yield* locate(false)
        const still = found && "bundle" in found ? (yield* vet(found.bundle))?.bin : found?.bin
        const bin = still === found?.bin ? still : undefined
        if (!bin) return yield* refuse("AgentKit bridge not found")
        if (!(yield* about(bin)).acp) return yield* refuse("this AgentKit bridge has no ACP mode yet")
        return { command: bin, args: ["acp"] }
      }),
  })
})

/** Cursor through its ACP mode; refuses to start while detection says it is unavailable. */
export const cursor = Effect.fn("AgentHQ.detect.cursor")(function* (env?: Env) {
  const proc = yield* AppProcess.Service
  const detected: Effect.Effect<AgentHQ.ProviderStatus> = status("cursor", {
    env,
    capabilities: AcpProvider.capabilities,
  }).pipe(Effect.provideService(AppProcess.Service, proc))
  return yield* AcpProvider.make({
    id: "cursor",
    status: detected,
    launch: () =>
      Effect.gen(function* () {
        const current = yield* detected
        const bin = binary("cursor", env)
        if (!current.available || !bin)
          return yield* new AgentProvider.UnsupportedError({
            provider: "cursor",
            action: "createSession",
            message: current.reason ?? "cursor-agent is unavailable",
          })
        return { command: bin, args: ["acp"] }
      }),
  })
})

export * as AgentDetect from "./detect"
