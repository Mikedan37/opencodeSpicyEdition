import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Config, Context, Effect, Layer } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { ConfigService } from "@/effect/config-service"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { WorkbenchInvestigation } from "../investigation/investigation" // spicy: supervisor stops repairs
import { WorkbenchVerify } from "./verify"

// Turn-end gate. When the loop is about to stop and files changed since the last user message, run the
// inert checkers (plus exec ones that verify.exec already allows, never asking). Errors in files changed
// this turn add one synthetic user message and continue the loop, at most MAX_REPAIRS times per user
// message; errors elsewhere are reported only.

export const MAX_REPAIRS = 2
const MAX_LISTED = 30
const MARKER = "verify_gate"

// OPENCODE_VERIFY_GATE=off|report-only|fix (default fix). An env flag instead of a config key keeps the
// upstream config schema and generated SDK untouched; invalid values fall back to the default.
export class Flags extends ConfigService.Service<Flags>()("@opencode/WorkbenchGateFlags", {
  mode: Config.literals(["off", "report-only", "fix"], "OPENCODE_VERIFY_GATE").pipe(
    Config.orElse(() => Config.succeed("fix" as const)),
  ),
}) {}

export type Input = {
  sessionID: SessionID
  session: Session.Info
  messages: ReadonlyArray<SessionV1.WithParts>
}

export interface Interface {
  /** "continue" when a repair message was added and the loop should run again. */
  readonly run: (input: Input) => Effect.Effect<"continue" | "break">
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchGate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* Flags
    const verify = yield* WorkbenchVerify.Service
    const investigations = yield* WorkbenchInvestigation.Service // spicy: supervisor stops repairs
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    const gate = Effect.fn("WorkbenchGate.run")(function* (input: Input) {
      if (flags.mode === "off") return "break" as const
      const users = input.messages.flatMap((msg, index) => (msg.info.role === "user" ? [index] : []))
      const latest = users.at(-1)
      if (latest === undefined) return "break" as const
      const real = users.findLast((index) => !isRepair(input.messages[index])) ?? latest
      const ctx = yield* InstanceState.context
      if (!changedFiles(input.messages.slice(latest + 1), ctx.directory).length) return "break" as const

      const user = input.messages[real].info as SessionV1.User
      const agent = yield* agents.get(user.agent)
      const ruleset = Permission.merge(agent?.permission ?? [], input.session.permission ?? [])
      const result = yield* verify.run({
        files: turnFiles(input.messages, ctx.directory),
        trigger: "turn-end",
        sessionID: input.sessionID,
        approve: (units) =>
          Effect.succeed(units.filter((unit) => Permission.evaluate("verify.exec", unit, ruleset).action === "allow")),
      })
      if (flags.mode === "report-only") return "break" as const
      // spicy: once the supervisor blocked the session's investigation or handed it to the user, stop repairing
      if (yield* investigations.halted(input.sessionID)) return "break" as const
      const errors = result.problems.filter((item) => item.severity === "error" && item.new)
      const repairs = users.filter((index) => index > real && isRepair(input.messages[index])).length
      if (!errors.length || repairs >= MAX_REPAIRS) return "break" as const

      const last = input.messages[latest].info as SessionV1.User
      const message = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: last.agent,
        model: last.model,
      })
      const listed = errors.slice(0, MAX_LISTED).map((item) => WorkbenchVerify.formatProblem(item, ctx.directory))
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        // Marks system-generated repair requests; tools cannot create user messages, so this cannot be forged.
        metadata: { [MARKER]: { reportID: result.report.id, attempt: repairs + 1 } },
        text: [
          `The turn-end check found errors in files you changed. Fix them, then finish. (repair ${repairs + 1} of ${MAX_REPAIRS})`,
          "",
          `<verification report="${result.report.id}">`,
          ...listed,
          ...(errors.length > listed.length ? [`... and ${errors.length - listed.length} more`] : []),
          "</verification>",
        ].join("\n"),
        time: { start: Date.now(), end: Date.now() },
      })
      return "continue" as const
    })

    const run = (input: Input) =>
      gate(input).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("verification gate failed", { cause: Cause.pretty(cause) }).pipe(
                Effect.as("break" as const),
              ),
        ),
      )

    return Service.of({ run })
  }),
)

function isRepair(message: SessionV1.WithParts) {
  return message.parts.some((part) => part.type === "text" && part.metadata?.[MARKER] !== undefined)
}

/** Files changed since the last user message that is not a gate repair request. */
export function turnFiles(messages: ReadonlyArray<SessionV1.WithParts>, directory: string) {
  const real = messages.findLastIndex((message) => message.info.role === "user" && !isRepair(message))
  return changedFiles(messages.slice(real + 1), directory)
}

/** Files an assistant changed: step patch parts plus edit, write and apply_patch targets. */
export function changedFiles(messages: ReadonlyArray<SessionV1.WithParts>, directory: string) {
  const files = messages.flatMap((message) =>
    message.info.role !== "assistant"
      ? []
      : message.parts.flatMap((part): string[] => {
          if (part.type === "patch") return part.files
          if (part.type !== "tool" || part.state.status !== "completed") return []
          if (["edit", "write"].includes(part.tool) && typeof part.state.input.filePath === "string")
            return [part.state.input.filePath]
          if (part.tool === "apply_patch" && Array.isArray(part.state.metadata.files))
            return part.state.metadata.files.flatMap((file: { type?: string; filePath?: string; movePath?: string }) =>
              file.type === "delete" ? [] : [file.movePath ?? file.filePath ?? ""].filter(Boolean),
            )
          return []
        }),
  )
  return [...new Set(files.map((file) => path.resolve(directory, file)))]
}

export const flagsNode = LayerNode.make({ service: Flags, layer: Flags.layer.pipe(Layer.orDie), deps: [] })

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [flagsNode, WorkbenchVerify.node, Session.node, Agent.node, WorkbenchInvestigation.node], // spicy: investigations
})

export * as WorkbenchGate from "./gate"
