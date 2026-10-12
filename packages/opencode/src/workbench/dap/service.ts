// Debug sessions of one project (instance): at most two live at a time, events published with
// the project's location, debuggee terminals in the PTY service, everything killed on dispose.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Context, Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Debugpy } from "./adapters/debugpy"
import { Lldb } from "./adapters/lldb"
import { DebugError, type DapClient } from "./client"
import { DebugLaunch } from "./launch"
import { DebugSession } from "./session"

export const MAX_SESSIONS = 2
// Ended sessions stay listed (with their output) until this many have piled up.
const KEEP_ENDED = 10

export type Actor = DebugSession.Actor
export type Started = { readonly session: DebugSession.Session; readonly result: DebugSession.Result }
export type StartOptions = {
  readonly limits?: Partial<DebugSession.Limits>
  readonly investigationID?: Workbench.InvestigationID
  // Runs after every session update with the instance context (investigations record evidence here).
  readonly observe?: (session: DebugSession.Session) => Effect.Effect<void>
}

export interface Interface {
  readonly list: () => Effect.Effect<Workbench.DebugSessionInfo[]>
  readonly get: (id: string) => Effect.Effect<DebugSession.Session, DebugError>
  /** The session an agent session most recently started or drove, if it is still live. */
  readonly current: (agentSessionID: string) => Effect.Effect<DebugSession.Session | undefined>
  readonly prepare: (input: DebugLaunch.StartInput) => Effect.Effect<DebugLaunch.Spec, DebugError>
  readonly prepareAttach: (input: DebugLaunch.AttachInput) => Effect.Effect<DebugLaunch.Spec, DebugError>
  readonly start: (spec: DebugLaunch.Spec, actor: Actor, options?: StartOptions) => Effect.Effect<Started, DebugError>
  /** Ends every live session an agent session started, unless a human has taken it over. */
  readonly abort: (agentSessionID: string, reason: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchDebug") {}

type Entry = { readonly session: DebugSession.Session; readonly agentSessionID?: string }
type Target = {
  readonly connection: DebugSession.Connection
  readonly arguments: Record<string, unknown>
  readonly notes?: readonly string[]
  // The program actually launched, when it was built after approval (rust-test).
  readonly program?: string
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const background = yield* BackgroundJob.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make(
      Effect.fn("WorkbenchDebug.state")(function* (ctx) {
        const sessions = new Map<string, Entry>()
        const data = { sessions, ctx, closing: false }
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            // Observers must not re-enter instance state while the instance is being disposed.
            data.closing = true
            return Effect.forEach(sessions.values(), (entry) => entry.session.terminate("the project was closed"), {
              concurrency: "unbounded",
              discard: true,
            })
          }),
        )
        return data
      }),
    )

    const live = (entry: Entry) => !["terminated", "failed"].includes(entry.session.info().state)

    const get = Effect.fn("WorkbenchDebug.get")(function* (id: string) {
      const entry = (yield* InstanceState.get(state)).sessions.get(id)
      if (!entry) return yield* new DebugError({ kind: "not_found", message: `no debug session ${id}` })
      return entry.session
    })

    const prepare = Effect.fn("WorkbenchDebug.prepare")(function* (input: DebugLaunch.StartInput) {
      return yield* DebugLaunch.resolve(input, { directory: (yield* InstanceState.get(state)).ctx.directory })
    })

    const prepareAttach = Effect.fn("WorkbenchDebug.prepareAttach")(function* (input: DebugLaunch.AttachInput) {
      return yield* DebugLaunch.attach(input, { directory: (yield* InstanceState.get(state)).ctx.directory })
    })

    const connect = (spec: DebugLaunch.Spec, directory: string): Effect.Effect<Target, DebugError> =>
      Effect.gen(function* () {
        if (spec.adapter === "lldb-dap") {
          // Never launch or attach without Developer Mode: macOS would prompt for an admin password.
          if (!spec.port && !(yield* Effect.promise(Lldb.developerMode)))
            return yield* new DebugError({ kind: "unavailable", message: Lldb.DEVELOPER_MODE_OFF })
          // Building (rust-test) runs project code, so it happens here: after approval, never in prepare().
          const built = spec.build ? yield* Effect.promise(() => Lldb.testBinary(spec.build!)) : undefined
          if (built && "error" in built) return yield* new DebugError({ kind: "invalid", message: built.error })
          const cwd = typeof spec.arguments.cwd === "string" ? spec.arguments.cwd : directory
          const formatters = spec.rust ? yield* Effect.promise(() => Lldb.rust(cwd)) : undefined
          const existing = Array.isArray(spec.arguments.initCommands) ? spec.arguments.initCommands : []
          const args = {
            ...spec.arguments,
            ...(built ? { program: built.program } : {}),
            ...(formatters ? { initCommands: [...existing, ...formatters] } : {}),
          }
          const notes = [
            ...(built?.notes ?? []),
            ...(spec.rust && !formatters
              ? ["rustc's LLDB formatters were not found; Rust values show raw fields"]
              : []),
          ]
          const program = built?.program
          if (spec.port) return { connection: { port: spec.port }, arguments: args, notes, program }
          const found = yield* Effect.promise(Lldb.resolve)
          if ("error" in found) return yield* new DebugError({ kind: "unavailable", message: found.error })
          return { connection: { command: Lldb.command(found.binary) }, arguments: args, notes, program }
        }
        if (spec.port) return { connection: { port: spec.port }, arguments: spec.arguments }
        const python = yield* Effect.promise(() =>
          Debugpy.resolve({ directory, ...(spec.python ? { python: spec.python } : {}) }),
        )
        if ("error" in python) return yield* new DebugError({ kind: "unavailable", message: python.error })
        const args = spec.arguments
        // The python-test preset falls back to unittest when pytest is not installed.
        const test = args.module === "pytest" && !python.pytest ? { module: "unittest" } : {}
        return {
          connection: { command: python.command, env: python.env },
          arguments: {
            ...args,
            ...test,
            ...(args.request === "launch" && !args.python ? { python: [python.python] } : {}),
          },
        }
      })

    // runInTerminal: the program runs in an opencode PTY, so output written before a crash survives.
    const terminal = (directory: string) => (args: DapClient.Body, output: (chunk: string) => void) => {
      const command = Array.isArray(args.args) ? args.args.map(String) : []
      const env = Object.fromEntries(
        Object.entries((args.env ?? {}) as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
      return Effect.runPromise(
        Effect.gen(function* () {
          if (!command[0]) return yield* Effect.die(new Error("runInTerminal without a command"))
          const pty = yield* Pty.Service
          const info = yield* pty.create({
            command: command[0],
            args: command.slice(1),
            cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : directory,
            env,
            title: typeof args.title === "string" ? args.title : "Debug",
          })
          const attachment = yield* pty.attach(info.id, { onData: output, onEnd: () => {} })
          attachment.activate()
          return { processId: info.pid }
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })))),
      )
    }

    const start = Effect.fn("WorkbenchDebug.start")(function* (
      spec: DebugLaunch.Spec,
      actor: Actor,
      options: StartOptions = {},
    ) {
      const data = yield* InstanceState.get(state)
      const running = [...data.sessions.values()].filter(live)
      if (running.length >= MAX_SESSIONS)
        return yield* new DebugError({
          kind: "limit",
          message: `${MAX_SESSIONS} debug sessions are already running in this project (${running
            .map((entry) => entry.session.id)
            .join(", ")}); stop one first`,
        })
      const target = yield* connect(spec, data.ctx.directory)
      const instance = yield* InstanceRef
      const workspace = yield* WorkspaceRef
      const publish = <A>(effect: Effect.Effect<A>) =>
        void Effect.runFork(
          effect.pipe(Effect.provideService(InstanceRef, instance), Effect.provideService(WorkspaceRef, workspace)),
        )
      const id = Workbench.DebugSessionID.create()
      const session = DebugSession.make({
        id,
        adapter: spec.adapter,
        program: target.program ?? spec.program,
        directory: data.ctx.directory,
        connection: target.connection,
        request: spec.request,
        arguments: target.arguments,
        breakpoints: spec.breakpoints,
        exceptions: spec.exceptions,
        ...(spec.functions ? { functions: spec.functions } : {}),
        actor,
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.investigationID ? { investigationID: options.investigationID } : {}),
        onUpdate: (info) => {
          publish(events.publish(Workbench.Event.DebugUpdated, { session: info }))
          if (options.observe && !data.closing) publish(options.observe(session))
        },
        onOutput: (rows) => publish(events.publish(Workbench.Event.DebugOutput, { sessionID: id, rows })),
        runInTerminal: terminal(data.ctx.directory),
      })
      data.sessions.set(id, { session, ...(actor.sessionID ? { agentSessionID: actor.sessionID } : {}) })
      for (const note of [...spec.notes, ...(target.notes ?? [])]) session.system(note)
      const ended = [...data.sessions.values()].filter((entry) => !live(entry) && entry.session !== session)
      for (const entry of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) data.sessions.delete(entry.session.id)
      // Cancelling the agent session cancels its background jobs; this job ends the debug session with it.
      if (actor.by === "agent" && actor.sessionID)
        yield* background.start({
          type: "debug",
          title: `debug ${spec.name}`,
          metadata: { sessionId: actor.sessionID, debugSessionID: id },
          run: Effect.promise(() => session.done).pipe(
            Effect.as(`debug session ${id} ended`),
            Effect.onInterrupt(() =>
              session.owner === "human" ? Effect.void : session.terminate("the agent session was cancelled"),
            ),
          ),
        })
      const result = yield* session.start
      return { session, result }
    })

    const abort = Effect.fn("WorkbenchDebug.abort")(function* (agentSessionID: string, reason: string) {
      const data = yield* InstanceState.get(state)
      yield* Effect.forEach(
        [...data.sessions.values()].filter(
          (entry) => entry.agentSessionID === agentSessionID && live(entry) && entry.session.owner !== "human",
        ),
        (entry) => entry.session.terminate(reason),
        { concurrency: "unbounded", discard: true },
      )
    })

    const list = Effect.fn("WorkbenchDebug.list")(function* () {
      return [...(yield* InstanceState.get(state)).sessions.values()].map((entry) => entry.session.info())
    })

    const current = Effect.fn("WorkbenchDebug.current")(function* (agentSessionID: string) {
      const entries = [...(yield* InstanceState.get(state)).sessions.values()].filter(live)
      return (entries.findLast((entry) => entry.agentSessionID === agentSessionID) ?? entries.at(-1))?.session
    })

    return Service.of({ list, get, current, prepare, prepareAttach, start, abort })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, BackgroundJob.node, locationServiceMapNode],
})

export * as WorkbenchDebug from "./service"
