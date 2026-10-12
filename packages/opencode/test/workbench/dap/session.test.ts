// Contract tests for the DAP core against the scripted fake adapter (no real debugger).
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Fiber } from "effect"
import { Workbench } from "@opencode-ai/schema/workbench"
import { DapTransport } from "../../../src/workbench/dap/transport"
import { DebugSession } from "../../../src/workbench/dap/session"
import { it, pollWithTimeout } from "../../lib/effect"
import { profiles } from "../fixture/dap-profiles"
import type { Script } from "../fixture/fake-dap"

const FAKE = path.join(import.meta.dir, "../fixture/fake-dap.ts")
const agent = { by: "agent" as const, sessionID: "ses_test" }
const human = { by: "human" as const }

const stop = (
  line: number,
  locals: { name: string; value: string; type?: string; variablesReference?: number }[] = [],
) => ({
  reason: "breakpoint",
  line,
  name: "average",
  file: "/work/app.py",
  locals,
})

function fake(script: Script, options: Partial<DebugSession.Options> = {}) {
  const rows: Workbench.ConsoleRow[] = []
  const updates: Workbench.DebugSessionInfo[] = []
  const session = DebugSession.make({
    id: Workbench.DebugSessionID.create(),
    adapter: script.profile,
    program: "/work/app.py",
    directory: os.tmpdir(),
    connection: { command: [process.execPath, FAKE, JSON.stringify(script)] },
    request: "launch",
    arguments: { program: "/work/app.py" },
    actor: agent,
    limits: { stepWaitMs: 1_500, initializeMs: 1_500 },
    onUpdate: (info) => updates.push(info),
    onOutput: (items) => rows.push(...items),
    ...options,
  })
  return { session, rows, updates }
}

const using = <A, E>(
  script: Script,
  body: (input: ReturnType<typeof fake>) => Effect.Effect<A, E>,
  options?: Partial<DebugSession.Options>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fake(script, options)),
    body,
    (input) => input.session.terminate("test finished"),
  )

async function logged(file: string) {
  const text = await Bun.file(file)
    .text()
    .catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { command?: string; response?: string })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-dap-"))
}

describe("DAP-01 framing", () => {
  test("split, merged and multibyte frames decode by byte length", () => {
    const messages: DapTransport.Message[] = []
    const decode = DapTransport.decoder({
      onMessage: (message) => messages.push(message),
      onError: (error) => {
        throw error
      },
    })
    const first = DapTransport.encode({ seq: 1, type: "event", event: "output", body: { output: "héllo 🐍 世界\n" } })
    const second = DapTransport.encode({ seq: 2, type: "response", request_seq: 9, command: "next", success: true })
    const both = Buffer.concat([first, second])
    for (const byte of both) decode(Uint8Array.of(byte))
    decode(both)
    const middle = first.indexOf(Buffer.from("🐍")) + 2
    decode(first.subarray(0, middle))
    decode(first.subarray(middle))
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 1, 2, 1])
    expect((messages[4].body as { output: string }).output).toBe("héllo 🐍 世界\n")
    expect(first.length - first.indexOf("\r\n\r\n") - 4).toBe(
      Buffer.byteLength(
        JSON.stringify({ seq: 1, type: "event", event: "output", body: { output: "héllo 🐍 世界\n" } }),
      ),
    )
  })

  test("a malformed body is a protocol error and nothing after it is decoded", () => {
    const messages: DapTransport.Message[] = []
    const errors: Error[] = []
    const decode = DapTransport.decoder({
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
    })
    decode(
      Buffer.concat([
        Buffer.from("Content-Length: 7\r\n\r\n{nope!}"),
        DapTransport.encode({ seq: 1, type: "event", event: "x" }),
      ]),
    )
    expect(errors.map((error) => error.message)).toEqual(["DAP protocol error: malformed message body"])
    expect(messages).toEqual([])
    decode(Buffer.from("Content-Type: text\r\n\r\n"))
    expect(errors).toHaveLength(1)
  })
})

