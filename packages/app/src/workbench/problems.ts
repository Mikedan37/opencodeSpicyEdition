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

export function filterProblems(problems: readonly Problem[], filter: ProblemFilter) {
  const query = filter.query.trim().toLowerCase()
  return problems.filter(
    (problem) =>
      filter.severities[problem.severity] &&
      (filter.kind === "all" || problem.source.kind === filter.kind) &&
      (!query ||
        [problem.message, problem.file ?? "", String(problem.code ?? ""), problem.source.tool].some((value) =>
          value.toLowerCase().includes(query),
        )),
  )
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
