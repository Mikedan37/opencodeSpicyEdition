// debugpy: pick the Python to debug with, then a debugpy it can import, else VS Code's bundled copy.
// Order: launch.json `python`, the project's .venv/venv, $VIRTUAL_ENV, Homebrew, then other Pythons on
// PATH. Every candidate is run before use (PATH may hold dead binaries, e.g. an x86_64 python3 on Apple
// silicon). Apple's own Pythons (/usr/bin/python3 and the Xcode or Command Line Tools copies behind it)
// are never used: they run as signed app bundles, and debugging under them crashed Python with a
// "Python quit unexpectedly" dialog on the user's screen.
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Option, Schema } from "effect"
import { Process } from "@/util/process"

export type Resolved = {
  readonly python: string
  readonly command: string[]
  readonly env: Record<string, string>
  readonly debugpy: string
  readonly source: "installed" | "vscode"
  readonly pytest: boolean
}

const PROBE = [
  "import sys, os, json, importlib.util as u",
  "try:",
  "    import debugpy; d = debugpy.__version__",
  "except Exception:",
  "    d = None",
  "print(json.dumps({'version': sys.version.split()[0], 'debugpy': d, 'pytest': u.find_spec('pytest') is not None,",
  "    'executable': os.path.realpath(sys.executable), 'base': os.path.realpath(sys.base_prefix)}))",
].join("\n")

const decodeProbe = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      debugpy: Schema.NullOr(Schema.String),
      pytest: Schema.Boolean,
      executable: Schema.String,
      base: Schema.String,
    }),
  ),
)

export const APPLE_REFUSED =
  "Apple's system Python (/usr/bin/python3, Xcode, Command Line Tools) is not used for debugging: it crashes under debugpy"

const cache = new Map<string, Resolved>()

export async function resolve(input: {
  readonly directory: string
  readonly python?: string
}): Promise<Resolved | { error: string }> {
  const key = `${input.directory}\0${input.python ?? ""}`
  const hit = cache.get(key)
  if (hit) return hit
  const tried: string[] = []
  const chosen = await choose(candidates(input.directory, input.python), tried)
  if (!chosen) {
    const apple = tried.some((item) => item.endsWith("(Apple system Python, not used)"))
    return {
      error: apple
        ? `no suitable Python for debugpy. ${APPLE_REFUSED}; install Python from Homebrew (brew install python) or point a project .venv at one (tried ${tried.join(", ")})`
        : `no runnable Python found (tried ${tried.join(", ") || "nothing"})`,
    }
  }
  if (chosen.debugpy)
    return remember(key, {
      python: chosen.python,
      command: [chosen.python, "-m", "debugpy.adapter"],
      env: {},
      debugpy: chosen.debugpy,
      source: "installed",
      pytest: chosen.pytest,
    })
  for (const libs of await bundles()) {
    const result = await probe(chosen.python, { PYTHONPATH: libs })
    if (result?.debugpy)
      return remember(key, {
        python: chosen.python,
        command: [chosen.python, "-m", "debugpy.adapter"],
        env: { PYTHONPATH: libs },
        debugpy: result.debugpy,
        source: "vscode",
        pytest: chosen.pytest,
      })
  }
  return {
    error: `debugpy is not available for ${chosen.python}; install it (python3 -m pip install debugpy) or the VS Code Python Debugger extension`,
  }
}

/** The first candidate that exists, is not an Apple Python and runs. Apple ones are never executed. */
async function choose(list: readonly string[], tried: string[]) {
  for (const candidate of list) {
    if (!(await fs.stat(candidate).catch(() => undefined))?.isFile()) continue
    const real = await fs.realpath(candidate).catch(() => candidate)
    if (apple(candidate) || apple(real)) {
      tried.push(`${candidate} (Apple system Python, not used)`)
      continue
    }
    const result = await probe(candidate)
    if (!result) {
      tried.push(`${candidate} (does not run)`)
      continue
    }
    // A virtual environment built on an Apple Python runs that Python.
    if (apple(result.executable) || apple(result.base)) {
      tried.push(`${candidate} (Apple system Python, not used)`)
      continue
    }
    tried.push(`${candidate} (${result.version})`)
    return { python: candidate, debugpy: result.debugpy, pytest: result.pytest }
  }
  return undefined
}

export function candidates(directory: string, preferred?: string) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  return [
    ...new Set(
      [
        preferred,
        path.join(directory, ".venv", "bin", "python"),
        path.join(directory, "venv", "bin", "python"),
        process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, "bin", "python") : undefined,
        "/opt/homebrew/bin/python3",
        ...dirs.flatMap((dir) => [path.join(dir, "python3"), path.join(dir, "python")]),
        "/usr/local/bin/python3",
      ].filter((item): item is string => typeof item === "string"),
    ),
  ]
}

/** Apple's Pythons: /usr/bin (the shims), the system framework, Command Line Tools and any Xcode app. */
export function apple(file: string) {
  return (
    file.startsWith("/usr/bin/") ||
    file.startsWith("/System/Library/") ||
    file.startsWith("/Library/Developer/CommandLineTools/") ||
    /^\/Applications\/Xcode[^/]*\.app\//.test(file)
  )
}

/** VS Code's ms-python.debugpy extension ships debugpy under bundled/libs. Newest first. */
export async function bundles(home = os.homedir()) {
  const roots = [".vscode/extensions", ".vscode-insiders/extensions", ".cursor/extensions"].map((item) =>
    path.join(home, item),
  )
  const found = await Promise.all(
    roots.map(async (root) =>
      (await fs.readdir(root).catch(() => [] as string[]))
        .filter((name) => name.startsWith("ms-python.debugpy-"))
        .map((name) => path.join(root, name, "bundled", "libs")),
    ),
  )
  const libs = found.flat().toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const usable = await Promise.all(
    libs.map((item) =>
      fs.stat(path.join(item, "debugpy")).then(
        () => item,
        () => undefined,
      ),
    ),
  )
  return usable.filter((item): item is string => item !== undefined)
}

async function probe(python: string, env?: Record<string, string>) {
  const out = await Process.text([python, "-c", PROBE], {
    nothrow: true,
    abort: AbortSignal.timeout(5_000),
    env,
  }).catch(() => undefined)
  if (!out || out.code !== 0) return undefined
  return Option.getOrUndefined(decodeProbe(out.text.trim().split("\n").at(-1) ?? ""))
}

function remember(key: string, value: Resolved) {
  cache.set(key, value)
  return value
}

export * as Debugpy from "./debugpy"
