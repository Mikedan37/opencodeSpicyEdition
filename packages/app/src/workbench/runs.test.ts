import { describe, expect, test } from "bun:test"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchRequestError } from "./client"
import { createRunsState, needsDetail } from "./runs"

const run = (id: string, status: Workbench.RunStatus, startedAt?: number): Workbench.RunInfo =>
  ({
    id,
    kind: "check",
    unit: "/repo/tsconfig.json",
    checker: "tsc",
    command: ["tsc", "--noEmit"],
    execClass: "inert",
    status,
    startedAt,
  }) as unknown as Workbench.RunInfo

const missing = () => Promise.reject(new WorkbenchRequestError("unavailable", "/workbench/runs: 404"))

describe("runs", () => {
  test("a live run streams its chunks in order; duplicates are ignored and a gap asks for the server copy", () => {
    const runs = createRunsState({ runs: missing, run: missing, check: missing })
    runs.update(run("run_1", "running", 1))
    runs.output({ runID: "run_1", seq: 0, chunk: "a.ts(1,1): error\n" })
    runs.output({ runID: "run_1", seq: 0, chunk: "duplicate\n" })
    runs.output({ runID: "run_1", seq: 1, chunk: "done\n" })
    expect(runs.state.runs[0]).toMatchObject({ output: "a.ts(1,1): error\ndone\n", gap: false, live: true })
    expect(needsDetail(runs.state.runs[0]!)).toBe(false)

    runs.output({ runID: "run_1", seq: 3, chunk: "late\n" })
    expect(runs.state.runs[0]?.gap).toBe(true)
    expect(needsDetail(runs.state.runs[0]!)).toBe(false)
    runs.update({ ...run("run_1", "failed", 1), exitCode: 2, finishedAt: 5 })
    expect(runs.state.runs[0]).toMatchObject({ detail: "none", info: { status: "failed", exitCode: 2 } })
    expect(needsDetail(runs.state.runs[0]!)).toBe(true)
  })

  test("output for runs not seen starting is not streamed; history and detail fill it in", async () => {
    const details: string[] = []
    const runs = createRunsState({
      runs: () =>
        Promise.resolve([run("run_old", "passed", 1), run("run_live", "running", 3), run("run_mid", "failed", 2)]),
      run: (id) => {
        details.push(id)
        return Promise.resolve({ run: { ...run(id, "passed", 1), exitCode: 0 }, output: "all good\n" })
      },
      check: missing,
    })
    runs.update(run("run_live", "running", 3))
    await runs.load()
    expect(runs.state.history).toBe("ready")
    expect(runs.state.runs.map((entry) => entry.info.id as string)).toEqual(["run_live", "run_mid", "run_old"])

    runs.output({ runID: "run_old", seq: 0, chunk: "ignored" })
    expect(runs.state.runs[2]?.output).toBe("")
    expect(needsDetail(runs.state.runs[2]!)).toBe(true)
    await runs.detail("run_old")
    expect(details).toEqual(["run_old"])
    expect(runs.state.runs[2]).toMatchObject({ output: "all good\n", detail: "loaded", info: { exitCode: 0 } })
  })

  test("without the runs routes the tab still works from events", async () => {
    const calls: string[] = []
    const runs = createRunsState({
      runs: missing,
      run: (id) => {
        calls.push(id)
        return missing()
      },
      check: missing,
    })
    await runs.load()
    expect(runs.state.history).toBe("unavailable")
    runs.update(run("run_1", "skipped"))
    await runs.detail("run_1")
    expect(calls).toEqual([])
    await expect(runs.check()).rejects.toThrow("404")
    expect(runs.state.checking).toBe(false)
  })

  test("a check keeps its report and never overlaps", async () => {
    const gate = { open: () => {} }
    const report = { id: "vr_1", summary: { passed: 1, failed: 0, skipped: 0, unavailable: 0, timedOut: 0 } }
    const calls: unknown[] = []
    const runs = createRunsState({
      runs: missing,
      run: missing,
      check: (input) => {
        calls.push(input)
        return new Promise((resolve) => (gate.open = () => resolve(report as unknown as Workbench.VerificationReport)))
      },
    })
    const first = runs.check({ files: ["/repo/a.ts"] })
    void runs.check()
    expect(runs.state.checking).toBe(true)
    gate.open()
    await first
    expect(calls).toEqual([{ files: ["/repo/a.ts"] }])
    expect(runs.state.report?.id).toBe("vr_1")
    expect(runs.state.checking).toBe(false)
  })
})
