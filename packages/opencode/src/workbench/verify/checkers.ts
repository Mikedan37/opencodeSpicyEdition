import os from "os"
import path from "path"
import { access, constants, readdir } from "fs/promises"
import { Glob } from "@opencode-ai/core/util/glob"
import { which } from "@opencode-ai/core/util/which"
import type { ConfigWorkbenchV1 } from "@opencode-ai/core/v1/config/workbench"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { Filesystem } from "@/util/filesystem"
import { lazy } from "@/util/lazy"
import type { Doctor } from "../doctor"
import type { WorkbenchProblems } from "../problems/store"
import { WorkbenchParse } from "./parse"

// Native checkers, modeled on format/formatter.ts: each one maps a changed file to its unit (the
// tsconfig, crate, Go package, Swift package, compile_commands entry or Python project that owns it)
// and plans one command for the unit. "exec" plans can run project code and need verify.exec.

// A plan's command may contain this placeholder for a fresh directory the tool writes JUnit/xUnit reports into.
// The runner creates the directory, hands its files to `parse` as `report` and removes it afterwards.
export const REPORT_DIR = "$REPORT_DIR"

export type Unit = { root: string; files: string[] }
export type ExecClass = Workbench.RunInfo["execClass"]
export type Plan = { command: string[]; cwd: string; execClass: ExecClass } | { unavailable: string }

export interface Info {
  id: string
  kind: Workbench.SourceKind
  extensions: string[]
  /** Runs only after this checker passed on the same unit (go vet after go build). */
  after?: string
  /** A missing optional tool is left out instead of reported unavailable. */
  optional?: boolean
  /** Exit codes that mean "findings reported", not "the tool failed" (ruff exits 1 on findings). */
  findings?: number[]
  /** A test runner: runs only when tests are requested, always exec-class. */
  test?: boolean
  /** Exit codes that mean the tool found nothing to run, with the reason; reported as skipped (pytest 5). */
  empty?: Record<number, string>
  /** Selects changed files by something other than their extension (repository checks use globs). */
  matches?(file: string): boolean
  unit(file: string, stop: string): Promise<string | undefined>
  plan(unit: Unit, stop: string): Promise<Plan>
  parse(output: WorkbenchParse.Output): WorkbenchProblems.Draft[]
}

const SARIF = ["-fdiagnostics-format=sarif", "-Wno-sarif-format-unstable"]

export const tsc: Info = {
  id: "tsc",
  kind: "typecheck",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  unit: (file, stop) => nearest(["tsconfig.json"], file, stop),
  async plan(unit, stop) {
    const local = await Filesystem.findUp(path.join("node_modules", ".bin", "tsc"), path.dirname(unit.root), stop)
    const bin = local[0] ?? which("tsc")
    if (!bin) return { unavailable: "tsc not found" }
    return {
      command: [bin, "--noEmit", "-p", unit.root, "--pretty", "false"],
      cwd: path.dirname(unit.root),
      execClass: "inert",
    }
  },
  parse: WorkbenchParse.tsc,
}

const languages = {
  c: { compiler: "clang", sources: [".c"], headers: [".h"] },
  cpp: { compiler: "clang++", sources: [".cc", ".cpp", ".cxx", ".c++"], headers: [".hh", ".hpp", ".hxx"] },
  objc: { compiler: "clang", sources: [".m"], headers: [] as string[] },
  objcpp: { compiler: "clang++", sources: [".mm"], headers: [] as string[] },
}
const buildFiles = [
  "Makefile",
  "makefile",
  "GNUmakefile",
  "CMakeLists.txt",
  "meson.build",
  "configure",
  "BUILD",
  "BUILD.bazel",
]

