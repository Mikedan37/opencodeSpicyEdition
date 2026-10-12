// Scripted fake debug adapter for contract tests. Speaks DAP over stdio, or over TCP on
// 127.0.0.1 when the script sets `tcp` (it prints "PORT <n>" on stdout first).
// Usage: bun fake-dap.ts '<json script>'
import { appendFileSync } from "fs"
import net from "net"
import { profiles } from "./dap-profiles"

type Variable = { name: string; value: string; type?: string; variablesReference?: number }
type Stop = {
  reason: string
  line?: number
  file?: string
  name?: string
  description?: string
  locals?: Variable[]
  exception?: { id: string; description: string }
}
export type Script = {
  profile: keyof typeof profiles
  initialize?: "ok" | "hang" | "crash"
  stops?: Stop[]
  // Commands that are acknowledged but never followed by a stop (an infinite loop in the program).
  hangOn?: string[]
  // Exit immediately when this command arrives (adapter killed mid-step).
  crashOn?: string
  // Answer this command with a frame whose body is not JSON.
  malformedOn?: string
  variables?: Record<string, Variable[]>
  // Reference 900 returns this many children with long values.
  big?: number
  output?: { category: string; output: string }[]
  reverse?: { command: string; arguments: object }
  exitCode?: number
  log?: string
  tcp?: boolean
}
type Request = { seq: number; type: "request"; command: string; arguments?: any }

const script: Script = JSON.parse(process.argv[2] ?? "{}")
const profile = profiles[script.profile ?? "debugpy"]
const capabilities = {
  ...Object.fromEntries(profile.capabilities.map((name) => [name, true])),
  supportsStepBack: false,
  exceptionBreakpointFilters: profile.filters.map((filter) => ({ filter, label: filter, supportsCondition: true })),
}
const state = {
  seq: 1,
  stop: 0,
  current: undefined as Stop | undefined,
  launch: undefined as Request | undefined,
  write: (_: Buffer) => {},
}

function encode(message: object) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}
function send(message: object) {
  state.write(encode({ seq: state.seq++, ...message }))
}
function respond(request: Request, body: object = {}, success = true, message?: string) {
  send({
    type: "response",
    request_seq: request.seq,
    command: request.command,
    success,
    body,
    ...(message ? { message } : {}),
  })
}
function event(name: string, body: object = {}) {
  send({ type: "event", event: name, body })
}
function log(entry: object) {
  if (script.log) appendFileSync(script.log, JSON.stringify(entry) + "\n")
}

function next() {
  const stop = script.stops?.[state.stop++]
  state.current = stop
  if (!stop) {
    event("exited", { exitCode: script.exitCode ?? 0 })
    event("terminated")
    return
  }
  event("stopped", {
    reason: stop.reason,
    threadId: 1,
    allThreadsStopped: true,
    ...(stop.description ? { description: stop.description } : {}),
  })
}

function variables(ref: number): Variable[] {
  if (ref === 1000) return state.current?.locals ?? []
  if (ref === 900)
    return Array.from({ length: script.big ?? 0 }, (_, index) => ({
      name: String(index),
      value: "x".repeat(2000),
      type: "str",
      variablesReference: index < 3 ? 901 + index : 0,
    }))
  if (ref > 900 && ref < 1000)
    return Array.from({ length: 80 }, (_, index) => ({
      name: `c${index}`,
      value: String(index),
      variablesReference: 0,
    }))
  return script.variables?.[String(ref)] ?? []
}

