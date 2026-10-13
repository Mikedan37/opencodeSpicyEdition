import { describe, expect, test } from "bun:test"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { excerpt, latestRun, problemSnapshot, problemSummary, rangeText, stopSnapshot, stopSummary } from "./snapshot"

const root = "/repo"
const tsc = { kind: "typecheck", tool: "tsc", producer: "check:tsc:/repo/tsconfig.json" } as const
const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"

const problem = (patch: Partial<Workbench.Problem> = {}) =>
  ({
    id: "p1",
    file: "/repo/src/app.ts",
    range: { start: { line: 11, character: 4 }, end: { line: 11, character: 17 } },
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    code: "TS2322",
    source: { ...tsc, runID: "run_2" },
    sources: [{ ...tsc, runID: "run_2" }],
    observedAt: 1,
    stale: false,
    ...patch,
  }) as Workbench.Problem

const run = (id: string, patch: Partial<Workbench.RunInfo> = {}) =>
  ({
    id,
    kind: "check",
    unit: "/repo/tsconfig.json",
    checker: "tsc",
    command: ["tsc", "--noEmit"],
    execClass: "inert",
    status: "failed",
    startedAt: 10,
    finishedAt: 20,
    exitCode: 2,
    counts: { error: 1, warning: 0, info: 0, hint: 0 },
    ...patch,
  }) as Workbench.RunInfo

