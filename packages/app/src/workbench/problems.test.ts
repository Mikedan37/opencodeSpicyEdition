import { describe, expect, test } from "bun:test"
import type { Workbench } from "@opencode-ai/schema/workbench"
import {
  crashReason,
  createProblemsState,
  filterProblems,
  groupProblems,
  problemRows,
  lastChecked,
  sourceLabel,
  type ProblemFilter,
  withLsp,
} from "./problems"

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
  source: extra.sources?.[0] ?? {
    kind: extra.kind ?? "typecheck",
    tool: extra.tool ?? "tsc",
    producer: "check:tsc:/repo",
  },
  ...(extra.sources ? { sources: extra.sources } : {}),
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

  test("DIAG-01 a merged problem lists every source; the kind filter and search match any of them", () => {
    const lsp = { kind: "lsp" as const, tool: "typescript", producer: "lsp:typescript:/repo" }
    const merged = problem("m", {
      file: "/repo/src/c.ts",
      line: 4,
      sources: [
        { kind: "typecheck", tool: "tsc", producer: "check:tsc:/repo" },
        { ...lsp, channel: "push" },
        { ...lsp, channel: "pull" },
      ],
    })
    expect(sourceLabel(merged)).toBe("tsc · LSP (push, pull)")
    expect(sourceLabel(problems[0]!)).toBe("eslint")
    expect(
      sourceLabel(
        problem("p", {
          sources: [
            { ...lsp, channel: "push" },
            { ...lsp, channel: "pull" },
          ],
        }),
      ),
    ).toBe("LSP (push, pull)")
    // `source` is the first of `sources` (tsc), yet the language-server filter and a search for its tool find it.
    expect(filterProblems([...problems, merged], { ...all, kind: "lsp" }).map((p) => p.id)).toEqual(["e", "m"])
    expect(filterProblems([...problems, merged], { ...all, query: "typescript" }).map((p) => p.id)).toEqual(["e", "m"])
  })

  test("DIAG-07 a stale problem of a failed language server carries the exit reason", () => {
    const source = { kind: "lsp" as const, tool: "clangd", producer: "lsp:clangd:/repo" }
    const producers: Workbench.ProblemsSnapshot["producers"] = [
      {
        producer: "lsp:clangd:/repo",
        kind: "lsp",
        tool: "clangd",
        state: "failed",
        reason: "exited with code 139",
        updatedAt: 1,
      },
      {
        producer: "check:tsc:/repo",
        kind: "typecheck",
        tool: "tsc",
        state: "failed",
        reason: "tsc not found",
        updatedAt: 1,
      },
    ]
    const stale = problem("s", { stale: true, sources: [source] })
    expect(crashReason(stale, producers)).toBe("exited with code 139")
    // Fresh, or stale for another reason (a checker that failed is not a crashed server), says nothing.
    expect(crashReason({ ...stale, stale: false }, producers)).toBeUndefined()
    expect(crashReason(problem("t", { stale: true }), producers)).toBeUndefined()
    expect(crashReason(stale, [{ ...producers[0]!, state: "idle" }])).toBeUndefined()
  })

  test("last checked: the newest finished report, one entry per tool; nothing while none finished", () => {
    const producer = (tool: string, state: "idle" | "running" | "failed", updatedAt: number) =>
      ({ producer: `p:${tool}:${updatedAt}`, kind: "typecheck", tool, state, updatedAt }) as const
    expect(lastChecked([])).toBeUndefined()
    expect(lastChecked([producer("tsc", "running", 9)])).toBeUndefined()
    expect(
      lastChecked([producer("tsc", "idle", 5), producer("eslint", "failed", 7), producer("tsc", "idle", 6)]),
    ).toEqual({ at: 7, tools: ["eslint", "tsc"] })
  })

  test("turning language servers on edits the project config and keeps JSONC comments", () => {
    expect(withLsp('{\n  "model": "x"\n}\n')).toBe('{\n  "model": "x",\n  "lsp": true\n}\n')
    expect(withLsp('{ "lsp": false }')).toBe('{\n  "lsp": true\n}\n')
    // JSONC: a false value flips; otherwise the key goes first, with a comma only when more follows.
    expect(withLsp('{\n  // off for now\n  "lsp": false,\n}\n')).toBe('{\n  // off for now\n  "lsp": true,\n}\n')
    expect(withLsp('{\n  // models\n  "model": "x",\n}\n')).toBe('{\n  "lsp": true,\n  // models\n  "model": "x",\n}\n')
    expect(withLsp("{ /* empty */ }")).toBe('{\n  "lsp": true /* empty */ }')
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
