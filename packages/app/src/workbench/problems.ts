import { createStore } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"

type Problem = Workbench.Problem

export const SEVERITIES = ["error", "warning", "info", "hint"] as const satisfies readonly Workbench.Severity[]
export const SOURCE_KINDS = [
  "lsp",
  "compiler",
  "typecheck",
  "linter",
  "build",
  "test",
  "runtime",
] as const satisfies readonly Workbench.SourceKind[]

export type ProblemFilter = {
  severities: Record<Workbench.Severity, boolean>
  kind: Workbench.SourceKind | "all"
  query: string
}

export type ProblemRow =
  | { type: "file"; key: string; file?: string; count: number; collapsed: boolean }
  | { type: "problem"; key: string; problem: Problem }

const RANK: Record<Workbench.Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 }

// Every producer (and language-server channel) that reported a problem; servers before DIAG-01 send only `source`.
export const sourcesOf = (problem: Problem) => (problem.sources?.length ? problem.sources : [problem.source])

// DIAG-01: one entry per tool, language servers as "LSP" with the channels that reported it: "tsc · LSP (push, pull)".
// A problem with one source keeps its tool's name.
export function sourceLabel(problem: Problem) {
  const sources = sourcesOf(problem)
  if (sources.length === 1) return sources[0]!.tool
  return [...Map.groupBy(sources, (source) => `${source.kind}\0${source.tool}`).values()]
    .map((group) => {
      const channels = [...new Set(group.flatMap((source) => (source.channel ? [source.channel] : [])))]
      const name = group[0]!.kind === "lsp" ? "LSP" : group[0]!.tool
      return channels.length ? `${name} (${channels.join(", ")})` : name
    })
    .join(" · ")
}

// DIAG-07: why a stale problem is stale when its language server crashed (the producer failed with the exit reason).
export function crashReason(problem: Problem, producers: Workbench.ProblemsSnapshot["producers"]) {
  if (!problem.stale) return
  return sourcesOf(problem)
    .filter((source) => source.kind === "lsp")
    .map((source) => producers.find((item) => item.producer === source.producer && item.state === "failed"))
    .find((item) => item?.reason)?.reason
}

// When the project was last checked and by what: the newest finished report first, one entry per tool.
export function lastChecked(producers: Workbench.ProblemsSnapshot["producers"]) {
  const done = producers.filter((item) => item.state !== "running").toSorted((a, b) => b.updatedAt - a.updatedAt)
  if (!done.length) return
  return { at: done[0]!.updatedAt, tools: [...new Set(done.map((item) => item.tool))] }
}

// A project config with "lsp": true (DIAG-12's Turn on). Plain JSON is rewritten; JSONC keeps its comments: an
// "lsp": false becomes true, else the key goes first in the object.
// ponytail: the JSONC path is a text edit, not a parser; a commented-out "lsp": false before the real key is changed.
export function withLsp(text: string) {
  const json = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  if (json && typeof json === "object" && !Array.isArray(json))
    return JSON.stringify({ ...json, lsp: true }, null, 2) + "\n"
  if (/"lsp"\s*:\s*false/.test(text)) return text.replace(/("lsp"\s*:\s*)false/, "$1true")
  const open = text.indexOf("{")
  const rest = text
    .slice(open + 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim()
  return `${text.slice(0, open + 1)}\n  "lsp": true${rest.startsWith("}") ? "" : ","}${text.slice(open + 1)}`
}

export function filterProblems(problems: readonly Problem[], filter: ProblemFilter) {
  const query = filter.query.trim().toLowerCase()
  return problems.filter((problem) => {
    const sources = sourcesOf(problem)
    return (
      filter.severities[problem.severity] &&
      (filter.kind === "all" || sources.some((source) => source.kind === filter.kind)) &&
      (!query ||
        [problem.message, problem.file ?? "", String(problem.code ?? ""), ...sources.map((source) => source.tool)].some(
          (value) => value.toLowerCase().includes(query),
        ))
    )
  })
}

// Files sorted by path (problems without a file last); inside a file, by severity then position.
export function groupProblems(problems: readonly Problem[]) {
  const groups = Map.groupBy(problems, (problem) => problem.file)
  return [...groups]
    .map(([file, list]) => ({
      file,
      problems: list.toSorted(
        (a, b) =>
          RANK[a.severity] - RANK[b.severity] ||
          (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
          (a.range?.start.character ?? 0) - (b.range?.start.character ?? 0),
      ),
    }))
    .toSorted((a, b) => {
      if (a.file === undefined) return 1
      if (b.file === undefined) return -1
      return a.file.localeCompare(b.file)
    })
}

// Flattened header + problem rows for the virtualized list.
export function problemRows(groups: ReturnType<typeof groupProblems>, collapsed: Record<string, boolean>) {
  return groups.flatMap((group): ProblemRow[] => {
    const key = `file:${group.file ?? ""}`
    const header: ProblemRow = {
      type: "file",
      key,
      file: group.file,
      count: group.problems.length,
      collapsed: !!collapsed[key],
    }
    if (collapsed[key]) return [header]
    return [header, ...group.problems.map((problem) => ({ type: "problem" as const, key: problem.id, problem }))]
  })
}

// Snapshot holder: events only invalidate; refetches are debounced and never overlap.
export function createProblemsState(load: () => Promise<Workbench.ProblemsSnapshot>, delay = 250) {
  const [state, setState] = createStore({
    snapshot: undefined as Workbench.ProblemsSnapshot | undefined,
    status: "idle" as "idle" | "loading" | "ready" | "error",
    error: undefined as unknown,
  })
  const run = { active: false, again: false }
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = (): Promise<void> => {
    if (run.active) {
      run.again = true
      return Promise.resolve()
    }
    run.active = true
    if (state.status !== "ready") setState("status", "loading")
    return load()
      .then(
        (snapshot) => setState({ snapshot, status: "ready", error: undefined }),
        (error: unknown) => setState({ status: "error", error }),
      )
      .finally(() => {
        run.active = false
        if (!run.again) return
        run.again = false
        return refresh()
      })
  }

  return {
    state,
    refresh,
    invalidate() {
      clearTimeout(timer)
      timer = setTimeout(refresh, delay)
    },
    dispose: () => clearTimeout(timer),
  }
}
