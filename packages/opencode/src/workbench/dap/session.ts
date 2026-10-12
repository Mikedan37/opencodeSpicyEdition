// One debug session: adapter process, DAP client, state machine
// (starting → running ⇄ stopped → terminated | failed), capability gating, limits,
// ownership-checked commands and process-tree cleanup.
import { Effect, Fiber, Option } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { Process } from "@/util/process"
import { DapClient, DebugError } from "./client"
import { DebugConsole } from "./console"
import { DebugControl, type Actor } from "./control"
import { DebugSnapshot } from "./snapshot"
import { DapTransport } from "./transport"

export type State = Workbench.DebugSessionInfo["state"]
export type { Actor }

export const LIMITS = {
  wallClockMs: 10 * 60_000,
  stepWaitMs: 30_000,
  maxSteps: 200,
  outputBytes: 256 * 1024,
  initializeMs: 10_000,
  launchMs: 30_000,
  shutdownMs: 1_000,
}
export type Limits = typeof LIMITS

export type BreakpointSpec = {
  readonly line: number
  readonly condition?: string
  readonly hitCondition?: string
  readonly logMessage?: string
}

export type BreakpointsInput = {
  // Replaces every breakpoint in this file.
  readonly file?: string
  readonly breakpoints?: readonly BreakpointSpec[]
  readonly functions?: readonly string[]
  readonly exceptions?: readonly string[]
  // Data breakpoints (watchpoints) on variables of the current frame.
  readonly data?: readonly string[]
}

export type BreakpointsResult = {
  readonly file?: string
  readonly breakpoints: { line: number; verified: boolean; message?: string }[]
  readonly functions?: { name: string; verified: boolean; message?: string }[]
  readonly exceptions?: readonly string[]
  readonly data?: { name: string; verified: boolean; message?: string }[]
}

export type Connection =
  | { readonly command: readonly string[]; readonly env?: Record<string, string>; readonly cwd?: string }
  | { readonly port: number }

export type Options = {
  readonly id: Workbench.DebugSessionID
  readonly adapter: string
  readonly program?: string
  readonly directory: string
  readonly connection: Connection
  readonly request: "launch" | "attach"
  readonly arguments: Record<string, unknown>
  readonly breakpoints?: readonly (BreakpointSpec & { readonly file: string })[]
  readonly functions?: readonly string[]
  readonly exceptions?: readonly string[]
  readonly actor: Actor
  readonly limits?: Partial<Limits>
  readonly onUpdate: (info: Workbench.DebugSessionInfo) => void
  readonly onOutput: (rows: Workbench.ConsoleRow[]) => void
  // runInTerminal reverse request; the service backs it with the PTY service.
  readonly runInTerminal?: (args: DapClient.Body, output: (chunk: string) => void) => Promise<{ processId?: number }>
}

export type Outcome =
  | { readonly kind: "stopped"; readonly snapshot: Workbench.StopSnapshot }
  | { readonly kind: "terminated"; readonly exitCode?: number }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "owner" }

export type Result = {
  readonly info: Workbench.DebugSessionInfo
  readonly outcome: "stopped" | "running" | "terminated" | "failed"
  readonly note?: string
  readonly exitCode?: number
}

export type Process = { readonly pid: number; readonly command: string; readonly startedAt?: string }

// Requests an adapter only accepts when it reported the capability. Checked before sending.
const REQUIRES: Record<string, string> = {
  configurationDone: "supportsConfigurationDoneRequest",
  setFunctionBreakpoints: "supportsFunctionBreakpoints",
  dataBreakpointInfo: "supportsDataBreakpoints",
  setDataBreakpoints: "supportsDataBreakpoints",
  setInstructionBreakpoints: "supportsInstructionBreakpoints",
  setExpression: "supportsSetExpression",
  setVariable: "supportsSetVariable",
  completions: "supportsCompletionsRequest",
  exceptionInfo: "supportsExceptionInfoRequest",
  terminate: "supportsTerminateRequest",
  cancel: "supportsCancelRequest",
  restart: "supportsRestartRequest",
  stepBack: "supportsStepBack",
  reverseContinue: "supportsStepBack",
  gotoTargets: "supportsGotoTargetsRequest",
  stepInTargets: "supportsStepInTargetsRequest",
  modules: "supportsModulesRequest",
  loadedSources: "supportsLoadedSourcesRequest",
  breakpointLocations: "supportsBreakpointLocationsRequest",
  disassemble: "supportsDisassembleRequest",
  readMemory: "supportsReadMemoryRequest",
}

