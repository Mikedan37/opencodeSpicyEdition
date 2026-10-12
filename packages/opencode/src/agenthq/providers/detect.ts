// Detection for external agent CLIs: `which` + `--version` (plus `--help` for cursor's ACP command and
// `codex login status`) with a short timeout. Never reads credentials or the environment: `auth` is "ok" or
// "required" only where the CLI itself answers, and "unknown" otherwise.
import { AppProcess } from "@opencode-ai/core/process"
import { which } from "@opencode-ai/core/util/which"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
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

// AgentKit through its bridge's ACP mode (`agentkit-bridge acp`, from OpenCode Native's AgentKitBridge). An identity's
// `launch.command` replaces the bridge found on PATH; Agent HQ always runs it with `acp`.
export const AGENTKIT_BRIDGE = "agentkit-bridge"

const agentkitCapabilities: AgentHQ.ProviderCapabilities = {
  ...AcpProvider.capabilities,
  notes: [
    "Runs `agentkit-bridge acp` from PATH, or the identity's launch command",
    ...(AcpProvider.capabilities.notes ?? []),
  ],
}

/** AgentKit; available when an agentkit-bridge on PATH answers `acp --help`. */
export const agentkit = Effect.fn("AgentHQ.detect.agentkit")(function* (env?: Env) {
  const proc = yield* AppProcess.Service
  const base = { id: "agentkit", name: "AgentKit", auth: "unknown", capabilities: agentkitCapabilities } as const
  const find = () => which(AGENTKIT_BRIDGE, { PATH: (env ?? { PATH: process.env.PATH }).PATH ?? "" }) ?? undefined
  const detected: Effect.Effect<AgentHQ.ProviderStatus> = Effect.gen(function* () {
    const bin = find()
    if (!bin) return { ...base, available: false, reason: "AgentKit bridge not found" }
    // An ACP mode answers `acp --help` and names itself; a bridge without one fails or prints other usage.
    const help = ChildProcess.make(bin, ["acp", "--help"], { stdin: "ignore", env: AgentProvider.agentEnv() })
    const acp = yield* proc.run(help, { timeout: "3 seconds" }).pipe(
      Effect.map(
        (result) =>
          result.exitCode === 0 && /\bacp\b/i.test(result.stdout.toString("utf8") + result.stderr.toString("utf8")),
      ),
      Effect.orElseSucceed(() => false),
    )
    if (!acp) return { ...base, available: false, reason: "this AgentKit bridge has no ACP mode yet" }
    return { ...base, available: true }
  }).pipe(Effect.provideService(AppProcess.Service, proc))
  return yield* AcpProvider.make({
    id: "agentkit",
    status: detected,
    launch: (agent) =>
      Effect.gen(function* () {
        if (agent.launch?.command) return { command: agent.launch.command, args: ["acp"] }
        const current = yield* detected
        const bin = find()
        if (!current.available || !bin)
          return yield* new AgentProvider.UnsupportedError({
            provider: "agentkit",
            action: "createSession",
            message: current.reason ?? "AgentKit bridge not found",
          })
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