describe("DAP contract (fake adapter)", () => {
  for (const name of ["debugpy", "lldb-dap"] as const) {
    it.live(`DAP-02 initialize stores the ${name} capability profile`, () =>
      using({ profile: name, stops: [stop(3)] }, (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          expect(input.session.info().capabilities.toSorted()).toEqual(profiles[name].capabilities.toSorted())
        }),
      ),
    )
  }

  it.live("DAP-03 launch answered after configurationDone does not deadlock", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(tmp)
      const log = path.join(dir, "log.jsonl")
      yield* using(
        { profile: "debugpy", log, stops: [stop(3, [{ name: "xs", value: "[]", type: "list" }])] },
        (input) =>
          Effect.gen(function* () {
            const result = yield* input.session.start
            expect(result.outcome).toBe("stopped")
            expect(result.info.stop?.frames[0]).toMatchObject({ name: "average", line: 3 })
            expect(result.info.stop?.locals).toEqual([{ name: "xs", type: "list", value: "[]", variablesReference: 0 }])
            const commands = (yield* Effect.promise(() => logged(log))).map((entry) => entry.command).filter(Boolean)
            expect(commands.slice(0, 4)).toEqual([
              "initialize",
              "launch",
              "setExceptionBreakpoints",
              "configurationDone",
            ])
          }),
        { breakpoints: [] },
      )
    }),
  )

  it.live("DAP-04 unsupported requests are refused before anything is sent", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(tmp)
      const lldbLog = path.join(dir, "lldb.jsonl")
      yield* using({ profile: "lldb-dap", log: lldbLog, stops: [stop(3)] }, (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          const set = yield* input.session.request("setExpression", { expression: "x", value: "1" }).pipe(Effect.flip)
          expect(set.kind).toBe("unsupported")
          expect(set.message).toContain("supportsSetExpression")
          // SEC-02: lldb-dap supports writeMemory, but it is never sent.
          const write = yield* input.session
            .request("writeMemory", { memoryReference: "0x0", data: "AA==" })
            .pipe(Effect.flip)
          expect(write.message).toContain("debug.memory")
        }),
      )
      const pyLog = path.join(dir, "py.jsonl")
      yield* using({ profile: "debugpy", log: pyLog, stops: [stop(3)] }, (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          const data = yield* input.session.breakpoints({ data: ["xs"] }, agent).pipe(Effect.flip)
          expect(data.kind).toBe("unsupported")
          expect(data.message).toContain("data breakpoints")
          const filter = yield* input.session.breakpoints({ exceptions: ["cpp_throw"] }, agent).pipe(Effect.flip)
          expect(filter.message).toContain("raised, uncaught, userUnhandled")
        }),
      )
      const sent = [...(yield* Effect.promise(() => logged(lldbLog))), ...(yield* Effect.promise(() => logged(pyLog)))]
        .map((entry) => entry.command)
        .filter(Boolean)
      expect(sent).not.toContain("setExpression")
      expect(sent).not.toContain("writeMemory")
      expect(sent).not.toContain("dataBreakpointInfo")
      expect(sent).not.toContain("setDataBreakpoints")
      expect(sent.filter((command) => command === "setExceptionBreakpoints")).toHaveLength(2)
    }),
  )

  it.live("DAP-09 large structures: 50 children per page, 512 characters, 2 levels", () =>
    using(
      {
        profile: "debugpy",
        big: 120,
        stops: [stop(3, [{ name: "rows", value: "[...]", type: "list", variablesReference: 900 }])],
      },
      (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          const first = yield* input.session.variables(900, agent)
          expect(first).toHaveLength(50)
          expect(first.every((item) => item.value.length <= 512)).toBe(true)
          const second = yield* input.session.variables(900, agent, 50)
          expect(second[0].name).toBe("50")
          const tree = yield* input.session.inspect({ path: "rows" }, agent)
          expect(tree[0].children).toHaveLength(50)
          expect(tree[0].children?.[0].children).toHaveLength(50)
          expect(tree[0].children?.[0].children?.[0].children).toBeUndefined()
        }),
    ),
  )

  it.live("DAP-10 adapter killed mid-step: failed, evidence kept, no hang", () =>
    using({ profile: "debugpy", crashOn: "next", stops: [stop(3, [{ name: "xs", value: "[]" }]), stop(4)] }, (input) =>
      Effect.gen(function* () {
        yield* input.session.start
        const exit = yield* input.session.control("next", agent).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        yield* pollWithTimeout(
          Effect.sync(() => (input.session.info().state === "failed" ? true : undefined)),
          "session never failed",
        )
        expect(input.session.info().error).toContain("debug adapter")
        expect(input.session.output().some((row) => row.kind === "stop")).toBe(true)
        expect(input.session.output().some((row) => row.text.includes("debug session failed"))).toBe(true)
      }),
    ),
  )

  it.live("DAP-11 adapter never answers initialize: timeout, process killed", () =>
    using({ profile: "debugpy", initialize: "hang" }, (input) =>
      Effect.gen(function* () {
        const error = yield* input.session.start.pipe(Effect.flip)
        expect(error.kind).toBe("timeout")
        expect(input.session.info().state).toBe("failed")
        const pid = input.session.processes[0]?.pid
        expect(pid).toBeGreaterThan(0)
        yield* pollWithTimeout(
          Effect.sync(() => (alive(pid!) ? undefined : true)),
          "adapter still alive",
        )
      }),
    ),
  )

  it.live("DAP-12 malformed message: protocol error shown, session closed", () =>
    using({ profile: "lldb-dap", malformedOn: "configurationDone" }, (input) =>
      Effect.gen(function* () {
        const error = yield* input.session.start.pipe(Effect.flip)
        expect(error.message).toContain("protocol error")
        expect(input.session.info().state).toBe("failed")
        expect(input.session.info().error).toContain("protocol error")
      }),
    ),
  )

  it.live("DAP-16 TCP adapter on 127.0.0.1", () =>
    Effect.gen(function* () {
      const proc = Bun.spawn(
        [process.execPath, FAKE, JSON.stringify({ profile: "lldb-dap", tcp: true, stops: [stop(7)] })],
        {
          stdout: "pipe",
        },
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill()))
      const reader = proc.stdout.getReader()
      const first = yield* Effect.promise(() => reader.read())
      const port = Number(/PORT (\d+)/.exec(new TextDecoder().decode(first.value))?.[1])
      expect(port).toBeGreaterThan(0)
      yield* using(
        { profile: "lldb-dap" },
        (input) =>
          Effect.gen(function* () {
            const result = yield* input.session.start
            expect(result.info.stop?.frames[0]?.line).toBe(7)
          }),
        { connection: { port } },
      )
    }),
  )

  it.live("Z-HANG: continue with no stop pauses after the step wait", () =>
    using({ profile: "debugpy", hangOn: ["continue"], stops: [stop(3)] }, (input) =>
      Effect.gen(function* () {
        yield* input.session.start
        const result = yield* input.session.control("continue", agent)
        expect(result.outcome).toBe("stopped")
        expect(result.note).toContain("paused")
        expect(result.info.stop?.reason).toBe("pause")
        expect(result.info.stop?.frames[0]?.name).toBe("spin")
      }),
    ),
  )

  it.live("output events: telemetry hidden, program output kept, secrets redacted", () =>
    using(
      {
        profile: "debugpy",
        stops: [stop(3)],
        output: [
          { category: "telemetry", output: "ptvsd" },
          { category: "stdout", output: "alice 15.0\n" },
          { category: "stderr", output: "token sk-live-abcdefghijklmnopqrstuvwx\n" },
        ],
      },
      (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          const rows = input.session.output().filter((row) => row.by === "program")
          expect(rows.map((row) => [row.kind, row.text])).toEqual([
            ["stdout", "alice 15.0\n"],
            ["stderr", "token [REDACTED]\n"],
          ])
          expect(input.session.output().some((row) => row.text.includes("ptvsd"))).toBe(false)
        }),
    ),
  )

  it.live("reverse requests are answered; startDebugging is refused clearly", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(tmp)
      const log = path.join(dir, "log.jsonl")
      yield* using(
        {
          profile: "debugpy",
          log,
          stops: [stop(3)],
          reverse: { command: "startDebugging", arguments: { request: "launch", configuration: {} } },
        },
        (input) =>
          Effect.gen(function* () {
            yield* input.session.start
            const entries = yield* pollWithTimeout(
              Effect.promise(() => logged(log)).pipe(
                Effect.map((items) => (items.some((item) => item.response === "startDebugging") ? items : undefined)),
              ),
              "no answer to startDebugging",
            )
            const answer = entries.find((item) => item.response === "startDebugging") as {
              success: boolean
              message: string
            }
            expect(answer.success).toBe(false)
            expect(answer.message).toContain("not supported")
          }),
      )
    }),
  )
})