export function make(options: Options) {
  const limits = { ...LIMITS, ...options.limits }
  const startedAt = Date.now()
  const s = {
    state: "starting" as State,
    capabilities: {} as DapClient.Body,
    stop: undefined as Workbench.StopSnapshot | undefined,
    error: undefined as string | undefined,
    exitCode: undefined as number | undefined,
    threadID: undefined as number | undefined,
    frameID: undefined as number | undefined,
    stopSeq: 0,
    steps: 0,
    stderr: "",
    investigationID: undefined as Workbench.InvestigationID | undefined,
    processes: [] as Process[],
  }
  const holder: { client?: DapClient.Client; shutdown?: Promise<void> } = {}
  const waiters = new Set<(outcome: Outcome) => void>()
  const initialized = defer<void>()
  const done = defer<void>()

  const info = (): Workbench.DebugSessionInfo => ({
    id: options.id,
    adapter: options.adapter,
    ...(options.program ? { program: options.program } : {}),
    state: s.state,
    owner: control.owner,
    ...(s.state === "stopped" && s.stop ? { stop: s.stop } : {}),
    capabilities: Object.entries(s.capabilities)
      .filter((entry) => entry[1] === true)
      .map((entry) => entry[0]),
    ...(s.investigationID ? { investigationID: s.investigationID } : {}),
    ...(s.error ? { error: s.error } : {}),
    startedAt,
  })
  const update = () => options.onUpdate(info())
  const terminal = () => s.state === "terminated" || s.state === "failed"

  const con = DebugConsole.make({ publish: options.onOutput, bytes: limits.outputBytes })
  const control = DebugControl.make({
    owner: options.actor.by,
    onChange: (change) => {
      con.system(`owner ${change.from} → ${change.to}${change.by === "system" ? "" : ` (by ${change.by})`}`)
      // A waiting command returns early when someone else takes control; teardown settles on its own.
      if (change.by !== "system") settle({ kind: "owner" })
      update()
    },
  })

  const settle = (outcome: Outcome) => {
    for (const resolve of [...waiters]) resolve(outcome)
    waiters.clear()
  }
  // Register before sending a command, so a stop that races the response is not missed.
  const expect = () => {
    const outcome = defer<Outcome>()
    waiters.add(outcome.resolve)
    return { promise: outcome.promise, cancel: () => waiters.delete(outcome.resolve) }
  }
  const await_ = (waiting: ReturnType<typeof expect>, ms: number) =>
    Effect.promise(() => waiting.promise).pipe(
      Effect.timeoutOption(ms),
      Effect.map(Option.getOrUndefined),
      Effect.ensuring(Effect.sync(waiting.cancel)),
    )

  const request = <T = DapClient.Body>(command: string, args?: object, timeout?: number) => {
    if (command === "writeMemory")
      return Effect.fail(
        new DebugError({ kind: "unsupported", message: "writing program memory is denied (debug.memory)" }),
      )
    const capability = REQUIRES[command]
    if (capability && s.capabilities[capability] !== true)
      return Effect.fail(
        new DebugError({
          kind: "unsupported",
          message: `${options.adapter} does not support ${command} (it does not report ${capability})`,
        }),
      )
    if (!holder.client)
      return Effect.fail(new DebugError({ kind: "invalid", message: "the debug adapter is not connected" }))
    return holder.client.request<T>(command, args, timeout)
  }

  const record = (pid: number, command: string) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || s.processes.some((item) => item.pid === pid)) return
    const entry = { pid, command }
    s.processes.push(entry)
    void startTime(pid).then((value) => {
      if (value) Object.assign(entry, { startedAt: value })
    })
  }

  const onStopped = (body: DapClient.Body) => {
    if (terminal()) return
    s.state = "stopped"
    if (typeof body.threadId === "number") s.threadID = body.threadId
    const seq = ++s.stopSeq
    const reason = typeof body.reason === "string" ? body.reason : "pause"
    const text =
      typeof body.text === "string" ? body.text : typeof body.description === "string" ? body.description : undefined
    const description = text?.replace(/\s+/g, " ")
    Effect.runFork(
      DebugSnapshot.build(request, {
        threadID: s.threadID,
        reason,
        description,
        exceptionInfo: s.capabilities.supportsExceptionInfoRequest === true,
      }).pipe(
        Effect.orElseSucceed(
          (): Workbench.StopSnapshot => ({
            reason,
            ...(description ? { description } : {}),
            threadID: s.threadID ?? 0,
            frames: [],
            locals: [],
            at: Date.now(),
          }),
        ),
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            if (seq !== s.stopSeq || terminal()) return
            s.stop = snapshot
            s.threadID = snapshot.threadID
            s.frameID = snapshot.frames[0]?.id
            const top = snapshot.frames[0]
            con.push({
              kind: snapshot.exception ? "exception" : "stop",
              by: "adapter",
              text: snapshot.exception
                ? [snapshot.exception.id, snapshot.exception.description].filter(Boolean).join(": ")
                : `${snapshot.reason}${top ? ` · ${top.name}()` : ""}`,
              ...(top?.file && top.line !== undefined ? { location: { file: top.file, line: top.line } } : {}),
            })
            update()
            settle({ kind: "stopped", snapshot })
          }),
        ),
      ),
    )
  }

  const onEvent = (event: string, body: DapClient.Body) => {
    if (event === "initialized") return initialized.resolve()
    if (event === "stopped") return onStopped(body)
    if (event === "output") return con.output(body)
    if (event === "process" && options.request === "launch")
      return record(Number(body.systemProcessId), String(body.name ?? "debuggee"))
    if (event === "exited") {
      s.exitCode = Number(body.exitCode)
      con.system(`program exited with code ${s.exitCode}`)
      return
    }
    if (event === "terminated") return void Effect.runFork(terminate("the program ended"))
    if (event === "continued" && !terminal()) {
      s.state = "running"
      s.stop = undefined
      update()
    }
  }

  const onRequest = async (command: string, args: DapClient.Body) => {
    if (command === "runInTerminal" && options.runInTerminal) {
      const result = await options.runInTerminal(args, con.terminal)
      if (result.processId) record(result.processId, `terminal: ${String(args.title ?? "program")}`)
      return result
    }
    if (command === "startDebugging") {
      con.system("the adapter asked for a child debug session (startDebugging); not supported yet")
      throw new Error("startDebugging (child debug sessions) is not supported by OpenCode yet")
    }
    throw new Error(`OpenCode does not support the ${command} reverse request`)
  }

  const open = (handlers: DapTransport.Handlers) => {
    const connection = options.connection
    if ("port" in connection) return DapTransport.tcp(connection.port, handlers)
    const child = Process.spawn([...connection.command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: connection.cwd ?? options.directory,
      env: connection.env,
    })
    if (child.pid) record(child.pid, connection.command.join(" "))
    child.stderr?.on("data", (chunk: Buffer) => {
      s.stderr = (s.stderr + chunk.toString()).slice(-2000)
    })
    child.exited.then(
      (code) => fail(`the debug adapter exited with code ${code}`),
      (error: unknown) => {
        // A spawn failure (ENOENT) can arrive after the closed pipes already failed the session.
        if (s.state === "failed") s.error = `${s.error}: ${String(error)}`
        fail(`the debug adapter could not start: ${String(error)}`)
      },
    )
    if (!child.stdout || !child.stdin) throw new Error("debug adapter stdio unavailable")
    return DapTransport.stream(child.stdout, child.stdin, handlers)
  }

  /** Marks the session failed (adapter crash, protocol error) and cleans up. Keeps everything recorded so far. */
  const fail = (reason: string) => {
    if (terminal() || holder.shutdown) return
    s.error = s.stderr.trim() ? `${reason}: ${s.stderr.trim().split("\n").slice(-3).join(" | ")}` : reason
    s.state = "failed"
    con.system(`debug session failed: ${s.error}`)
    void Effect.runPromise(terminate(reason))
  }

  const configure = (input: BreakpointsInput) =>
    Effect.gen(function* () {
      const specs = input.breakpoints ?? []
      const missing = [
        specs.some((item) => item.condition) &&
          !s.capabilities.supportsConditionalBreakpoints &&
          "conditional breakpoints",
        specs.some((item) => item.hitCondition) &&
          !s.capabilities.supportsHitConditionalBreakpoints &&
          "hit-count breakpoints",
        specs.some((item) => item.logMessage) && !s.capabilities.supportsLogPoints && "log points",
      ].filter((item): item is string => typeof item === "string")
      if (missing.length)
        return yield* new DebugError({
          kind: "unsupported",
          message: `${options.adapter} does not support ${missing.join(", ")}`,
        })
      const filters =
        (s.capabilities.exceptionBreakpointFilters as { filter: string }[] | undefined)?.map((item) => item.filter) ??
        []
      const unknown = (input.exceptions ?? []).filter((item) => !filters.includes(item))
      if (unknown.length)
        return yield* new DebugError({
          kind: "unsupported",
          message: `unknown exception filter ${unknown.join(", ")}; ${options.adapter} offers ${filters.join(", ") || "none"}`,
        })
      if (input.functions && !s.capabilities.supportsFunctionBreakpoints)
        return yield* new DebugError({
          kind: "unsupported",
          message: `${options.adapter} does not support function breakpoints`,
        })
      if (input.data && !s.capabilities.supportsDataBreakpoints)
        return yield* new DebugError({
          kind: "unsupported",
          message: `${options.adapter} does not support data breakpoints`,
        })

      const lines = input.file
        ? yield* request<{ breakpoints?: { line?: number; verified?: boolean; message?: string }[] }>(
            "setBreakpoints",
            {
              source: { path: input.file },
              breakpoints: specs.map((item) => ({
                line: item.line,
                ...(item.condition ? { condition: item.condition } : {}),
                ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
                ...(item.logMessage ? { logMessage: item.logMessage } : {}),
              })),
              lines: specs.map((item) => item.line),
            },
          ).pipe(
            Effect.map((body) =>
              specs.map((item, index) => {
                const reply = body.breakpoints?.[index]
                return {
                  line: reply?.line ?? item.line,
                  verified: reply?.verified === true,
                  ...(reply?.message ? { message: reply.message } : {}),
                }
              }),
            ),
          )
        : []
      const functions = input.functions
        ? yield* request<{ breakpoints?: { verified?: boolean; message?: string }[] }>("setFunctionBreakpoints", {
            breakpoints: input.functions.map((name) => ({ name })),
          }).pipe(
            Effect.map((body) =>
              (input.functions ?? []).map((name, index) => ({
                name,
                verified: body.breakpoints?.[index]?.verified === true,
                ...(body.breakpoints?.[index]?.message ? { message: body.breakpoints?.[index]?.message } : {}),
              })),
            ),
          )
        : undefined
      if (input.exceptions) yield* request("setExceptionBreakpoints", { filters: input.exceptions })
      const data = input.data ? yield* dataBreakpoints(input.data) : undefined
      return {
        ...(input.file ? { file: input.file } : {}),
        breakpoints: lines,
        ...(functions ? { functions } : {}),
        ...(input.exceptions ? { exceptions: input.exceptions } : {}),
        ...(data ? { data } : {}),
      } satisfies BreakpointsResult
    })

  const dataBreakpoints = (names: readonly string[]) =>
    Effect.gen(function* () {
      const infos = yield* Effect.forEach(names, (name) =>
        request<{ dataId?: string | null; description?: string }>("dataBreakpointInfo", {
          name,
          ...(s.frameID !== undefined ? { frameId: s.frameID } : {}),
        }).pipe(Effect.map((body) => ({ name, dataId: body.dataId ?? undefined, message: body.description }))),
      )
      const valid = infos.filter((item) => item.dataId)
      const body = yield* request<{ breakpoints?: { verified?: boolean; message?: string }[] }>("setDataBreakpoints", {
        breakpoints: valid.map((item) => ({ dataId: item.dataId, accessType: "write" })),
      })
      return infos.map((item) => {
        const index = valid.indexOf(item)
        return {
          name: item.name,
          verified: index >= 0 && body.breakpoints?.[index]?.verified === true,
          ...(item.message ? { message: item.message } : {}),
        }
      })
    })

  const result = (outcome: Outcome | undefined, note?: string): Result => {
    const base = { info: info(), ...(note ? { note } : {}) }
    if (!outcome || outcome.kind === "owner")
      return {
        ...base,
        outcome:
          s.state === "stopped" ? "stopped" : terminal() ? (s.state === "failed" ? "failed" : "terminated") : "running",
        ...(outcome?.kind === "owner" ? { note: `control moved to the ${control.owner}; the program kept going` } : {}),
      }
    if (outcome.kind === "stopped") return { ...base, outcome: "stopped" }
    if (outcome.kind === "failed") return { ...base, outcome: "failed", note: outcome.error }
    return { ...base, outcome: "terminated", ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}) }
  }

  /** Waits for the next stop or exit. With nothing after the step wait, pauses so the caller sees where it is. */
  const settleAfter = (waiting: ReturnType<typeof expect>) =>
    Effect.gen(function* () {
      const first = yield* await_(waiting, limits.stepWaitMs)
      if (first || terminal() || s.state === "stopped") return result(first)
      const again = expect()
      const threadID =
        s.threadID ??
        (yield* request<{ threads?: { id: number }[] }>("threads").pipe(Effect.orElseSucceed(() => ({ threads: [] }))))
          .threads?.[0]?.id
      yield* request("pause", { threadId: threadID ?? 1 }).pipe(Effect.ignore)
      const paused = yield* await_(again, 5_000)
      return result(paused, `no stop within ${Math.round(limits.stepWaitMs / 1000)} s; paused the program`)
    })

  const start = Effect.gen(function* () {
    holder.client = yield* DapClient.make({ open, onEvent, onRequest, onClose: fail })
    s.capabilities = yield* request("initialize", initialize(options.adapter), limits.initializeMs)
    update()
    const launch = yield* Effect.forkChild(request(options.request, options.arguments, limits.launchMs))
    const ready = Effect.promise(() => initialized.promise).pipe(
      Effect.timeoutOrElse({
        duration: limits.initializeMs,
        orElse: () => Effect.fail(new DebugError({ kind: "timeout", message: "the adapter never sent initialized" })),
      }),
    )
    // Some adapters (debugpy) answer launch only after configurationDone; a failed launch must not wait for that.
    yield* Effect.raceFirst(ready, Fiber.join(launch).pipe(Effect.andThen(ready)))
    const files = Map.groupBy(options.breakpoints ?? [], (item) => item.file)
    yield* Effect.forEach([...files], ([file, breakpoints]) => configure({ file, breakpoints }), { discard: true })
    if (options.functions?.length) yield* configure({ functions: options.functions })
    yield* configure({ exceptions: options.exceptions ?? [] })
    const waiting = expect()
    if (s.capabilities.supportsConfigurationDoneRequest) yield* request("configurationDone")
    yield* Fiber.join(launch)
    if (s.state === "starting") s.state = "running"
    con.system(`${options.adapter} session started · ${options.request} ${options.program ?? ""}`.trim())
    update()
    // The agent waits for the first stop; a human start returns at once and follows events.
    if (options.actor.by === "agent") return yield* settleAfter(waiting)
    waiting.cancel()
    return result(undefined)
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (!terminal()) {
          s.state = "failed"
          s.error = error.message
        }
        yield* terminate(error.message)
        // A crash reported by the process (with its stderr) explains more than the request that noticed it.
        return yield* new DebugError({ kind: error.kind, message: s.error ?? error.message })
      }),
    ),
    Effect.onInterrupt(() => terminate("start was interrupted")),
  )

  const requireState = (...states: State[]) =>
    Effect.suspend(() =>
      states.includes(s.state)
        ? Effect.void
        : Effect.fail(
            new DebugError({
              kind: "invalid",
              message: `the program is ${s.state}; this needs it ${states.join(" or ")}`,
            }),
          ),
    )

  const control_ = (
    action: "continue" | "pause" | "next" | "stepIn" | "stepOut",
    actor: Actor,
    wait = actor.by === "agent",
  ) =>
    control.run(
      actor,
      "control",
      Effect.gen(function* () {
        if (action === "pause") {
          yield* requireState("running")
          const waiting = expect()
          yield* request("pause", { threadId: s.threadID ?? 1 })
          if (!wait) {
            waiting.cancel()
            return result(undefined)
          }
          return result(yield* await_(waiting, 5_000))
        }
        yield* requireState("stopped")
        if (actor.by === "agent" && s.steps >= limits.maxSteps)
          return yield* new DebugError({
            kind: "limit",
            message: `the step budget of ${limits.maxSteps} is used up; the program stays paused for the user`,
          })
        if (actor.by === "agent") s.steps++
        const waiting = expect()
        const seq = s.stopSeq
        yield* request(action, { threadId: s.threadID ?? 1 })
        // Unless the next stop already arrived, the program is running again.
        if (s.state === "stopped" && s.stopSeq === seq) {
          s.state = "running"
          s.stop = undefined
          update()
        }
        if (!wait) {
          waiting.cancel()
          return result(undefined)
        }
        return yield* settleAfter(waiting)
      }),
    )

  const read = <A, E>(actor: Actor, effect: Effect.Effect<A, E>) =>
    control.run(actor, "read", requireState("stopped").pipe(Effect.andThen(effect)))

  /** Ends the session: disconnect with terminateDebuggee, then kill the whole recorded process tree. */
  const terminate = (reason: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (holder.shutdown) return Effect.promise(() => holder.shutdown!)
      holder.shutdown = Effect.runPromise(
        Effect.gen(function* () {
          clearTimeout(wallClock)
          control.change("terminating", "system")
          // Collect descendants before anything exits: orphans are re-parented and pgrep -P loses them.
          // Attached programs are never recorded, so only the adapter's own tree goes for attach.
          const pids = yield* Effect.promise(() => tree(s.processes.map((item) => item.pid)))
          if (holder.client)
            yield* request(
              "disconnect",
              { terminateDebuggee: options.request === "launch", restart: false },
              limits.shutdownMs,
            ).pipe(Effect.ignore)
          holder.client?.close()
          yield* Effect.promise(() => kill(pids))
          if (s.state !== "failed") s.state = "terminated"
          s.stop = undefined
          con.system(`debug session ended: ${reason}`)
          control.change("idle", "system")
          con.flush()
          update()
          settle(
            s.state === "failed"
              ? { kind: "failed", error: s.error ?? reason }
              : { kind: "terminated", exitCode: s.exitCode },
          )
          done.resolve()
        }),
      )
      return Effect.promise(() => holder.shutdown!)
    })

  const wallClock = setTimeout(() => {
    if (control.owner === "human") return
    void Effect.runPromise(terminate(`wall-clock limit of ${Math.round(limits.wallClockMs / 60_000)} minutes reached`))
  }, limits.wallClockMs)
  wallClock.unref?.()

  return {
    id: options.id,
    adapter: options.adapter,
    options,
    info,
    start,
    request,
    done: done.promise,
    get owner() {
      return control.owner
    },
    get steps() {
      return s.steps
    },
    get processes() {
      return s.processes as readonly Process[]
    },
    get frameID() {
      return s.frameID
    },
    link: (investigationID: Workbench.InvestigationID | undefined) => {
      s.investigationID = investigationID
      update()
    },
    control: control_,
    breakpoints: (input: BreakpointsInput, actor: Actor) =>
      control.run(actor, "control", requireState("running", "stopped").pipe(Effect.andThen(configure(input)))),
    variables: (ref: number, actor: Actor, start = 0) => read(actor, DebugSnapshot.variables(request, ref, start)),
    inspect: (input: { path?: string; ref?: number; frameID?: number; start?: number }, actor: Actor) =>
      read(actor, inspect(input)),
    evaluate: (input: { expression: string; frameID?: number }, actor: Actor) =>
      // Humans may evaluate whoever drives; the agent needs control.
      control.run(
        actor,
        actor.by === "human" ? "read" : "control",
        requireState("stopped").pipe(
          Effect.andThen(
            DebugConsole.evaluate({
              request,
              console: con,
              adapter: options.adapter,
              expression: input.expression,
              frameID: input.frameID ?? s.frameID,
              by: actor.by,
            }),
          ),
        ),
      ),
    completions: (input: { text: string; column?: number; frameID?: number }, actor: Actor) =>
      read(actor, DebugConsole.completions({ request, ...input, frameID: input.frameID ?? s.frameID })),
    output: (after?: number) => con.list(after),
    system: con.system,
    setOwner: (to: "idle" | "agent" | "human", actor: Actor) => control.set(to, actor).pipe(Effect.map(info)),
    stop: (actor: Actor) =>
      control.check(actor, "stop").pipe(Effect.andThen(terminate(`stopped by the ${actor.by}`)), Effect.map(info)),
    terminate,
  }

  function inspect(input: {
    path?: string
    ref?: number
    frameID?: number
    start?: number
  }): Effect.Effect<DebugSnapshot.Tree[], DebugError> {
    return Effect.gen(function* () {
      if (input.ref !== undefined)
        return yield* DebugSnapshot.tree(request, input.ref, DebugSnapshot.LIMITS.depth, input.start)
      const frameID = input.frameID ?? s.frameID
      if (frameID === undefined) return []
      const scopes =
        (yield* request<{ scopes?: { variablesReference: number; expensive?: boolean }[] }>("scopes", {
          frameId: frameID,
        })).scopes ?? []
      const roots = (yield* Effect.forEach(
        scopes.filter((item) => !item.expensive && item.variablesReference > 0),
        (scope) => DebugSnapshot.variables(request, scope.variablesReference),
      )).flat()
      if (!input.path)
        return yield* Effect.forEach(roots.slice(0, DebugSnapshot.LIMITS.children), (item, index) =>
          item.variablesReference > 0 && index < DebugSnapshot.LIMITS.expand
            ? DebugSnapshot.tree(request, item.variablesReference, 1).pipe(
                Effect.map((children): DebugSnapshot.Tree => ({ ...item, children })),
              )
            : Effect.succeed<DebugSnapshot.Tree>(item),
        )
      const segments = input.path.split(".").filter(Boolean)
      let found = match(roots, segments[0])
      for (const segment of segments.slice(1)) {
        found =
          found && found.variablesReference > 0
            ? match(yield* DebugSnapshot.variables(request, found.variablesReference), segment)
            : undefined
      }
      if (!found)
        return yield* new DebugError({ kind: "not_found", message: `no variable ${input.path} in this frame` })
      if (found.variablesReference === 0) return [found]
      const children = yield* DebugSnapshot.tree(
        request,
        found.variablesReference,
        DebugSnapshot.LIMITS.depth,
        input.start,
      )
      return [{ ...found, children }]
    })
  }
}

