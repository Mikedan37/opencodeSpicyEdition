import path from "path"
import fs from "fs/promises"
import { Cause, type Duration, Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { Global } from "@opencode-ai/core/global"
import { Module } from "@opencode-ai/core/util/module"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Filesystem } from "@/util/filesystem"
import { errorMessage } from "@/util/error"

// Workbench doctor: per language, whether LSP is enabled and whether the language server, native checkers, test
// runners and debug adapters are present AND runnable here. Every probe runs with a timeout, all run concurrently,
// nothing is installed and nothing is launched under a debugger.

export const Status = Schema.Literals(["ok", "missing", "broken", "blocked"])
export type Status = typeof Status.Type

export const Probe = Schema.Struct({
  area: Schema.Literals(["runtime", "lsp", "check", "test", "debug"]),
  tool: Schema.String,
  status: Status,
  path: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkbenchDoctorProbe" })
export interface Probe extends Schema.Schema.Type<typeof Probe> {}

export const Language = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  lsp: Schema.Struct({ server: Schema.String, enabled: Schema.Boolean, reason: Schema.optional(Schema.String) }),
  probes: Schema.Array(Probe),
}).annotate({ identifier: "WorkbenchDoctorLanguage" })
export interface Language extends Schema.Schema.Type<typeof Language> {}

export const Report = Schema.Struct({ languages: Schema.Array(Language) }).annotate({
  identifier: "WorkbenchDoctorReport",
})
export interface Report extends Schema.Schema.Type<typeof Report> {}

export interface Input {
  directory: string
  lsp: ConfigV1.Info["lsp"]
  experimentalLspTy?: boolean
  env?: NodeJS.ProcessEnv // PATH for lookups and runs, process.env by default
  home?: string // where .vscode/extensions is looked up
  timeout?: Duration.Input // per probe
}

type Result = Omit<Probe, "area" | "tool">

// Bun reports these spawn errors as "unknown error".
const SPAWN_ERRORS: Record<string, string> = { EBADARCH: "bad CPU type in executable", ENOEXEC: "exec format error" }

