// debugpy: find a Python that actually runs (PATH may hold dead binaries, e.g. an x86_64
// python3 on Apple silicon) and a debugpy it can import, else VS Code's bundled copy.
import fs from "fs/promises"
import os from "os"
import path from "path"
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
  "import sys, importlib.util as u",
  "try:",
  "    import debugpy; d = debugpy.__version__",
  "except Exception:",
  "    d = '-'",
  "print(sys.version.split()[0], d, int(u.find_spec('pytest') is not None))",
].join("\n")

const cache = new Map<string, Resolved>()

export async function resolve(input: {
  readonly directory: string
  readonly python?: string
}): Promise<Resolved | { error: string }> {
  const key = `${input.directory}\0${input.python ?? ""}`
  const hit = cache.get(key)
  if (hit) return hit
  const tried: string[] = []
  const runnable: { python?: string; pytest: boolean } = { pytest: false }
  for (const candidate of candidates(input.directory, input.python)) {
    if (!(await fs.stat(candidate).catch(() => undefined))?.isFile()) continue
    const result = await probe(candidate)
    tried.push(result ? `${candidate} (${result.version})` : `${candidate} (does not run)`)
    if (!result) continue
    if (result.debugpy)
      return remember(key, {
        python: candidate,
        command: [candidate, "-m", "debugpy.adapter"],
        env: {},
        debugpy: result.debugpy,
        source: "installed",
        pytest: result.pytest,
      })
    if (!runnable.python) Object.assign(runnable, { python: candidate, pytest: result.pytest })
  }
  if (!runnable.python) return { error: `no runnable Python found (tried ${tried.join(", ") || "nothing"})` }
  for (const libs of await bundles()) {
    const result = await probe(runnable.python, { PYTHONPATH: libs })
    if (result?.debugpy)
      return remember(key, {
        python: runnable.python,
        command: [runnable.python, "-m", "debugpy.adapter"],
        env: { PYTHONPATH: libs },
        debugpy: result.debugpy,
        source: "vscode",
        pytest: runnable.pytest,
      })
  }
  return {
    error: `debugpy is not available for ${runnable.python}; install it (python3 -m pip install debugpy) or the VS Code Python Debugger extension`,
  }
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
        ...dirs.flatMap((dir) => [path.join(dir, "python3"), path.join(dir, "python")]),
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
      ].filter((item): item is string => typeof item === "string"),
    ),
  ]
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
  const [version, debugpy, pytest] = out.text.trim().split(/\s+/)
  if (!version) return undefined
  return { version, debugpy: debugpy && debugpy !== "-" ? debugpy : undefined, pytest: pytest === "1" }
}

function remember(key: string, value: Resolved) {
  cache.set(key, value)
  return value
}

export * as Debugpy from "./debugpy"