// A unit is one compile_commands.json entry when the project has one, otherwise the file's folder. A folder
// without a build system whose sources define main() is also linked (to /dev/null), because a program that
// type-checks can still fail to link.
export const clang: Info = {
  id: "clang",
  kind: "compiler",
  extensions: Object.values(languages).flatMap((item) => [...item.sources, ...item.headers]),
  async unit(file, stop) {
    const db = await nearest(["compile_commands.json"], file, stop)
    if (db && (await compileEntry(db, file))) return file
    return path.dirname(file)
  },
  async plan(unit, stop) {
    if (path.extname(unit.root)) return entryPlan(unit.root, stop)
    const language =
      Object.values(languages).find((item) =>
        [...item.sources, ...item.headers].includes(path.extname(unit.files[0] ?? "")),
      ) ?? languages.c
    const bin = which(language.compiler)
    if (!bin) return { unavailable: `${language.compiler} not found` }
    const names = await readdir(unit.root)
    const sources = names.filter((name) => language.sources.includes(path.extname(name)))
    if (!sources.length)
      return {
        command: [bin, "-fsyntax-only", ...SARIF, ...unit.files.map((file) => path.basename(file))],
        cwd: unit.root,
        execClass: "inert",
      }
    const texts = await Promise.all(sources.map((name) => Filesystem.readText(path.join(unit.root, name))))
    const program = !names.some((name) => buildFiles.includes(name)) && texts.some((text) => /\bmain\s*\(/.test(text))
    return {
      command: [bin, ...(program ? ["-o", os.devNull] : ["-fsyntax-only"]), ...SARIF, ...sources],
      cwd: unit.root,
      execClass: "inert",
    }
  },
  parse: WorkbenchParse.clang,
}

// Package.swift → `swift build` (plugins, macros and dependencies can run package code: exec);
// loose files → `swiftc -typecheck` over the folder's .swift files.
export const swift: Info = {
  id: "swift",
  kind: "compiler",
  extensions: [".swift"],
  async unit(file, stop) {
    const manifest = await nearest(["Package.swift"], file, stop)
    return manifest ? path.dirname(manifest) : path.dirname(file)
  },
  async plan(unit) {
    const manifest = path.join(unit.root, "Package.swift")
    if (await Filesystem.exists(manifest)) {
      const bin = which("swift")
      if (!bin) return { unavailable: "swift not found" }
      const text = await Filesystem.readText(manifest)
      const exec = /\.plugin\s*\(|plugins\s*:|\.macro\s*\(|\.package\s*\(/.test(text)
      return { command: [bin, "build"], cwd: unit.root, execClass: exec ? "exec" : "inert" }
    }
    const bin = which("swiftc")
    if (!bin) return { unavailable: "swiftc not found" }
    const sources = (await readdir(unit.root)).filter((name) => name.endsWith(".swift"))
    return { command: [bin, "-typecheck", ...sources], cwd: unit.root, execClass: "inert" }
  },
  parse: WorkbenchParse.swift,
}

// One crate per unit, checked from its workspace root with -p. Build scripts, proc macros and any
// dependency (which may have either) make the run exec-class.
export const cargo: Info = {
  id: "cargo",
  kind: "compiler",
  extensions: [".rs"],
  async unit(file, stop) {
    for (const manifest of await Filesystem.findUp("Cargo.toml", path.dirname(file), stop))
      if (/^\[package\]/m.test(await Filesystem.readText(manifest))) return path.dirname(manifest)
  },
  async plan(unit, stop) {
    const bin = which("cargo")
    if (!bin) return { unavailable: "cargo not found" }
    const text = await Filesystem.readText(path.join(unit.root, "Cargo.toml"))
    const name = /^\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1]
    const manifests = await Filesystem.findUp("Cargo.toml", unit.root, stop)
    const texts = await Promise.all(manifests.map((item) => Filesystem.readText(item)))
    const workspace = manifests.find((_, index) => /^\[workspace\]/m.test(texts[index]))
    const exec =
      (await Filesystem.exists(path.join(unit.root, "build.rs"))) ||
      /^\s*build\s*=|^\s*proc-macro\s*=\s*true/m.test(text) ||
      hasDependencies(text)
    return {
      command: [bin, "check", "--message-format=json", ...(name ? ["-p", name] : [])],
      cwd: workspace ? path.dirname(workspace) : unit.root,
      execClass: exec ? "exec" : "inert",
    }
  },
  parse: WorkbenchParse.cargo,
}

// Go package = the file's folder inside a module. `go build` writes nothing (-o /dev/null); vet follows a
// clean build so a type error is not reported twice.
export const go: Info = {
  id: "go",
  kind: "compiler",
  extensions: [".go"],
  unit: async (file, stop) => ((await nearest(["go.mod"], file, stop)) ? path.dirname(file) : undefined),
  async plan(unit) {
    const bin = which("go")
    if (!bin) return { unavailable: "go not found" }
    return { command: [bin, "build", "-json", "-o", os.devNull, "."], cwd: unit.root, execClass: "inert" }
  },
  parse: WorkbenchParse.goBuild,
}

export const goVet: Info = {
  ...go,
  id: "go-vet",
  kind: "linter",
  after: "go",
  async plan(unit) {
    const bin = which("go")
    if (!bin) return { unavailable: "go not found" }
    return { command: [bin, "vet", "."], cwd: unit.root, execClass: "inert" }
  },
  parse: WorkbenchParse.goVet,
}

const pythonMarkers = ["pyproject.toml", "setup.cfg", "ruff.toml", "mypy.ini", ".mypy.ini"]
const pythonUnit = async (file: string, stop: string) => {
  const marker = await nearest(pythonMarkers, file, stop)
  return marker ? path.dirname(marker) : path.dirname(file)
}

export const ruff: Info = {
  id: "ruff",
  kind: "linter",
  extensions: [".py", ".pyi"],
  findings: [1],
  unit: pythonUnit,
  async plan(unit) {
    const bin = which("ruff")
    if (!bin) return { unavailable: "ruff not found" }
    return {
      command: [bin, "check", "--no-cache", "--output-format=json", ...relative(unit)],
      cwd: unit.root,
      execClass: "inert",
    }
  },
  parse: WorkbenchParse.ruff,
}

// mypy plugins are Python code from the project: exec-class.
export const mypy: Info = {
  id: "mypy",
  kind: "typecheck",
  extensions: [".py", ".pyi"],
  optional: true,
  unit: pythonUnit,
  async plan(unit) {
    const bin = which("mypy")
    if (!bin) return { unavailable: "mypy not found" }
    const configs = await Promise.all(
      pythonMarkers.map((name) => Filesystem.readText(path.join(unit.root, name)).catch(() => "")),
    )
    const exec = configs.some((text) => /^\s*plugins\s*=/m.test(text))
    return { command: [bin, "-O", "json", ...relative(unit)], cwd: unit.root, execClass: exec ? "exec" : "inert" }
  },
  parse: WorkbenchParse.mypy,
}

// ---------------------------------------------------------------- test runners (exec: they run project code)

export const goTest: Info = {
  id: "go-test",
  kind: "test",
  test: true,
  after: "go",
  extensions: [".go"],
  unit: go.unit,
  async plan(unit) {
    const bin = which("go")
    if (!bin) return { unavailable: "go not found" }
    return { command: [bin, "test", "-json", "."], cwd: unit.root, execClass: "exec" }
  },
  parse: WorkbenchParse.goTest,
}

export const cargoTest: Info = {
  id: "cargo-test",
  kind: "test",
  test: true,
  after: "cargo",
  extensions: [".rs"],
  unit: cargo.unit,
  async plan(unit, stop) {
    const check = await cargo.plan(unit, stop)
    if ("unavailable" in check) return check
    // [cargo, "check", "--message-format=json", "-p", name] → test the same crate
    return { ...check, command: [check.command[0], "test", ...check.command.slice(2)], execClass: "exec" }
  },
  // compiler messages are JSON lines, the test harness output is text
  parse: (output) => [...WorkbenchParse.cargo(output), ...WorkbenchParse.cargoTest(output)],
}

const scripts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/

// bun projects (a bun lockfile or bunfig up the tree) run `bun test`; others run `node --test` when their test
// script uses it. Changed test files narrow the run; otherwise the package's suite runs.
export const bunTest: Info = {
  id: "bun-test",
  kind: "test",
  test: true,
  extensions: scripts,
  async unit(file, stop) {
    const manifest = await nearest(["package.json"], file, stop)
    if (!manifest) return
    return (await nearest(["bun.lock", "bun.lockb", "bunfig.toml"], manifest, stop))
      ? path.dirname(manifest)
      : undefined
  },
  async plan(unit) {
    const bin = which("bun")
    if (!bin) return { unavailable: "bun not found" }
    return {
      command: [bin, "test", "--reporter=junit", "--reporter-outfile=/dev/stdout", ...relative(unit, testFile)],
      cwd: unit.root,
      execClass: "exec",
    }
  },
  parse: WorkbenchParse.junit,
}

export const nodeTest: Info = {
  id: "node-test",
  kind: "test",
  test: true,
  extensions: scripts,
  async unit(file, stop) {
    const manifest = await nearest(["package.json"], file, stop)
    if (!manifest || (await nearest(["bun.lock", "bun.lockb", "bunfig.toml"], manifest, stop))) return
    const json = await Filesystem.readJson<{ scripts?: { test?: string } }>(manifest).catch(
      () => ({}) as { scripts?: { test?: string } },
    )
    return json.scripts?.test?.includes("node --test") ? path.dirname(manifest) : undefined
  },
  async plan(unit) {
    const bin = which("node")
    if (!bin) return { unavailable: "node not found" }
    return {
      command: [
        bin,
        "--test",
        "--test-reporter=junit",
        "--test-reporter-destination=stdout",
        ...relative(unit, testFile),
      ],
      cwd: unit.root,
      execClass: "exec",
    }
  },
  parse: WorkbenchParse.junit,
}

// The first runnable pytest: every `pytest` on PATH, then `python3 -m pytest` for every python3 on PATH, each probed
// with --version, because the first one on PATH may be dead (an x86_64 python3 on arm64).
// ponytail: resolved once per process; restart opencode after installing pytest
const pytestCommand = lazy(async () => {
  const candidates = [
    ...(await onPath("pytest")).map((bin) => [bin]),
    ...(await onPath("python3")).map((bin) => [bin, "-m", "pytest"]),
  ]
  const runnable = await Promise.all(candidates.map((command) => runs([...command, "--version"])))
  return candidates[runnable.indexOf(true)]
})
const pythonTest = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/

export const pytest: Info = {
  id: "pytest",
  kind: "test",
  test: true,
  extensions: [".py"],
  empty: { 5: "no tests collected" },
  unit: pythonUnit,
  async plan(unit) {
    const command = await pytestCommand()
    if (!command) return { unavailable: "no runnable pytest (pytest or python3 -m pytest on PATH)" }
    return {
      command: [
        ...command,
        `--junitxml=${path.join(REPORT_DIR, "junit.xml")}`,
        "-q",
        "-p",
        "no:cacheprovider",
        ...relative(unit, pythonTest),
      ],
      cwd: unit.root,
      execClass: "exec",
    }
  },
  parse: WorkbenchParse.pytest,
}

// SwiftPM packages only. On this toolchain xUnit output carries XCTest results only with --parallel and no
// failure locations; the console output has them, so the parser joins both.
export const swiftTest: Info = {
  id: "swift-test",
  kind: "test",
  test: true,
  after: "swift",
  extensions: [".swift"],
  async unit(file, stop) {
    const manifest = await nearest(["Package.swift"], file, stop)
    return manifest && path.dirname(manifest)
  },
  async plan(unit) {
    const bin = which("swift")
    if (!bin) return { unavailable: "swift not found" }
    return {
      command: [bin, "test", "--parallel", "--xunit-output", path.join(REPORT_DIR, "xunit.xml")],
      cwd: unit.root,
      execClass: "exec",
    }
  },
  parse: WorkbenchParse.swiftTest,
}

export const all: Info[] = [
  tsc,
  clang,
  swift,
  cargo,
  go,
  goVet,
  ruff,
  mypy,
  goTest,
  cargoTest,
  bunTest,
  nodeTest,
  pytest,
  swiftTest,
]

async function nearest(names: string[], file: string, stop: string) {
  return (await Filesystem.findUp(names, path.dirname(file), stop))[0]
}

// ---------------------------------------------------------------- repository checks (workbench.checks, VER-07)

const formats: Record<ConfigWorkbenchV1.Format, { kind: Workbench.SourceKind; test?: boolean; parse: Info["parse"] }> =
  {
    plain: {
      kind: "build",
      parse: (output) => WorkbenchParse.located(`${output.stdout}\n${output.stderr}`, output.cwd),
    },
    tsc: { kind: "typecheck", parse: WorkbenchParse.tsc },
    sarif: { kind: "compiler", parse: WorkbenchParse.sarif },
    cargo: { kind: "compiler", parse: WorkbenchParse.cargo },
    "go-build": { kind: "compiler", parse: WorkbenchParse.goBuild },
    ruff: { kind: "linter", parse: WorkbenchParse.ruff },
    mypy: { kind: "typecheck", parse: WorkbenchParse.mypy },
    junit: { kind: "test", test: true, parse: WorkbenchParse.junit },
    "go-test": { kind: "test", test: true, parse: WorkbenchParse.goTest },
  }

// A check command from the repository's configuration. It is arbitrary repository code, so it is always
// exec-class; it has one unit (its cwd) and runs when a changed file matches `files`. Test formats run only
// when tests are requested, like the built-in test runners. A same-named built-in checker is replaced.
export function repo(name: string, check: ConfigWorkbenchV1.Check, directory: string): Info {
  const cwd = path.resolve(directory, check.cwd ?? ".")
  const format = formats[check.format]
  return {
    id: name,
    kind: format.kind,
    test: format.test,
    extensions: [],
    matches: (file) => (check.files ?? ["**/*"]).some((glob) => Glob.match(glob, path.relative(directory, file))),
    unit: async () => cwd,
    async plan() {
      const bin = await program(check.command[0], cwd)
      if (!bin) return { unavailable: `${check.command[0]} not found` }
      return { command: [bin, ...check.command.slice(1)], cwd, execClass: "exec" }
    },
    parse: format.parse,
  }
}

// Repository checks in the workbench doctor: located, never run, since they are repository code.
export async function doctor(checks: Record<string, ConfigWorkbenchV1.Check>, directory: string) {
  const probes = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<Doctor.Probe> => {
      const bin = await program(check.command[0], path.resolve(directory, check.cwd ?? "."))
      return {
        area: formats[check.format].test ? "test" : "check",
        tool: name,
        status: bin ? "ok" : "missing",
        path: bin,
        reason: bin ? "repository command: runs after verify.exec approval" : `${check.command[0]} not found`,
      }
    }),
  )
  return {
    id: "repo",
    name: "Repository checks",
    lsp: { server: "none", enabled: false, reason: "defined in workbench.checks" },
    probes,
  } satisfies Doctor.Language
}

// A command's program: a path (relative to the command's cwd) or a name on PATH.
async function program(name: string, cwd: string) {
  if (!name.includes("/")) return which(name) ?? undefined
  const file = path.resolve(cwd, name)
  return (await access(file, constants.X_OK).then(
    () => true,
    () => false,
  ))
    ? file
    : undefined
}

// Executables named `name` on PATH, in PATH order.
async function onPath(name: string) {
  const files = [...new Set((process.env.PATH ?? "").split(path.delimiter).filter(Boolean))].map((dir) =>
    path.join(dir, name),
  )
  const ok = await Promise.all(
    files.map((file) =>
      access(file, constants.X_OK).then(
        () => true,
        () => false,
      ),
    ),
  )
  return files.filter((_, index) => ok[index])
}

// Whether a command starts and exits 0 within 5 s (a dead binary fails to spawn).
async function runs(command: string[]) {
  const proc = await Promise.resolve()
    .then(() => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5_000 }))
    .catch(() => undefined)
  return proc ? (await proc.exited) === 0 : false
}

