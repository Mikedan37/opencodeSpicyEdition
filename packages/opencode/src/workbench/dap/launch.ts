// What to debug: a .vscode/launch.json configuration (JSONC, with ${workspaceFolder},
// ${file} and ${env:X}), a plain program, or a test preset (Python, Rust).
import path from "path"
import { parse, type ParseError } from "jsonc-parser"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Schema } from "effect"
import { Filesystem } from "@/util/filesystem"
import { Redact } from "../redact"
import { DebugError } from "./client"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

// The start input is part of the shared contract (the debug route body, the tool's fields, investigation targets).
export const Adapter = Workbench.DebugAdapter
export type Adapter = Workbench.DebugAdapter
export const Breakpoint = Workbench.DebugBreakpoint
export type Breakpoint = Workbench.DebugBreakpoint
export const StartInput = Workbench.DebugStartInput
export type StartInput = Workbench.DebugStartInput

export const AttachInput = Schema.Struct({
  adapter: Adapter,
  pid: Schema.optional(PositiveInt).annotate({ description: "Process id (lldb-dap)" }),
  port: Schema.optional(PositiveInt).annotate({
    description: "debugpy: port of a program started with python -m debugpy --listen 127.0.0.1:PORT",
  }),
  breakpoints: Schema.optional(Schema.Array(Breakpoint)),
  exceptions: Schema.optional(Schema.Array(Schema.String)),
})
export type AttachInput = typeof AttachInput.Type

export type Spec = {
  readonly adapter: Adapter
  readonly request: "launch" | "attach"
  // Short label for titles and permission prompts.
  readonly name: string
  readonly program?: string
  readonly arguments: Record<string, unknown>
  // launch.json debugServer: connect to an adapter that is already listening on 127.0.0.1.
  readonly port?: number
  readonly python?: string
  readonly breakpoints: readonly (Omit<Breakpoint, "file"> & { readonly file: string })[]
  readonly exceptions: readonly string[]
  readonly functions?: readonly string[]
  // Built after the launch was approved, never before: building runs project code (build scripts, macros).
  readonly build?: { readonly command: readonly string[]; readonly cwd: string }
  // Rust program: load rustc's LLDB formatters.
  readonly rust?: boolean
  readonly notes: readonly string[]
}

type Context = { readonly directory: string }

export const resolve = Effect.fnUntraced(function* (input: StartInput, ctx: Context) {
  const breakpoints = (input.breakpoints ?? []).map((item) => ({
    ...item,
    file: path.resolve(ctx.directory, item.file),
  }))
  if (input.configuration) return yield* fromLaunchJson(input, ctx, breakpoints)
  if (input.preset === "rust-test") return yield* rustTest(input, ctx, breakpoints)
  if (!input.program) return yield* invalid("give a program, a launch.json configuration or a preset")
  const program = path.resolve(ctx.directory, input.program)
  const adapter = input.adapter ?? (program.endsWith(".py") || input.preset === "python-test" ? "debugpy" : "lldb-dap")
  const common = {
    ...(input.args ? { args: [...input.args] } : {}),
    cwd: input.cwd ? path.resolve(ctx.directory, input.cwd) : ctx.directory,
    ...(input.stopOnEntry !== undefined ? { stopOnEntry: input.stopOnEntry } : {}),
  }
  const test = input.preset === "python-test"
  const rust = adapter === "lldb-dap" && (yield* cargo(program, ctx.directory))
  return {
    adapter,
    request: "launch",
    name: path.relative(ctx.directory, program) || program,
    program,
    ...(rust ? { rust, functions: [PANIC] } : {}),
    arguments:
      adapter === "debugpy"
        ? {
            type: "python",
            request: "launch",
            ...(test ? { module: "pytest", args: [program, ...(input.args ?? [])] } : { program }),
            ...(test ? {} : common.args ? { args: common.args } : {}),
            cwd: common.cwd,
            ...(common.stopOnEntry !== undefined ? { stopOnEntry: common.stopOnEntry } : {}),
            console: "internalConsole",
            justMyCode: true,
          }
        : { program, ...common, ...lldb },
    breakpoints,
    exceptions: input.exceptions ?? defaults(adapter, test),
    notes: [],
  } satisfies Spec
})