export const report = Effect.fn("Doctor.report")(function* (input: Input) {
  const proc = yield* AppProcess.Service
  const env = input.env ?? process.env
  const home = input.home ?? Global.Path.home
  const timeout = input.timeout ?? "3 seconds"
  const darwin = process.platform === "darwin"
  const dirs = [...new Set([...(env.PATH ?? "").split(path.delimiter).filter(Boolean), Global.Path.bin])]

  const run = (file: string, args: string[], extra: Record<string, string> = {}) =>
    proc.run(ChildProcess.make(file, args, { env: { ...env, ...extra }, stdin: "ignore" }), { timeout }).pipe(
      Effect.map((result) => ({ code: result.exitCode, text: `${result.stdout}\n${result.stderr}`.trim() })),
      // Spawn failures (a dead x86_64 binary is EBADARCH) surface as defects, timeouts as failures.
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        const text = errorMessage(
          error instanceof AppProcess.AppProcessError && error.cause instanceof Error ? error.cause : error,
        )
        return Effect.succeed({
          code: -1,
          text: text.replace(/^(\w+): unknown error/, (match, code: string) =>
            SPAWN_ERRORS[code] ? `${code}: ${SPAWN_ERRORS[code]}` : match,
          ),
        })
      }),
    )

  // Every executable named `bin` on PATH, in PATH order (the first is what a server spawn would pick).
  const which = Effect.fnUntraced(function* (bin: string) {
    const files = yield* Effect.forEach(
      dirs.map((dir) => path.join(dir, bin)),
      (file) => executable(file).pipe(Effect.map((ok) => (ok ? file : undefined))),
      { concurrency: "unbounded" },
    )
    return files.filter((file) => file !== undefined)
  })

  // macOS developer tools in /usr/bin are shims that open the Command Line Tools installer when no developer
  // directory is set, so they are never run then.
  const xcodeSelect = (yield* which("xcode-select"))[0]
  const developer = !darwin || (xcodeSelect !== undefined && (yield* run(xcodeSelect, ["-p"])).code === 0)
  const xcrun = darwin && developer ? (yield* which("xcrun"))[0] : undefined

  const locate = Effect.fnUntraced(function* (bin: string, options: { xcrun?: boolean; npm?: string } = {}) {
    const found = (yield* which(bin))[0]
    if (found) return found
    if (options.npm) {
      const cached = path.join(Global.Path.cache, "packages", options.npm, "node_modules", ".bin", bin)
      if (yield* executable(cached)) return cached
    }
    if (!options.xcrun || !xcrun) return undefined
    const result = yield* run(xcrun, ["-f", bin])
    return result.code === 0 ? result.text.split("\n")[0] : undefined
  })

  const probe = Effect.fnUntraced(function* (file: string | undefined, args: string[], extra?: Record<string, string>) {
    if (!file) return { status: "missing" } satisfies Result
    if (!developer && file.startsWith("/usr/bin/"))
      return { status: "missing", path: file, reason: "Xcode Command Line Tools are not installed" } satisfies Result
    const result = yield* run(file, args, extra)
    const lines = result.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    // `--help` output is not a version, so only the path is kept for those probes.
    if (result.code === 0)
      return {
        status: "ok",
        path: file,
        version: args.includes("--help") ? undefined : (lines.find((line) => /\d/.test(line)) ?? lines[0]),
      } satisfies Result
    return { status: "broken", path: file, reason: lines.at(-1) ?? `exit code ${result.code}` } satisfies Result
  })

  const tool = (bin: string, args: string[], options?: { xcrun?: boolean; npm?: string }) =>
    locate(bin, options).pipe(Effect.flatMap((file) => probe(file, args)))

  // Interpreter lookup runs every python3 on PATH: the first one may be dead (an x86_64 build on arm64).
  const python = yield* Effect.cached(
    Effect.gen(function* () {
      const results = yield* Effect.forEach(yield* which("python3"), (file) => probe(file, ["--version"]), {
        concurrency: "unbounded",
      })
      const ok = results.find((item) => item.status === "ok")
      const failed = results
        .slice(0, ok ? results.indexOf(ok) : undefined)
        .map((item) => `${item.path}: ${item.reason ?? item.status}`)
      if (ok) return { ...ok, reason: failed.length ? `skipped ${failed.join("; ")}` : undefined } satisfies Result
      return { status: failed.length ? "broken" : "missing", reason: failed.join("; ") || undefined } satisfies Result
    }),
  )

  const withPython = Effect.fnUntraced(function* (
    use: (file: string) => Effect.Effect<Result>,
  ): Effect.fn.Return<Result> {
    const interpreter = yield* python
    if (interpreter.status !== "ok" || !interpreter.path)
      return { status: interpreter.status, reason: `no runnable python3 (${interpreter.reason ?? "none on PATH"})` }
    return yield* use(interpreter.path)
  })

  const pytest = Effect.gen(function* () {
    const bin = yield* locate("pytest")
    if (bin) return yield* probe(bin, ["--version"])
    return yield* withPython((file) =>
      probe(file, ["-m", "pytest", "--version"]).pipe(
        Effect.map(
          (result): Result =>
            result.status === "ok" ? result : { status: "missing", reason: `pytest is not installed for ${file}` },
        ),
      ),
    )
  })

  const debugpy = withPython((file) =>
    Effect.gen(function* () {
      const code = "import debugpy, sys; sys.stdout.write(debugpy.__version__)"
      const installed = yield* probe(file, ["-c", code])
      if (installed.status === "ok") return installed
      // ponytail: newest extension by name sort; compare versions if several old ones linger
      const libs = (yield* extensions("ms-python.debugpy-", path.join("bundled", "libs"))).at(-1)
      if (!libs)
        return { status: "missing", reason: `not importable by ${file} and not bundled with VS Code` } as Result
      return { ...(yield* probe(file, ["-c", code], { PYTHONPATH: libs })), path: libs }
    }),
  )

  const node = yield* Effect.cached(tool("node", ["--version"]))

  const jsDebug = Effect.gen(function* () {
    const server = yield* firstExisting([
      path.join(Global.Path.bin, "js-debug", "src", "dapDebugServer.js"),
      ...(yield* extensions("ms-vscode.js-debug", path.join("src", "dapDebugServer.js"))),
    ])
    if (!server) return { status: "missing", reason: "no vscode-js-debug dapDebugServer.js" } satisfies Result
    if ((yield* node).status !== "ok")
      return { status: "broken", path: server, reason: "node is not runnable" } satisfies Result
    return { status: "ok", path: server } satisfies Result
  })

  const lldbDap = yield* Effect.cached(
    Effect.gen(function* () {
      const result = yield* tool("lldb-dap", ["--version"], { xcrun: true })
      if (result.status !== "ok" || !darwin) return result
      const security = (yield* which("DevToolsSecurity"))[0] ?? (yield* firstExisting(["/usr/sbin/DevToolsSecurity"]))
      if (!security || !/disabled/i.test((yield* run(security, ["-status"])).text)) return result
      return {
        ...result,
        status: "blocked",
        reason:
          "Developer Mode is off: launching under lldb asks for an admin password (sudo DevToolsSecurity -enable)",
      } satisfies Result
    }),
  )

  const tsc = Effect.gen(function* () {
    const local = (yield* Effect.promise(() =>
      Filesystem.findUp(path.join("node_modules", ".bin", "tsc"), input.directory),
    ))[0]
    return yield* probe(local ?? (yield* locate("tsc")), ["--version"])
  })

  const typescriptServer = Effect.gen(function* () {
    const result = yield* tool("typescript-language-server", ["--version"], { npm: "typescript-language-server" })
    if (result.status !== "ok" || Module.resolve("typescript/lib/tsserver.js", input.directory)) return result
    return { ...result, status: "missing", reason: "this project has no typescript package" } satisfies Result
  })

  const swift = yield* Effect.cached(tool("swift", ["--version"], { xcrun: true }))
  const cargo = yield* Effect.cached(tool("cargo", ["--version"]))
  const go = yield* Effect.cached(tool("go", ["version"]))
  const pyright = yield* Effect.cached(tool("pyright", ["--version"], { npm: "pyright" }))
  const pythonServer = input.experimentalLspTy ? "ty" : "pyright"

  const languages = [
    {
      id: "swift",
      name: "Swift",
      server: "sourcekit-lsp",
      probes: [
        row("lsp", "sourcekit-lsp", tool("sourcekit-lsp", ["--help"], { xcrun: true })),
        row("check", "swiftc", tool("swiftc", ["--version"], { xcrun: true })),
        row("test", "swift test", swift),
        row("debug", "lldb-dap", lldbDap),
      ],
    },
    {
      id: "c",
      name: "C/C++",
      server: "clangd",
      probes: [
        row("lsp", "clangd", tool("clangd", ["--version"])),
        row("check", "clang", tool("clang", ["--version"])),
        row("debug", "lldb-dap", lldbDap),
      ],
    },
    {
      id: "python",
      name: "Python",
      server: pythonServer,
      probes: [
        row("runtime", "python3", python),
        row("lsp", pythonServer, pythonServer === "pyright" ? pyright : tool("ty", ["--version"])),
        row("check", "ruff", tool("ruff", ["--version"])),
        row("check", "mypy", tool("mypy", ["--version"])),
        row("check", "pyright", pyright),
        row("test", "pytest", pytest),
        row("debug", "debugpy", debugpy),
      ],
    },
    {
      id: "typescript",
      name: "TypeScript/JavaScript",
      server: "typescript",
      probes: [
        row("lsp", "typescript-language-server", typescriptServer),
        row("check", "tsc", tsc),
        row("test", "bun test", tool("bun", ["--version"])),
        row("test", "node --test", node),
        row("debug", "js-debug", jsDebug),
      ],
    },
    {
      id: "rust",
      name: "Rust",
      server: "rust",
      probes: [
        row("lsp", "rust-analyzer", tool("rust-analyzer", ["--version"])),
        row("check", "cargo check", cargo),
        row("test", "cargo test", cargo),
        row("debug", "lldb-dap", lldbDap),
      ],
    },
    {
      id: "go",
      name: "Go",
      server: "gopls",
      probes: [
        row("lsp", "gopls", tool("gopls", ["version"])),
        row("check", "go vet", go),
        row("test", "go test", go),
        row("debug", "dlv", tool("dlv", ["version"])),
      ],
    },
  ]

  return {
    languages: yield* Effect.forEach(
      languages,
      (language) =>
        Effect.all(language.probes, { concurrency: "unbounded" }).pipe(
          Effect.map(
            (probes): Language => ({
              id: language.id,
              name: language.name,
              lsp: { server: language.server, ...enabled(input.lsp, language.server) },
              probes,
            }),
          ),
        ),
      { concurrency: "unbounded" },
    ),
  } satisfies Report

  function extensions(prefix: string, inner: string) {
    const root = path.join(home, ".vscode", "extensions")
    return Effect.promise(async () => {
      const names = await fs.readdir(root).catch(() => [] as string[])
      const found = names
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => path.join(root, name, inner))
      return (
        await Promise.all(found.map(async (file) => ((await Filesystem.exists(file)) ? file : undefined)))
      ).filter((file) => file !== undefined)
    })
  }
})