function relative(unit: Unit, only?: RegExp) {
  return unit.files.filter((file) => !only || only.test(file)).map((file) => path.relative(unit.root, file))
}

type CompileEntry = { directory: string; file: string; arguments?: string[]; command?: string }

async function compileEntry(db: string, file: string) {
  const entries = await Filesystem.readJson<CompileEntry[]>(db).catch(() => [] as CompileEntry[])
  return entries.find((entry) => path.resolve(entry.directory, entry.file) === file)
}

// Reuse the entry's flags but only type-check; outputs and dependency files are dropped.
async function entryPlan(file: string, stop: string): Promise<Plan> {
  const db = await nearest(["compile_commands.json"], file, stop)
  const entry = db ? await compileEntry(db, file) : undefined
  if (!entry) return { unavailable: "compile_commands.json entry not found" }
  // ponytail: `command` strings split on whitespace; quoted arguments need `arguments`
  const args = entry.arguments ?? entry.command?.split(/\s+/).filter(Boolean) ?? []
  const bin = path.basename(args[0] ?? "").includes("clang") ? args[0] : which("clang")
  if (!bin) return { unavailable: "clang not found" }
  const flags = args.slice(1).filter((arg, index, list) => {
    if (["-c", "-MD", "-MMD", "-M", "-MM"].includes(arg)) return false
    if (["-o", "-MF", "-MT", "-MQ"].includes(arg) || ["-o", "-MF", "-MT", "-MQ"].includes(list[index - 1] ?? ""))
      return false
    return path.resolve(entry.directory, arg) !== file
  })
  return { command: [bin, ...flags, "-fsyntax-only", ...SARIF, file], cwd: entry.directory, execClass: "inert" }
}

function hasDependencies(toml: string) {
  const lines = toml.split("\n").map((line) => line.replace(/#.*/, "").trim())
  return lines.some((line, index) => {
    if (!/^\[(?:target\..+\.)?(?:build-)?dependencies(?:\..+)?\]$/.test(line)) return false
    if (/dependencies\./.test(line)) return true
    const next = lines.slice(index + 1).find(Boolean)
    return next !== undefined && !next.startsWith("[")
  })
}

export * as WorkbenchCheckers from "./checkers"