export const attach = (input: AttachInput, ctx: Context): Effect.Effect<Spec, DebugError> =>
  Effect.gen(function* () {
    const breakpoints = (input.breakpoints ?? []).map((item) => ({
      ...item,
      file: path.resolve(ctx.directory, item.file),
    }))
    if (input.adapter === "debugpy") {
      // Attaching debugpy by pid injects code through a native debugger; only the listening form is offered.
      if (!input.port)
        return yield* invalid(
          "debugpy attaches to a port: start the program with python -m debugpy --listen 127.0.0.1:PORT",
        )
      return {
        adapter: "debugpy",
        request: "attach",
        name: `127.0.0.1:${input.port}`,
        arguments: {
          type: "python",
          request: "attach",
          connect: { host: "127.0.0.1", port: input.port },
          justMyCode: true,
        },
        breakpoints,
        exceptions: input.exceptions ?? ["uncaught"],
        notes: [],
      } satisfies Spec
    }
    if (!input.pid) return yield* invalid("lldb-dap attaches to a pid")
    return {
      adapter: "lldb-dap",
      request: "attach",
      name: `pid ${input.pid}`,
      arguments: { pid: input.pid, ...lldb },
      breakpoints,
      exceptions: input.exceptions ?? [],
      notes: [],
    } satisfies Spec
  })

// lldb launches the program itself, on a pseudo-terminal of its own, and forwards its output as DAP output events (so
// stdout stays line-buffered and output written before a crash survives). Not runInTerminal: lldb-dap's launcher is
// lldb-dap itself, which the debugger has to attach to before it execs the program, and macOS does not allow
// attaching to Xcode's Apple-signed lldb-dap ("Not allowed to attach to process"), so that launch can never start.
const lldb = { runInTerminal: false, console: "internalConsole", commandEscapePrefix: "`" }

// std calls rust_panic for every panic, so a function breakpoint there stops on failed asserts and unwraps.
const PANIC = "rust_panic"

/** A program inside a Cargo project (a Cargo.toml between it and the project root) is Rust. */
const cargo = (program: string, directory: string) =>
  Effect.promise(() =>
    Filesystem.findUp("Cargo.toml", path.dirname(program), directory).then((found) => found.length > 0),
  )

const rustTest = Effect.fnUntraced(function* (input: StartInput, ctx: Context, breakpoints: Spec["breakpoints"]) {
  const target = path.resolve(ctx.directory, input.program ?? ".")
  const crate = path.basename(target) === "Cargo.toml" ? path.dirname(target) : target
  if (!(yield* Effect.promise(() => Filesystem.exists(path.join(crate, "Cargo.toml")))))
    return yield* invalid(`rust-test needs a crate folder; no Cargo.toml in ${crate}`)
  return {
    adapter: "lldb-dap",
    request: "launch",
    name: `${path.relative(ctx.directory, crate) || path.basename(crate)} tests`,
    arguments: {
      ...(input.args ? { args: [...input.args] } : {}),
      cwd: input.cwd ? path.resolve(ctx.directory, input.cwd) : crate,
      ...(input.stopOnEntry !== undefined ? { stopOnEntry: input.stopOnEntry } : {}),
      ...lldb,
    },
    build: { command: ["cargo", "test", "--no-run", "--message-format=json"], cwd: crate },
    rust: true,
    functions: [PANIC],
    breakpoints,
    exceptions: input.exceptions ?? [],
    notes: [],
  } satisfies Spec
})

function defaults(adapter: Adapter, test: boolean) {
  if (adapter === "lldb-dap") return []
  return test ? ["uncaught", "userUnhandled"] : ["uncaught"]
}

