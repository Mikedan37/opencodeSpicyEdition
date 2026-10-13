// The agent's debugger. Launch, attach and evaluate ask permission; reads never run program code.
// Every launch belongs to an investigation; the agent can add notes or hand it to the user, but
// only the server records evidence and moves its status.
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Schema } from "effect"
import { Workbench } from "@opencode-ai/schema/workbench"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "@/tool/tool"
import { DebugError } from "../dap/client"
import { DebugLaunch } from "../dap/launch"
import { WorkbenchDebug } from "../dap/service"
import type { DebugSession } from "../dap/session"
import { DebugSnapshot } from "../dap/snapshot"
import { WorkbenchInvestigation } from "../investigation/investigation"
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
    "note",
    "escalate",
    "resume",
  ]),
  session: Schema.optional(Schema.String).annotate({
    description: "Debug session id (dbg_…); defaults to your latest",
  }),
  title: Schema.optional(Schema.String).annotate({ description: "start: what is being investigated" }),
  ...DebugLaunch.StartInput.fields,
  pid: DebugLaunch.AttachInput.fields.pid,
  port: DebugLaunch.AttachInput.fields.port,
  command: Schema.optional(Schema.Literals(["continue", "pause", "next", "stepIn", "stepOut"])),
  functions: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Function breakpoints" }),
  clear: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Files whose breakpoints to remove" }),
  path: Schema.optional(Schema.String).annotate({ description: "Variable path for inspect, e.g. orders.bob" }),
  ref: Schema.optional(NonNegativeInt).annotate({ description: "Variable reference for inspect" }),
  frame: Schema.optional(Schema.Int).annotate({
    description: "Stack frame id (the #id in the frames line of the latest stop); defaults to the top frame",
  }),
  start: Schema.optional(NonNegativeInt).annotate({ description: "First child to show when paging inspect" }),
  expression: Schema.optional(Schema.String),
  since: Schema.optional(NonNegativeInt).annotate({ description: "Output row number to continue after" }),
  kind: Schema.optional(Schema.Literals(["hypothesis", "question"])).annotate({ description: "note: kind of note" }),
  text: Schema.optional(Schema.String).annotate({ description: "note: the note; escalate: why the user is needed" }),
  investigation: Schema.optional(Schema.String).annotate({ description: "resume: investigation id (inv_…)" }),
})
type Parameters = typeof Parameters.Type

type Metadata = {
  session?: Workbench.DebugSessionInfo
  snapshot?: Workbench.StopSnapshot
  sessions?: Workbench.DebugSessionInfo[]
  investigation?: Workbench.InvestigationSummary
}

const OUTPUT_CHARS = 4_000
// Last console row already shown to the agent, per session.
const seen = new WeakMap<DebugSession.Session, number>()
// The agent stops driving while its investigation waits for the user or has ended badly.
const HALTED: readonly Workbench.InvestigationStatus[] = ["needs_human", "blocked", "failed", "cancelled"]

export const DebugTool = Tool.define<
  typeof Parameters,
  Metadata,
  WorkbenchDebug.Service | WorkbenchInvestigation.Service
