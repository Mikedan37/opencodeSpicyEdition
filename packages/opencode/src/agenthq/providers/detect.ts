// Detection for external agent CLIs: `which` + `--version` (and `--help` for cursor's ACP command) with a
// short timeout. Never reads credentials or the environment, so `auth` stays "unknown".
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
  const version = (yield* run(bin, ["--version"])).split(/\s+/)[0]
  if (!version) return { ...base, available: false, reason: `${cli.binary} --version failed or timed out` }
  // cursor-agent's headless -p mode runs every tool without approval; only its ACP mode is usable.
  if (id === "cursor" && !/^\s+acp\b/m.test(yield* run(bin, ["--help"])))
    return {
      ...base,
      version,
      available: false,
      reason: `cursor-agent ${version.split("-")[0]} has no ACP mode; update cursor-agent`,
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

/** A provider that only reports status (Codex until it is installed and evaluated). */
export const make = Effect.fn("AgentHQ.detect.make")(function* (id: CliID, env?: Env) {
  const proc = yield* AppProcess.Service
  return {
    id,
    status: status(id, { env }).pipe(Effect.provideService(AppProcess.Service, proc)),
    createSession: () =>
      Effect.fail(
        new AgentProvider.UnsupportedError({
          provider: id,
          action: "createSession",
          message: `${CLIS[id].name} sessions are not supported by Agent HQ yet`,
        }),
      ),
  } satisfies AgentProvider.Interface
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