const fromLaunchJson = Effect.fnUntraced(function* (input: StartInput, ctx: Context, breakpoints: Spec["breakpoints"]) {
  const file = path.join(ctx.directory, ".vscode", "launch.json")
  const text = yield* Effect.promise(() => Filesystem.readText(file).catch(() => undefined))
  if (text === undefined) return yield* invalid(`no ${path.relative(ctx.directory, file)} in this project`)
  const errors: ParseError[] = []
  const json = parse(text, errors, { allowTrailingComma: true }) as
    | { configurations?: Record<string, unknown>[] }
    | undefined
  if (errors.length || !Array.isArray(json?.configurations)) return yield* invalid(`${file} is not valid JSONC`)
  const raw = json.configurations.find((item) => item.name === input.configuration)
  if (!raw)
    return yield* invalid(
      `no configuration named "${input.configuration}" (have: ${json.configurations.map((item) => String(item.name)).join(", ")})`,
    )
  const config = substitute(raw, {
    workspaceFolder: ctx.directory,
    workspaceFolderBasename: path.basename(ctx.directory),
    userHome: process.env.HOME ?? "",
    pathSeparator: path.sep,
    ...(input.file
      ? {
          file: path.resolve(ctx.directory, input.file),
          fileBasename: path.basename(input.file),
          fileDirname: path.dirname(path.resolve(ctx.directory, input.file)),
        }
      : {}),
  })
  if (typeof config === "string") return yield* invalid(config)
  const adapter = typeMap[String(config.type)]
  if (!adapter)
    return yield* invalid(`launch.json type "${String(config.type)}" is not supported (debugpy and lldb-dap are)`)
  const request = config.request === "attach" ? "attach" : "launch"
  const program = typeof config.program === "string" ? path.resolve(ctx.directory, config.program) : undefined
  const rust = adapter === "lldb-dap" && program !== undefined && (yield* cargo(program, ctx.directory))
  const preLaunch = typeof config.preLaunchTask === "string" ? config.preLaunchTask : undefined
  const args = {
    ...config,
    ...(input.args ? { args: [...input.args] } : {}),
    ...(input.cwd ? { cwd: path.resolve(ctx.directory, input.cwd) } : {}),
    ...(input.stopOnEntry !== undefined ? { stopOnEntry: input.stopOnEntry } : {}),
    ...(program ? { program } : {}),
    ...(adapter === "lldb-dap" ? lldb : {}),
  }
  return {
    adapter,
    request,
    name: String(config.name),
    ...(program ? { program } : {}),
    arguments: args,
    ...(typeof config.debugServer === "number" ? { port: config.debugServer } : {}),
    ...(rust ? { rust, functions: [PANIC] } : {}),
    ...(typeof config.python === "string" ? { python: config.python } : {}),
    breakpoints,
    exceptions: input.exceptions ?? defaults(adapter, false),
    // Tasks run arbitrary project commands; OpenCode does not run them.
    notes: preLaunch ? [`preLaunchTask "${preLaunch}" was not run`] : [],
  } satisfies Spec
})

const typeMap: Record<string, Adapter | undefined> = {
  python: "debugpy",
  debugpy: "debugpy",
  "lldb-dap": "lldb-dap",
  lldb: "lldb-dap",
}

/**
 * Replaces ${...} variables in every string. Returns an error message for an unknown or missing variable, and for an
 * ${env:NAME} that names a secret (Redact.secretEnv): the program's output reaches the model, and approving a
 * configuration is not approving the server's credentials, so nothing is substituted and the start fails.
 */
export function substitute(
  value: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> | string {
  const problems: string[] = []
  const walk = (item: unknown): unknown => {
    if (typeof item === "string")
      return item.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
        if (name.startsWith("env:") && Redact.secretEnv(name.slice(4))) {
          problems.push(`${match} names a secret and is not passed to the program`)
          return match
        }
        if (name.startsWith("env:")) return process.env[name.slice(4)] ?? ""
        if (name in vars) return vars[name]
        problems.push(name === "file" ? "${file} needs the file parameter" : `unsupported variable ${match}`)
        return match
      })
    if (Array.isArray(item)) return item.map(walk)
    if (typeof item === "object" && item !== null)
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]))
    return item
  }
  const result = walk(value) as Record<string, unknown>
  return problems.length ? problems.join("; ") : result
}

function invalid(message: string) {
  return new DebugError({ kind: "invalid", message })
}

export * as DebugLaunch from "./launch"