function handle(request: Request) {
  log({ command: request.command, arguments: request.arguments })
  if (script.crashOn === request.command) process.exit(3)
  if (script.malformedOn === request.command) {
    state.write(Buffer.from("Content-Length: 7\r\n\r\n{nope!}"))
    return
  }
  const args = request.arguments ?? {}
  switch (request.command) {
    case "initialize":
      if (script.initialize === "hang") return
      if (script.initialize === "crash") process.exit(4)
      respond(request, capabilities)
      if (script.profile !== "debugpy") event("initialized")
      return
    case "launch":
    case "attach":
      // debugpy answers launch only after configurationDone.
      if (script.profile === "debugpy") {
        state.launch = request
        event("initialized")
        return
      }
      return respond(request)
    case "setBreakpoints":
      return respond(request, {
        breakpoints: (args.breakpoints ?? []).map((item: { line: number }) => ({ verified: true, line: item.line })),
      })
    case "setFunctionBreakpoints":
    case "setDataBreakpoints":
      return respond(request, { breakpoints: (args.breakpoints ?? []).map(() => ({ verified: true })) })
    case "dataBreakpointInfo":
      return respond(request, { dataId: `data:${args.name}`, description: args.name, accessTypes: ["write"] })
    case "setExceptionBreakpoints":
      return respond(request)
    case "configurationDone":
      respond(request)
      if (state.launch) respond(state.launch)
      state.launch = undefined
      for (const item of script.output ?? []) event("output", item)
      if (script.reverse)
        send({ type: "request", command: script.reverse.command, arguments: script.reverse.arguments })
      return next()
    case "threads":
      return respond(request, { threads: [{ id: 1, name: "MainThread" }] })
    case "stackTrace": {
      const stop = state.current
      return respond(request, {
        stackFrames: stop
          ? [
              {
                id: 11,
                name: stop.name ?? "main",
                line: stop.line ?? 1,
                column: 1,
                source: { path: stop.file ?? "/work/app.py" },
              },
              { id: 12, name: "<module>", line: 40, column: 1, source: { path: stop.file ?? "/work/app.py" } },
            ]
          : [],
        totalFrames: stop ? 2 : 0,
      })
    }
    case "scopes":
      return respond(request, { scopes: [{ name: "Locals", variablesReference: 1000, expensive: false }] })
    case "variables":
      return respond(request, { variables: variables(Number(args.variablesReference)) })
    case "evaluate":
      return respond(request, { result: `<${args.expression}>`, variablesReference: 0 })
    case "completions":
      return respond(request, { targets: [{ label: "xs", type: "variable" }] })
    case "exceptionInfo":
      return respond(request, {
        exceptionId: state.current?.exception?.id ?? "Error",
        description: state.current?.exception?.description ?? "",
        breakMode: "unhandled",
      })
    case "continue":
    case "next":
    case "stepIn":
    case "stepOut":
      respond(request, request.command === "continue" ? { allThreadsContinued: true } : {})
      state.current = undefined
      if (script.hangOn?.includes(request.command)) return
      return next()
    case "pause":
      respond(request)
      state.current = { reason: "pause", name: "spin", line: 99 }
      return event("stopped", { reason: "pause", threadId: 1, allThreadsStopped: true })
    case "disconnect":
      respond(request)
      setTimeout(() => process.exit(0), 20)
      return
    default:
      return respond(request, {}, false, `fake adapter does not implement ${request.command}`)
  }
}

function reader() {
  let buffer = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const end = buffer.indexOf("\r\n\r\n")
      if (end === -1) return
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? 0)
      if (buffer.length < end + 4 + length) return
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"))
      buffer = buffer.subarray(end + 4 + length)
      if (message.type === "request") handle(message)
      if (message.type === "response")
        log({ response: message.command, success: message.success, body: message.body, message: message.message })
    }
  }
}

if (script.tcp) {
  const server = net.createServer((socket) => {
    state.write = (buffer) => void socket.write(buffer)
    socket.on("data", reader())
    socket.on("close", () => process.exit(0))
  })
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    process.stdout.write(`PORT ${typeof address === "object" && address ? address.port : 0}\n`)
  })
} else {
  state.write = (buffer) => void process.stdout.write(buffer)
  process.stdin.on("data", reader())
  process.stdin.on("end", () => process.exit(0))
}