export type Session = ReturnType<typeof make>

function match(items: readonly DebugSnapshot.View[], segment: string | undefined) {
  if (segment === undefined) return undefined
  return items.find((item) => [segment, `'${segment}'`, `"${segment}"`, `[${segment}]`].includes(item.name))
}

function initialize(adapter: string) {
  return {
    clientID: "opencode",
    clientName: "OpenCode",
    adapterID: adapter,
    pathFormat: "path",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsRunInTerminalRequest: true,
    supportsStartDebuggingRequest: false,
    supportsProgressReporting: false,
    supportsInvalidatedEvent: false,
    supportsMemoryReferences: false,
    locale: "en",
  }
}

function defer<T>() {
  const box = {} as { resolve: (value: T) => void; promise: Promise<T> }
  box.promise = new Promise<T>((resolve) => {
    box.resolve = resolve
  })
  return box
}

/** Every listed pid plus all of its descendants (pgrep -P, breadth first). */
export async function tree(roots: readonly number[]) {
  if (process.platform === "win32") return [...roots]
  const pids = [...new Set(roots)]
  for (let index = 0; index < pids.length; index++) {
    const children = await Process.lines(["pgrep", "-P", String(pids[index])], { nothrow: true }).catch(() => [])
    for (const child of children.map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0)) {
      if (!pids.includes(child)) pids.push(child)
    }
  }
  return pids
}

/** SIGTERM, a short grace period, then SIGKILL for anything still alive. */
export async function kill(pids: readonly number[]) {
  const signal = (pid: number, name: NodeJS.Signals | 0) => {
    try {
      process.kill(pid, name)
      return true
    } catch {
      return false
    }
  }
  const alive = pids.filter((pid) => signal(pid, "SIGTERM"))
  for (let attempt = 0; attempt < 10 && alive.some((pid) => signal(pid, 0)); attempt++) await Bun.sleep(50)
  for (const pid of alive) signal(pid, "SIGKILL")
}

/** Process start time as ps prints it; recovery kills a recorded pid only when this still matches. */
export async function startTime(pid: number) {
  const out = await Process.text(["ps", "-o", "lstart=", "-p", String(pid)], { nothrow: true }).catch(() => undefined)
  return out?.code === 0 ? out.text.trim() || undefined : undefined
}

export * as DebugSession from "./session"
