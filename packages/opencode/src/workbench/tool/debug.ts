// The agent's debugger. Launch, attach and evaluate ask permission; reads never run program code.
import path from "path"
import { Effect, Schema } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "@/tool/tool"
import { DebugError } from "../dap/client"
import { DebugLaunch } from "../dap/launch"
import { WorkbenchDebug } from "../dap/service"
import type { DebugSession } from "../dap/session"
import { DebugSnapshot } from "../dap/snapshot"
import DESCRIPTION from "./debug.txt"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "start",
    "attach",
    "control",
    "breakpoints",
    "inspect",
    "evaluate",
    "output",
    "status",
    "stop",
  ]),
  session: Schema.optional(Schema.String).annotate({
    description: "Debug session id (dbg_…); defaults to your latest",
  }),
  ...DebugLaunch.StartInput.fields,
  pid: DebugLaunch.AttachInput.fields.pid,
  port: DebugLaunch.AttachInput.fields.port,
  command: Schema.optional(Schema.Literals(["continue", "pause", "next", "stepIn", "stepOut"])),
  functions: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Function breakpoints" }),
  clear: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Files whose breakpoints to remove" }),
  path: Schema.optional(Schema.String).annotate({ description: "Variable path for inspect, e.g. orders.bob" }),
  ref: Schema.optional(NonNegativeInt).annotate({ description: "Variable reference for inspect" }),
  frame: Schema.optional(Schema.Int).annotate({ description: "Stack frame id; defaults to the top frame" }),
  start: Schema.optional(NonNegativeInt).annotate({ description: "First child to show when paging inspect" }),
  expression: Schema.optional(Schema.String),
  since: Schema.optional(NonNegativeInt).annotate({ description: "Output row number to continue after" }),
})
type Parameters = typeof Parameters.Type

type Metadata = {
  session?: Workbench.DebugSessionInfo
  snapshot?: Workbench.StopSnapshot
  sessions?: Workbench.DebugSessionInfo[]
}

const OUTPUT_CHARS = 4_000
// Last console row already shown to the agent, per session.
const seen = new WeakMap<DebugSession.Session, number>()