describe("snapshots", () => {
  test("ranges are 1-based; excerpts merge nearby windows and mark the problem lines", () => {
    expect(rangeText(problem().range)).toBe("12:5-12:18")
    expect(rangeText({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } })).toBe("1:1")
    expect(rangeText(undefined)).toBe("(no position)")

    const text = excerpt(source, [3, 5], 2)!
    expect(text).toBe(
      [
        "```",
        "  1 | line 1",
        "  2 | line 2",
        "> 3 | line 3",
        "  4 | line 4",
        "> 5 | line 5",
        "  6 | line 6",
        "  7 | line 7",
        "```",
      ].join("\n"),
    )
    // Far apart: two windows; the widest line number sets the gutter; a line past the end adds nothing.
    expect(excerpt(source, [1, 12, 99], 1)).toBe(
      ["```", ">  1 | line 1", "   2 | line 2", "…", "  11 | line 11", "> 12 | line 12", "  13 | line 13", "```"].join(
        "\n",
      ),
    )
    expect(excerpt("a\n````b\n", [1])).toBe(["`````", "> 1 | a", "  2 | ````b", "`````"].join("\n"))
    expect(excerpt("", [5])).toBeUndefined()
  })

  test("the latest verification run is the one that reported the problem, else the newest finished check", () => {
    const runs = [
      run("run_1", { finishedAt: 5 }),
      run("run_2", { finishedAt: 30 }),
      run("run_3", { status: "running", finishedAt: undefined, startedAt: 90 }),
      run("run_4", { kind: "repro", finishedAt: 80 }),
      run("run_5", { status: "passed", finishedAt: 50 }),
    ]
    expect(String(latestRun([problem()], runs)?.id)).toBe("run_2")
    expect(String(latestRun([problem({ source: tsc, sources: [tsc] })], runs)?.id)).toBe("run_5")
    expect(latestRun([problem()], [])).toBeUndefined()
  })

  test("one problem: every field, the lines around it and the latest run", () => {
    const text = problemSnapshot({
      root,
      file: "/repo/src/app.ts",
      problems: [
        problem({
          codeHref: "https://typescript.tv/errors/#ts2322",
          related: [
            {
              file: "/repo/src/types.ts",
              range: { start: { line: 2, character: 2 }, end: { line: 2, character: 7 } },
              message: "The expected type comes from property 'count'",
            },
          ],
        }),
      ],
      source: { text: source },
      run: run("run_2", { finishedAt: 30 }),
    })
    expect(text).toBe(
      [
        "Fix this problem.",
        "",
        "File: src/app.ts",
        "Severity: error",
        "Range: 12:5-12:18",
        "Code: TS2322 (https://typescript.tv/errors/#ts2322)",
        "Message: Type 'string' is not assignable to type 'number'.",
        "Sources: tsc (typecheck, run run_2)",
        "Related: src/types.ts:3:3-3:8: The expected type comes from property 'count'",
        "",
        'Source of src/app.ts (">" marks the problem lines):',
        "```",
        ...Array.from({ length: 21 }, (_, index) => {
          const line = index + 2
          return `${line === 12 ? ">" : " "} ${String(line).padStart(2)} | line ${line}`
        }),
        "```",
        "",
        "Latest verification run: tsc check of tsconfig.json: failed (exit code 2; 1 errors, 0 warnings; run run_2).",
      ].join("\n"),
    )
  })

  test("a file's problems: each with its sources, one excerpt, an unreadable source said as such", () => {
    const merged = problem({
      id: "p2",
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
      severity: "warning",
      code: undefined,
      message: "'x' is declared but never used.\nRemove it.",
      sources: [
        { kind: "lsp", tool: "typescript", producer: "lsp:typescript:/repo", channel: "push" },
        { kind: "lsp", tool: "typescript", producer: "lsp:typescript:/repo", channel: "pull" },
      ],
      stale: true,
    })
    const input = { root, file: "/repo/src/app.ts", problems: [problem(), merged] }
    expect(problemSnapshot({ ...input, source: { error: "Not inside the project" } })).toBe(
      [
        "Fix these 2 problems in src/app.ts.",
        "",
        [
          "Problem 1 of 2",
          "Severity: error",
          "Range: 12:5-12:18",
          "Code: TS2322",
          "Message: Type 'string' is not assignable to type 'number'.",
          "Sources: tsc (typecheck, run run_2)",
        ].join("\n"),
        "",
        [
          "Problem 2 of 2",
          "Severity: warning",
          "Range: 3:1-3:4",
          "Message: 'x' is declared but never used.",
          "  Remove it.",
          "Sources: typescript (lsp, push), typescript (lsp, pull)",
          "Stale: the file or its language server changed since this was reported",
        ].join("\n"),
        "",
        "Source of src/app.ts: not available (Not inside the project).",
        "",
        "Latest verification run: none yet.",
      ].join("\n"),
    )
    // Both problems' lines in one merged window (3 and 12 are within 10 lines of each other).
    const shown = problemSnapshot({ ...input, source: { text: source } })
    expect(shown).toContain(">  3 | line 3")
    expect(shown).toContain("> 12 | line 12")
    expect(shown).toContain("  22 | line 22\n```")
    expect(shown).not.toContain("…")
  })

  test("a stop: reason, exception, frames with file:line, the top frame's locals, the investigation", () => {
    const session = {
      id: "dbg_1",
      adapter: "debugpy",
      program: "/repo/test_avg.py",
      state: "stopped",
      owner: "agent",
      capabilities: [],
      investigationID: "inv_7",
      startedAt: 1,
      stop: {
        reason: "exception",
        description: "Paused on exception",
        threadID: 1,
        frames: [
          { id: 3, name: "average", file: "/repo/avg.py", line: 2 },
          { id: 2, name: "test_empty", file: "/repo/test_avg.py", line: 8 },
          { id: 1, name: "<frozen runpy>" },
        ],
        locals: [
          { name: "special variables", value: "", variablesReference: 9 },
          { name: "xs", type: "list", value: "[]", variablesReference: 4 },
          { name: "n", value: "0", variablesReference: 0 },
        ],
        exception: { id: "ZeroDivisionError", description: "division by zero" },
        at: 5,
      },
    } as unknown as Workbench.DebugSessionInfo
    expect(stopSnapshot({ root, session })).toBe(
      [
        "Investigate this debugger stop.",
        "",
        [
          "Program: test_avg.py (debugpy, debug session dbg_1)",
          "Reason: exception (Paused on exception)",
          "Exception: ZeroDivisionError: division by zero",
          "Investigation: inv_7",
        ].join("\n"),
        "",
        "Top frames:\n1. average at avg.py:2\n2. test_empty at test_avg.py:8\n3. <frozen runpy> at (no source)",
        "",
        "Locals of average:\n- xs: list = []\n- n = 0",
      ].join("\n"),
    )
    const plain = {
      ...session,
      investigationID: undefined,
      stop: { ...session.stop!, exception: undefined, locals: [] },
    }
    expect(stopSnapshot({ root, session: plain as Workbench.DebugSessionInfo })).toBe(
      [
        "Investigate this debugger stop.",
        "",
        "Program: test_avg.py (debugpy, debug session dbg_1)\nReason: exception (Paused on exception)",
        "",
        "Top frames:\n1. average at avg.py:2\n2. test_empty at test_avg.py:8\n3. <frozen runpy> at (no source)",
        "",
        "Locals of average:\n(none)",
      ].join("\n"),
    )
  })

  test("the message's one line: the problem with its place, a file's count, a stop's exception and frame", () => {
    expect(
      problemSummary({ root, file: "/repo/src/app.ts", problems: [problem({ message: "Bad type.\nMore." })] }),
    ).toBe("Fix the problem at src/app.ts:12: Bad type.")
    expect(problemSummary({ root, file: "/repo/src/app.ts", problems: [problem(), problem({ id: "p2" })] })).toBe(
      "Fix the 2 problems in src/app.ts.",
    )
    expect(problemSummary({ root, problems: [problem({ file: undefined, range: undefined })] })).toBe(
      "Fix this problem: Type 'string' is not assignable to type 'number'.",
    )
    const session = {
      id: "dbg_1",
      adapter: "debugpy",
      state: "stopped",
      owner: "human",
      capabilities: [],
      startedAt: 1,
      stop: {
        reason: "exception",
        threadID: 1,
        frames: [{ id: 1, name: "average", file: "/repo/avg.py", line: 8 }],
        locals: [],
        exception: { id: "ZeroDivisionError" },
        at: 2,
      },
    } as unknown as Workbench.DebugSessionInfo
    expect(stopSummary({ root, session })).toBe("Investigate the debugger stop: ZeroDivisionError at avg.py:8.")
  })
})