// Plain-text table for the CLI: one row per probe.
export function table(report: Report) {
  const rows = report.languages.flatMap((language) => [
    [
      language.id,
      "config",
      language.lsp.enabled ? "ok" : "off",
      `lsp ${language.lsp.server}`,
      language.lsp.reason ?? "",
    ],
    ...language.probes.map((probe) => [
      language.id,
      probe.area,
      probe.status,
      probe.tool,
      [probe.version, probe.reason].filter(Boolean).join(" | ") || (probe.path ?? ""),
    ]),
  ])
  const header = ["LANG", "AREA", "STATUS", "TOOL", "DETAIL"]
  const widths = header.slice(0, 4).map((_, index) => Math.max(...[header, ...rows].map((row) => row[index].length)))
  return [header, ...rows]
    .map((row) =>
      [...row.slice(0, 4).map((cell, index) => cell.padEnd(widths[index])), truncate(row[4], 100)].join("  ").trimEnd(),
    )
    .join("\n")
}

function row(area: Probe["area"], tool: string, effect: Effect.Effect<Result>) {
  return effect.pipe(Effect.map((result): Probe => ({ area, tool, ...result })))
}

function enabled(lsp: Input["lsp"], server: string) {
  if (!lsp) return { enabled: false, reason: 'LSP is off; set "lsp": true in opencode.json' }
  if (lsp !== true && lsp[server]?.disabled) return { enabled: false, reason: `"${server}" is disabled in config` }
  return { enabled: true }
}

function executable(file: string) {
  return Effect.promise(() =>
    fs.access(file, fs.constants.X_OK).then(
      () => fs.stat(file).then((stat) => stat.isFile()),
      () => false,
    ),
  )
}

function firstExisting(files: string[]) {
  return Effect.promise(async () => {
    for (const file of files) if (await Filesystem.exists(file)) return file
    return undefined
  })
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export * as Doctor from "./doctor"
