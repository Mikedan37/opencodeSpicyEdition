import { describe, expect, test } from "bun:test"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { createProblemsState, filterProblems, groupProblems, problemRows, type ProblemFilter } from "./problems"

const problem = (
  id: string,
  extra: Partial<Workbench.Problem> & { kind?: Workbench.SourceKind; tool?: string; line?: number },
): Workbench.Problem => ({
  id,
  file: extra.file,
  range:
    extra.line === undefined
      ? undefined
      : { start: { line: extra.line, character: 0 }, end: { line: extra.line, character: 1 } },
  severity: extra.severity ?? "error",
  message: extra.message ?? `message ${id}`,
  code: extra.code,
  source: { kind: extra.kind ?? "typecheck", tool: extra.tool ?? "tsc", producer: "check:tsc:/repo" },
  observedAt: 1,
  stale: extra.stale ?? false,
})

const all: ProblemFilter = {
  severities: { error: true, warning: true, info: true, hint: true },
  kind: "all",
  query: "",
}

const problems = [
  problem("a", { file: "/repo/src/b.ts", severity: "warning", line: 3, kind: "linter", tool: "eslint" }),
  problem("b", { file: "/repo/src/b.ts", severity: "error", line: 9 }),
  problem("c", { file: "/repo/src/a.ts", severity: "error", line: 1, code: 2304, message: "Cannot find name 'foo'" }),
  problem("d", { severity: "error", kind: "build", tool: "cargo", message: "linker failed" }),
  problem("e", { file: "/repo/src/b.ts", severity: "error", line: 2, kind: "lsp", tool: "typescript" }),
]

describe("problems", () => {
  test("filters by severity, source kind and search text", () => {
    expect(
      filterProblems(problems, { ...all, severities: { ...all.severities, error: false } }).map((p) => p.id),
    ).toEqual(["a"])
    expect(filterProblems(problems, { ...all, kind: "lsp" }).map((p) => p.id)).toEqual(["e"])
    expect(filterProblems(problems, { ...all, query: "  FOO " }).map((p) => p.id)).toEqual(["c"])
    expect(filterProblems(problems, { ...all, query: "2304" }).map((p) => p.id)).toEqual(["c"])
    expect(filterProblems(problems, { ...all, query: "cargo" }).map((p) => p.id)).toEqual(["d"])
  })

  test("groups by file, errors first, then by line; file-less problems last", () => {
    const groups = groupProblems(problems)
    expect(groups.map((group) => [group.file, group.problems.map((p) => p.id)])).toEqual([
      ["/repo/src/a.ts", ["c"]],
      ["/repo/src/b.ts", ["e", "b", "a"]],
      [undefined, ["d"]],
    ])
  })

  test("collapsed files keep their header row only", () => {
    const rows = problemRows(groupProblems(problems), { "file:/repo/src/b.ts": true })
    expect(rows.map((row) => (row.type === "file" ? `file:${row.file ?? "-"}:${row.count}` : row.key))).toEqual([
      "file:/repo/src/a.ts:1",
      "c",
      "file:/repo/src/b.ts:3",
      "file:-:1",
      "d",
    ])
  })

  test("debounces invalidations and never overlaps refetches", async () => {
    const snapshot = (count: number): Workbench.ProblemsSnapshot => ({
      problems: problems.slice(0, count),
      counts: { error: count, warning: 0, info: 0, hint: 0 },
      producers: [],
    })
    const calls: number[] = []
    const gates: (() => void)[] = []
    const state = createProblemsState(() => {
      calls.push(calls.length)
      return new Promise((resolve) => gates.push(() => resolve(snapshot(calls.length))))
    }, 5)

    Array.from({ length: 5 }, () => state.invalidate())
    await Bun.sleep(20)
    expect(calls).toHaveLength(1)
    expect(state.state.status).toBe("loading")

    // updates while a load is in flight queue exactly one more load
    void state.refresh()
    void state.refresh()
    gates.shift()?.()
    await Bun.sleep(0)
    expect(calls).toHaveLength(2)
    gates.shift()?.()
    await Bun.sleep(0)
    expect(calls).toHaveLength(2)
    expect(state.state.status).toBe("ready")
    expect(state.state.snapshot?.problems).toHaveLength(2)

    const failing = createProblemsState(() => Promise.reject(new Error("offline")))
    await failing.refresh()
    expect(failing.state.status).toBe("error")
    state.dispose()
  })
})