describe("control ownership", () => {
  it.live("CTL-01 owner changes are logged in order", () =>
    using({ profile: "debugpy", stops: [stop(3), stop(4)] }, (input) =>
      Effect.gen(function* () {
        yield* input.session.start
        yield* input.session.setOwner("idle", agent)
        yield* input.session.control("next", agent)
        yield* input.session.setOwner("human", human)
        yield* input.session.setOwner("idle", human)
        yield* input.session.stop(human)
        const changes = input.session
          .output()
          .filter((row) => row.text.startsWith("owner "))
          .map((row) => row.text.replace(/ \(by .*\)$/, ""))
        expect(changes).toEqual([
          "owner agent → idle",
          "owner idle → agent",
          "owner agent → human",
          "owner human → idle",
          "owner idle → terminating",
          "owner terminating → idle",
        ])
      }),
    ),
  )

  it.live("CTL-02/03 while a human owns it, the agent may inspect but not drive", () =>
    using({ profile: "debugpy", stops: [stop(3, [{ name: "xs", value: "[]" }]), stop(4)] }, (input) =>
      Effect.gen(function* () {
        yield* input.session.start
        yield* input.session.setOwner("human", human)
        const refused = yield* input.session.control("continue", agent).pipe(Effect.flip)
        expect(refused.kind).toBe("not_owner")
        expect(refused.message).toContain("controlled by the human since")
        const evaluate = yield* input.session.evaluate({ expression: "xs" }, agent).pipe(Effect.flip)
        expect(evaluate.kind).toBe("not_owner")
        const take = yield* input.session.setOwner("agent", agent).pipe(Effect.flip)
        expect(take.message).toContain("cannot take control")
        expect((yield* input.session.variables(1000, agent)).map((item) => item.name)).toEqual(["xs"])
        expect((yield* input.session.inspect({}, agent)).map((item) => item.name)).toEqual(["xs"])
        // The human's own evaluation runs and is recorded.
        const row = yield* input.session.evaluate({ expression: "len(xs)" }, human)
        expect(row).toMatchObject({ kind: "result", by: "human", text: "<len(xs)>" })
      }),
    ),
  )

  it.live("CTL-04 take over during an agent step: the step returns, then the human owns it", () =>
    using({ profile: "debugpy", hangOn: ["continue"], stops: [stop(3)] }, (input) =>
      Effect.gen(function* () {
        yield* input.session.start
        const step = yield* input.session.control("continue", agent).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.sync(() => (input.session.info().state === "running" ? true : undefined)),
          "never ran",
        )
        yield* input.session.setOwner("human", human)
        const result = yield* Fiber.join(step)
        expect(result.outcome).toBe("running")
        expect(result.note).toContain("human")
        expect(input.session.owner).toBe("human")
        const paused = yield* input.session.control("pause", human, true)
        expect(paused.outcome).toBe("stopped")
        expect((yield* input.session.control("continue", agent).pipe(Effect.flip)).kind).toBe("not_owner")
      }),
    ),
  )

  it.live("CTL-05 concurrent commands run one at a time", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(tmp)
      const log = path.join(dir, "log.jsonl")
      yield* using({ profile: "debugpy", log, stops: [stop(3), stop(4), stop(5)] }, (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          const results = yield* Effect.all(
            [input.session.control("next", agent), input.session.control("next", agent)],
            { concurrency: "unbounded" },
          )
          expect(results.map((item) => item.info.stop?.frames[0]?.line).toSorted()).toEqual([4, 5])
          const commands = (yield* Effect.promise(() => logged(log))).map((entry) => entry.command).filter(Boolean)
          const steps = commands.flatMap((command, index) => (command === "next" ? [index] : []))
          expect(steps).toHaveLength(2)
          // The second step is only sent after the first stop was read.
          expect(commands.slice(steps[0], steps[1])).toContain("stackTrace")
        }),
      )
    }),
  )

  it.live("S5 step budget: the agent is refused after the limit, the program stays paused", () =>
    using(
      { profile: "debugpy", stops: [stop(3), stop(4), stop(5)] },
      (input) =>
        Effect.gen(function* () {
          yield* input.session.start
          yield* input.session.control("next", agent)
          yield* input.session.control("next", agent)
          const error = yield* input.session.control("next", agent).pipe(Effect.flip)
          expect(error.kind).toBe("limit")
          expect(input.session.info().state).toBe("stopped")
        }),
      { limits: { maxSteps: 2, stepWaitMs: 1_500 } },
    ),
  )
})