export const DebugTool = Tool.define<typeof Parameters, Metadata, WorkbenchDebug.Service>(
  "debug",
  Effect.gen(function* () {
    const debug = yield* WorkbenchDebug.Service

    const tool = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Parameters, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // Aborting the agent mid-call ends its debug sessions. ctx.abort also fires when a provider
          // turn ends normally, so the listener only lives for this call; between calls, cancelling
          // the agent session ends them through their background job (see WorkbenchDebug.start).
          if (ctx.abort.aborted)
            return yield* new DebugError({ kind: "invalid", message: "the agent session was aborted" })
          const bridge = yield* EffectBridge.make()
          const onAbort = () => void bridge.fork(debug.abort(ctx.sessionID, "the agent session was aborted"))
          ctx.abort.addEventListener("abort", onAbort, { once: true })
          return yield* run(args, ctx).pipe(
            Effect.ensuring(Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))),
          )
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
    return tool

    function run(args: Parameters, ctx: Tool.Context<Metadata>) {
      return Effect.gen(function* () {
        const directory = (yield* InstanceState.context).directory
        const actor = { by: "agent" as const, sessionID: ctx.sessionID }

        const pick = Effect.gen(function* () {
          if (args.session) return yield* debug.get(args.session)
          const found = yield* debug.current(ctx.sessionID)
          if (!found)
            return yield* new DebugError({ kind: "not_found", message: "no live debug session; start one first" })
          return found
        })
        const reply = (session: DebugSession.Session, title: string, body: string, result?: DebugSession.Result) => {
          const info = result?.info ?? session.info()
          const fresh = session.output(seen.get(session) ?? 0)
          seen.set(session, fresh.at(-1)?.seq ?? seen.get(session) ?? 0)
          return {
            title,
            output: [header(info, result), body, programOutput(fresh)].filter(Boolean).join("\n"),
            metadata: { session: info, ...(info.stop ? { snapshot: info.stop } : {}) },
          }
        }
        const stopText = (result: DebugSession.Result) =>
          [
            ...(result.note ? [`note      ${result.note}`] : []),
            ...(result.info.stop
              ? [DebugSnapshot.text({ snapshot: result.info.stop, directory })]
              : result.outcome === "running"
                ? ["the program is running"]
                : []),
          ].join("\n")

        if (args.action === "start") {
          const spec = yield* debug.prepare(args)
          const label = spec.program ? relative(directory, spec.program) : spec.name
          yield* ctx.ask({
            // A launch.json configuration may attach instead of launching.
            permission: spec.request === "attach" ? "debug.attach" : "debug.launch",
            patterns: [label],
            always: [label],
            metadata: {
              adapter: spec.adapter,
              program: label,
              ...(args.configuration ? { configuration: args.configuration } : {}),
            },
          })
          const started = yield* debug.start(spec, actor)
          return reply(started.session, `debug start ${label}`, stopText(started.result), started.result)
        }

        if (args.action === "attach") {
          if (!args.adapter) return yield* new DebugError({ kind: "invalid", message: "attach needs adapter" })
          const spec = yield* debug.prepareAttach({ ...args, adapter: args.adapter })
          yield* ctx.ask({
            permission: "debug.attach",
            patterns: [spec.name],
            always: [spec.name],
            metadata: { adapter: spec.adapter, target: spec.name },
          })
          const started = yield* debug.start(spec, actor)
          return reply(started.session, `debug attach ${spec.name}`, stopText(started.result), started.result)
        }

        if (args.action === "status") {
          const sessions = yield* debug.list()
          return {
            title: "debug status",
            output: sessions.length ? sessions.map((info) => header(info)).join("\n") : "no debug sessions",
            metadata: { sessions },
          }
        }

        const session = yield* pick

        if (args.action === "control") {
          const result = yield* session.control(args.command ?? "continue", actor)
          return reply(session, `debug ${args.command ?? "continue"}`, stopText(result), result)
        }

        if (args.action === "breakpoints") {
          const files = Map.groupBy(args.breakpoints ?? [], (item) => path.resolve(directory, item.file))
          for (const file of args.clear ?? []) files.set(path.resolve(directory, file), [])
          const results = yield* Effect.forEach([...files], ([file, items]) =>
            session.breakpoints({ file, breakpoints: items }, actor),
          )
          const extra =
            args.functions || args.exceptions
              ? [
                  yield* session.breakpoints(
                    {
                      ...(args.functions ? { functions: args.functions } : {}),
                      ...(args.exceptions ? { exceptions: args.exceptions } : {}),
                    },
                    actor,
                  ),
                ]
              : []
          const lines = [...results, ...extra].flatMap((item) => [
            ...item.breakpoints.map(
              (bp) =>
                `${relative(directory, item.file ?? "")}:${bp.line} ${bp.verified ? "verified" : `not verified${bp.message ? ` (${bp.message})` : ""}`}`,
            ),
            ...(item.functions ?? []).map((fn) => `function ${fn.name} ${fn.verified ? "verified" : "not verified"}`),
            ...(item.exceptions ? [`exception filters: ${item.exceptions.join(", ") || "none"}`] : []),
          ])
          return reply(session, "debug breakpoints", lines.join("\n") || "no breakpoints")
        }

        if (args.action === "inspect") {
          const tree = yield* session.inspect(
            {
              ...(args.path ? { path: args.path } : {}),
              ...(args.ref !== undefined ? { ref: args.ref } : {}),
              ...(args.frame !== undefined ? { frameID: args.frame } : {}),
              ...(args.start !== undefined ? { start: args.start } : {}),
            },
            actor,
          )
          return reply(
            session,
            `debug inspect ${args.path ?? args.ref ?? "locals"}`,
            DebugSnapshot.treeText(tree) || "(nothing)",
          )
        }

        if (args.action === "evaluate") {
          if (!args.expression) return yield* new DebugError({ kind: "invalid", message: "evaluate needs expression" })
          yield* ctx.ask({
            permission: "debug.evaluate",
            patterns: [args.expression],
            always: ["*"],
            metadata: { expression: args.expression, session: session.id },
          })
          const row = yield* session.evaluate(
            { expression: args.expression, ...(args.frame !== undefined ? { frameID: args.frame } : {}) },
            actor,
          )
          return reply(
            session,
            `debug evaluate ${args.expression}`,
            `${row.kind === "exception" ? "error" : "result"}: ${row.text}${row.variablesReference ? ` [ref ${row.variablesReference}]` : ""}`,
          )
        }

        if (args.action === "output") {
          const rows = session.output(args.since ?? 0)
          seen.set(session, rows.at(-1)?.seq ?? seen.get(session) ?? 0)
          return {
            title: "debug output",
            output: [
              header(session.info()),
              programOutput(rows) || "no program output",
              `last row ${rows.at(-1)?.seq ?? args.since ?? 0}`,
            ].join("\n"),
            metadata: { session: session.info() },
          }
        }

        const info = yield* session.stop(actor)
        return reply(session, "debug stop", "", { info, outcome: info.state === "failed" ? "failed" : "terminated" })
      })
    }
  }),
)

function header(info: Workbench.DebugSessionInfo, result?: DebugSession.Result) {
  return `${info.id} · ${info.adapter}${info.program ? ` ${path.basename(info.program)}` : ""} · ${info.state}${
    result?.exitCode !== undefined ? ` (exit code ${result.exitCode})` : ""
  } · owner ${info.owner}${info.error ? ` · error: ${info.error}` : ""}`
}

/** Program output is untrusted: it reaches the model only inside this labeled block. */
function programOutput(rows: readonly Workbench.ConsoleRow[]) {
  const text = rows
    .filter((row) => row.by === "program" || (row.kind === "system" && row.text.startsWith("…")))
    .map((row) => row.text)
    .join("")
  if (!text) return ""
  const tail = text.length > OUTPUT_CHARS ? `…${text.slice(-OUTPUT_CHARS)}` : text
  return `<program_output untrusted="true">\n${tail}${tail.endsWith("\n") ? "" : "\n"}</program_output>`
}

function relative(directory: string, file: string) {
  const result = path.relative(directory, file)
  return result && !result.startsWith("..") && !path.isAbsolute(result) ? result : file
}

// The service the tool needs, so the registry adds one dependency line.
export const DebugToolNode = WorkbenchDebug.node
