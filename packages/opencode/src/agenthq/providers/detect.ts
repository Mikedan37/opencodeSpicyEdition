// Status-only providers for external agent CLIs. Detection runs the binary's --version/--help with
// a short timeout and never reads credentials or the environment, so `auth` stays "unknown".
// Their session adapters land in a later wave; until then createSession fails with UnsupportedError.
import { AppProcess } from "@opencode-ai/core/process"
import { which } from "@opencode-ai/core/util/which"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentProvider } from "../provider"

const CLIS = {
  "claude-code": { name: "Claude Code", binary: "claude" },
  cursor: { name: "Cursor", binary: "cursor-agent" },
  codex: { name: "Codex", binary: "codex" },
} as const

const capabilities: AgentHQ.ProviderCapabilities = {
  streaming: false,
  toolEvents: false,
  permissionRequests: false,
  cancel: false,
  resume: false,
  models: false,
  mcpTools: false,
  notes: ["Agent HQ adapter not implemented yet; sessions cannot start"],
}

export const make = Effect.fn("AgentHQ.detect.make")(function* (
  id: keyof typeof CLIS,
  env: { readonly PATH?: string } = { PATH: process.env.PATH },
) {
  const proc = yield* AppProcess.Service
  const cli = CLIS[id]
  const base = { id, name: cli.name, auth: "unknown", capabilities } as const

  const run = (bin: string, args: string[]) =>
    proc.run(ChildProcess.make(bin, args, { stdin: "ignore" }), { timeout: "3 seconds" }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8").trim() : "")),
      Effect.orElseSucceed(() => ""),
    )

  const status = Effect.gen(function* () {
    const bin = which(cli.binary, { PATH: env.PATH ?? "" })
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
  }).pipe(Effect.withSpan("AgentHQ.detect.status", { attributes: { provider: id } }))

  return {
    id,
    status,
    createSession: () =>
      Effect.fail(
        new AgentProvider.UnsupportedError({
          provider: id,
          action: "createSession",
          message: `${cli.name} sessions are not supported by Agent HQ yet`,
        }),
      ),
  } satisfies AgentProvider.Interface
})

export * as AgentDetect from "./detect"