>(
  "debug",
  Effect.gen(function* () {
    const debug = yield* WorkbenchDebug.Service
    const investigations = yield* WorkbenchInvestigation.Service

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

        // A denied permission is recorded (supervisor S7) before the denial reaches the model.
        const ask = (request: Ask, investigation?: Workbench.InvestigationID) =>
          ctx
            .ask(request)
            .pipe(
              Effect.catchDefect((defect) =>
                investigation && denied(defect)
                  ? investigations
                      .record(investigation, { type: "permission.denied", permission: request.permission })
                      .pipe(Effect.ignore, Effect.andThen(Effect.die(defect)))
                  : Effect.die(defect),
              ),
            )
        const pick = Effect.gen(function* () {
          if (args.session) return yield* debug.get(args.session)
          const found = yield* debug.current(ctx.sessionID)
          if (!found)
            return yield* new DebugError({ kind: "not_found", message: "no live debug session; start one first" })
          return found
        })
        const mine = Effect.gen(function* () {
          const found = yield* investigations.current(ctx.sessionID)
          if (!found)
            return yield* new DebugError({ kind: "not_found", message: "no open investigation; start debugging first" })
          return found
        })
        // Control commands stop while the investigation needs the user; reading stays allowed.
        const driving = (session: DebugSession.Session) =>
          Effect.gen(function* () {
            const id = session.info().investigationID
            if (!id) return
            const record = yield* investigations.get(id)
            if (HALTED.includes(record.status))
              return yield* new DebugError({
                kind: "not_owner",
                message: `investigation ${id} is ${record.status}${
                  record.checkpoints.at(-1)?.reason ? ` (${record.checkpoints.at(-1)?.reason})` : ""
                }; stop and tell the user`,
              })
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
        const launch = (record: WorkbenchInvestigation.Info, spec: DebugLaunch.Spec, title: string) =>
          Effect.gen(function* () {
            const started = yield* investigations.launch(record.id, spec, actor)
            const shown = reply(started.session, title, stopText(started.result), started.result)
            return { ...shown, output: `${shown.output}\ninvestigation ${record.id} (${record.title})` }
          })

        if (args.action === "start" || args.action === "attach") {
          const spec =
            args.action === "start"
              ? yield* debug.prepare(args)
              : yield* debug.prepareAttach(
                  args.adapter
                    ? { ...args, adapter: args.adapter }
                    : yield* new DebugError({ kind: "invalid", message: "attach needs adapter" }),
                )
          const label = spec.program ? relative(directory, spec.program) : spec.name
          const record = yield* investigations.open({
            sessionID: ctx.sessionID,
            title: args.title ?? `debug ${label}`,
            ...(args.action === "start" ? { target: target(args) } : {}),
          })
          if (HALTED.includes(record.status))
            return yield* new DebugError({
              kind: "not_owner",
              message: `investigation ${record.id} is ${record.status}; the user has to resume it first`,
            })
          yield* ask(
            {
              // A launch.json configuration may attach instead of launching.
              permission: spec.request === "attach" ? "debug.attach" : "debug.launch",
              patterns: [label],
              always: [label],
              metadata: {
                adapter: spec.adapter,
                program: label,
                investigation: record.id,
                ...(args.configuration ? { configuration: args.configuration } : {}),
                // The approval covers the build too: it runs project code (build scripts, proc macros).
                ...(spec.build ? { build: spec.build.command.join(" ") } : {}),
              },
            },
            record.id,
          )
          return yield* launch(record, spec, `debug ${args.action} ${label}`)
        }

        if (args.action === "resume") {
          if (!args.investigation)
            return yield* new DebugError({ kind: "invalid", message: "resume needs investigation" })
          const record = yield* investigations.get(args.investigation)
          if (!record.target)
            return yield* new DebugError({
              kind: "invalid",
              message: `investigation ${record.id} has no stored target`,
            })
          const spec = yield* debug.prepare(record.target)
          const label = spec.program ? relative(directory, spec.program) : spec.name
          yield* ask(
            {
              permission: "debug.launch",
              patterns: [label],
              always: [label],
              metadata: { adapter: spec.adapter, program: label, investigation: record.id, resume: true },
            },
            record.id,
          )
          const resumed = yield* investigations.resume(record.id, actor)
          const session = yield* debug.current(ctx.sessionID)
          const summary = WorkbenchInvestigation.summary(resumed)
          return {
            title: `debug resume ${record.id}`,
            output: [
              `investigation ${record.id} ${resumed.status}`,
              ...(session
                ? [
                    header(session.info()),
                    session.info().stop ? DebugSnapshot.text({ snapshot: session.info().stop!, directory }) : "",
                  ]
                : []),
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: { investigation: summary, ...(session ? { session: session.info() } : {}) },
          }
        }

        if (args.action === "note" || args.action === "escalate") {
          if (!args.text) return yield* new DebugError({ kind: "invalid", message: `${args.action} needs text` })
          const record = yield* mine
          const updated =
            args.action === "note"
              ? yield* investigations.note(record.id, { kind: args.kind ?? "hypothesis", text: args.text })
              : yield* investigations.escalate(record.id, args.text)
          const summary = WorkbenchInvestigation.summary(updated)
          return {
            title: `debug ${args.action}`,
            output: `investigation ${updated.id} ${updated.status}${
              args.action === "note" ? ` · ${updated.notes.length} notes (inferred, not evidence)` : ""
            }`,
            metadata: { investigation: summary },
          }
        }

        if (args.action === "status") {
          const sessions = yield* debug.list()
          const record = yield* investigations.current(ctx.sessionID)
          return {
            title: "debug status",
            output: [
              ...(sessions.length ? sessions.map((info) => header(info)) : ["no debug sessions"]),
              ...(record
                ? [
                    `investigation ${record.id} ${record.status}: ${record.title} · ${record.evidence.length} evidence · ${record.notes.length} notes`,
                  ]
                : []),
            ].join("\n"),
            metadata: { sessions, ...(record ? { investigation: WorkbenchInvestigation.summary(record) } : {}) },
          }
        }

        const session = yield* pick

        if (args.action === "control") {
          yield* driving(session)
          const result = yield* session.control(args.command ?? "continue", actor)
          return reply(session, `debug ${args.command ?? "continue"}`, stopText(result), result)
        }

        if (args.action === "breakpoints") {
          yield* driving(session)
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
          yield* driving(session)
          const investigation = session.info().investigationID
          yield* ask(
            {
              permission: "debug.evaluate",
              patterns: [args.expression],
              always: ["*"],
              metadata: { expression: args.expression, session: session.id },
            },
            investigation,
          )
          // The evaluation is evidence; its console rows carry the evidence id so the console links to it.
          const evidenceID = investigation ? Workbench.EvidenceID.create() : undefined
          const row = yield* session.evaluate(
            {
              expression: args.expression,
              ...(args.frame !== undefined ? { frameID: args.frame } : {}),
              ...(evidenceID ? { evidenceID } : {}),
            },
            actor,
          )
          if (investigation)
            yield* investigations
              .record(investigation, {
                type: "console.eval",
                debugSessionID: session.id,
                expression: args.expression,
                result: row.text,
                ...(evidenceID ? { evidenceID } : {}),
              })
              .pipe(Effect.ignore)
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

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

function denied(defect: unknown) {
  return (
    defect instanceof PermissionV1.RejectedError ||
    defect instanceof PermissionV1.DeniedError ||
    defect instanceof PermissionV1.CorrectedError
  )
}

/** What resume relaunches: the launch fields of the start call. */
function target(args: Parameters): DebugLaunch.StartInput {
  return Object.fromEntries(
    Object.keys(DebugLaunch.StartInput.fields)
      .map((name) => [name, args[name as keyof DebugLaunch.StartInput]] as const)
      .filter((entry) => entry[1] !== undefined),
  ) as DebugLaunch.StartInput
}

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

// The services the tool and the workbench routes need, so the registry adds one dependency line.
export const DebugToolNode = LayerNode.group([WorkbenchDebug.node, WorkbenchInvestigation.node])
