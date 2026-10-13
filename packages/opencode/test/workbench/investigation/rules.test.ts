// Unit tests: transition table (INV-01), supervisor rules S1–S8 (INV-06..10), resolution (INV-13)
// and the final report (INV-14), all through the real apply()/supervise()/report() functions.
import { describe, expect, test } from "bun:test"
import path from "path"
import { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchInvestigation } from "../../../src/workbench/investigation/investigation"
import { Supervisor } from "../../../src/workbench/investigation/supervisor"

const STATUSES = Workbench.InvestigationStatus.literals

// The plan's state machine, written out pair by pair.
const ALLOWED = new Set([
  "created>reproducing",
  "reproducing>debugging",
  "reproducing>diagnosing",
  "reproducing>patching",
  "debugging>diagnosing",
  "debugging>patching",
  "diagnosing>debugging",
  "diagnosing>patching",
  "patching>verifying",
  "verifying>resolved",
  "verifying>patching",
  "blocked>needs_human",
  "interrupted>reproducing",
  "needs_human>reproducing",
  ...["created", "reproducing", "debugging", "diagnosing", "patching", "verifying"].flatMap((from) =>
    ["blocked", "needs_human", "failed", "cancelled", "interrupted"].map((to) => `${from}>${to}`),
  ),
  ...["blocked", "interrupted", "needs_human"].flatMap((from) => ["cancelled", "failed"].map((to) => `${from}>${to}`)),
])

function draft(policy?: Partial<Workbench.RecoveryPolicy>): WorkbenchInvestigation.Draft {
  return structuredClone(
    WorkbenchInvestigation.create({
      projectID: "p",
      directory: "/repo",
      sessionID: "ses_1",
      title: "average crashes for empty orders",
      policy: { ...WorkbenchInvestigation.DEFAULT_POLICY, ...policy },
      host: { pid: 1 },
      now: 0,
    }),
  ) as WorkbenchInvestigation.Draft
}

const run = (record: WorkbenchInvestigation.Draft, events: WorkbenchInvestigation.Event[], now = 1_000) =>
  events.map((event) => WorkbenchInvestigation.apply(record, event, now))

const dbg = Workbench.DebugSessionID.make("dbg_test")
const snapshot = (exception?: boolean): Workbench.StopSnapshot => ({
  reason: exception ? "exception" : "breakpoint",
  threadID: 1,
  frames: [{ id: 1, name: "average", file: "/repo/avg.py", line: 3 }],
  locals: [{ name: "xs", type: "list", value: "[]", variablesReference: 0 }],
  ...(exception ? { exception: { id: "ZeroDivisionError", description: "division by zero" } } : {}),
  at: 1,
})
const problem = (message: string, file = "/repo/avg.py") => ({ tool: "pytest", code: "E1", file, message })
const patch = (file: string, hash: string): WorkbenchInvestigation.Event => ({ type: "patch", file, hash })
const check = (
  passed: boolean,
  runIDs: string[],
  problems: ReturnType<typeof problem>[] = [],
): WorkbenchInvestigation.Event => ({
  type: "check",
  passed,
  runIDs,
  problems,
})
const debugging: WorkbenchInvestigation.Event[] = [
  { type: "debug.started", debugSessionID: dbg },
  { type: "debug.stopped", debugSessionID: dbg, snapshot: snapshot(true) },
]

describe("INV-01 transition table", () => {
  test("every pair of states: allowed transitions accepted, the rest rejected", () => {
    const wrong = STATUSES.flatMap((from) =>
      STATUSES.flatMap((to) =>
        WorkbenchInvestigation.allowed(from, to) === ALLOWED.has(`${from}>${to}`) ? [] : [`${from}>${to}`],
      ),
    )
    expect(wrong).toEqual([])
    expect(STATUSES).toHaveLength(12)
  })

  test("events move the status only along allowed edges", () => {
    const record = draft()
    run(record, debugging)
    expect(record.status).toBe("diagnosing")
    expect(record.checkpoints.map((item) => item.status)).toEqual(["created", "reproducing", "diagnosing"])
    // A passing check without any patch is evidence, not a transition.
    run(record, [check(true, ["run_1"])])
    expect(record.status).toBe("diagnosing")
  })
})

describe("supervisor", () => {
  test("INV-06 S2: same error after two patches blocks, naming both checks", () => {
    const record = draft({ maxRepairAttempts: 5 })
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "a"),
      check(false, ["run_1"], [problem("division by zero at line 3")]),
      patch("/repo/avg.py", "b"),
      check(false, ["run_2"], [problem("division by zero at line 4")]),
    ])
    expect(record.status).toBe("blocked")
    // The rule, the sentence and the runs are separate, so the UI can label and link them.
    expect(record.checkpoints.at(-1)).toMatchObject({
      rule: "S2",
      reason: "no progress: same error after 2 patches",
      runIDs: ["run_1", "run_2"],
    })
  })

  test("UX #15 the summary carries the rule, the sentence and the runs apart; agents still read one line", () => {
    const record = draft({ maxRepairAttempts: 5 })
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "a"),
      check(false, ["run_1"], [problem("division by zero at line 3")]),
      patch("/repo/avg.py", "b"),
      check(false, ["run_2"], [problem("division by zero at line 4")]),
    ])
    const evidenceID = record.checkpoints.at(-1)?.evidenceID
    expect(evidenceID).toStartWith("ev_")
    expect(WorkbenchInvestigation.summary(record)).toMatchObject({
      status: "blocked",
      rule: "S2",
      reason: "no progress: same error after 2 patches",
      runIDs: ["run_1", "run_2"],
      evidenceID,
    })
    expect(WorkbenchInvestigation.explain(record.checkpoints.at(-1))).toBe(
      "S2: no progress: same error after 2 patches (checks run_1, run_2)",
    )
  })

  test("UX #15 records written before rule and runIDs existed are read apart too", () => {
    const legacy = draft()
    legacy.status = "blocked"
    legacy.checkpoints.push(
      { status: "blocked", at: 2, reason: "S2: no progress: same error after 2 patches (checks run_a, run_b)" },
      { status: "needs_human", at: 3, reason: "S7: permission denied: debug.launch" },
    )
    expect(legacy.checkpoints.slice(-2).map(WorkbenchInvestigation.checkpoint)).toEqual([
      {
        status: "blocked",
        at: 2,
        rule: "S2",
        reason: "no progress: same error after 2 patches",
        runIDs: ["run_a", "run_b"].map((id) => Workbench.RunID.make(id)),
      },
      { status: "needs_human", at: 3, rule: "S7", reason: "permission denied: debug.launch" },
    ])
    expect(WorkbenchInvestigation.summary(legacy)).toMatchObject({
      rule: "S7",
      reason: "permission denied: debug.launch",
    })
    // A reason without a rule prefix is left alone.
    expect(WorkbenchInvestigation.checkpoint({ status: "interrupted", at: 4, reason: "the app restarted" })).toEqual({
      status: "interrupted",
      at: 4,
      reason: "the app restarted",
    })
  })

  test("INV-07 S3: an identical patch twice blocks", () => {
    const record = draft()
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "same"),
      check(false, ["run_1"], [problem("a")]),
      patch("/repo/avg.py", "same"),
    ])
    expect(record.status).toBe("blocked")
    expect(record.checkpoints.at(-1)).toMatchObject({ rule: "S3", reason: "repeated identical patch" })
  })

  test("INV-08 S4: a growing error count blocks", () => {
    const record = draft({ maxRepairAttempts: 5 })
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "a"),
      check(false, ["run_1"], [problem("one")]),
      patch("/repo/avg.py", "b"),
      check(false, ["run_2"], [problem("two"), problem("three", "/repo/b.py")]),
    ])
    expect(record.status).toBe("blocked")
    expect(record.checkpoints.at(-1)).toMatchObject({ rule: "S4", reason: "each fix adds errors (1 → 2)" })
  })

  test("S1: repair attempts used up", () => {
    const record = draft({ maxRepairAttempts: 2 })
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "a"),
      check(false, ["run_1"], [problem("one"), problem("two")]),
      patch("/repo/avg.py", "b"),
      check(false, ["run_2"], [problem("three")]),
    ])
    expect(record.status).toBe("blocked")
    expect(record.checkpoints.at(-1)).toMatchObject({
      rule: "S1",
      reason: "repair attempts used up",
      runIDs: ["run_1", "run_2"],
    })
  })

  test("INV-09 S5: the step budget hands the investigation to the user", () => {
    const record = draft({ maxDebugSteps: 200 })
    run(record, [...debugging, { type: "debug.steps", delta: 199 }])
    expect(record.status).toBe("diagnosing")
    run(record, [{ type: "debug.steps", delta: 1 }])
    expect(record.status).toBe("needs_human")
    expect(record.checkpoints.at(-1)).toMatchObject({
      rule: "S5",
      reason: "debug step budget of 200 used; the program stays paused",
    })
  })

  test("INV-10 S6: the duration limit hands the investigation to the user", () => {
    const record = draft()
    run(record, debugging, 1_000)
    run(record, [{ type: "debug.steps", delta: 1 }], 1_800_000)
    expect(record.status).toBe("needs_human")
    expect(record.checkpoints.at(-1)).toMatchObject({ rule: "S6", reason: "investigation reached its 30 minute limit" })
  })

  test("S7: a permission denial hands it to the user; S8: two adapter crashes fail it", () => {
    const denied = draft()
    run(denied, [...debugging, { type: "permission.denied", permission: "debug.evaluate" }])
    expect(denied.status).toBe("needs_human")
    expect(denied.checkpoints.at(-1)).toMatchObject({ rule: "S7", reason: "permission denied: debug.evaluate" })
    const crashed = draft()
    run(crashed, [...debugging, { type: "debug.crashed", debugSessionID: dbg, error: "exit 3" }])
    expect(crashed.status).toBe("diagnosing")
    run(crashed, [{ type: "debug.crashed", debugSessionID: dbg, error: "exit 3" }])
    expect(crashed.status).toBe("failed")
    expect(crashed.checkpoints.at(-1)).toMatchObject({
      rule: "S8",
      reason: "debugger unstable: the debug adapter crashed twice",
    })
  })

  test("fingerprints normalize numbers and whitespace", () => {
    expect(Supervisor.fingerprint(problem("division  by zero at line 3"))).toBe(
      Supervisor.fingerprint(problem("division by zero at line 42")),
    )
    expect(Supervisor.fingerprint(problem("x"))).not.toBe(Supervisor.fingerprint(problem("x", "/repo/b.py")))
  })
})

describe("INV-12/13 resolution", () => {
  test("resolved only when the reproduction and the checks pass after the last patch", () => {
    const record = draft()
    // A repro that passed before the latest patch does not count.
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "a"),
      { type: "repro", passed: true, summary: "avg.py exits 0" },
      patch("/repo/avg.py", "b"),
      check(true, ["run_2"]),
    ])
    expect(record.status).toBe("verifying")
    run(record, [{ type: "debug.ended", debugSessionID: dbg, exitCode: 0 }])
    expect(record.status).toBe("resolved")
    expect(record.checkpoints.at(-1)?.reason).toBe("the reproduction and the checks passed after the last patch")
  })

  test("a failing reproduction never resolves; checks alone never resolve", () => {
    const record = draft()
    run(record, [
      ...debugging,
      patch("/repo/avg.py", "a"),
      check(true, ["run_1"]),
      { type: "debug.ended", debugSessionID: dbg, exitCode: 1 },
    ])
    expect(record.status).toBe("verifying")
    expect(WorkbenchInvestigation.allowed("diagnosing", "resolved")).toBe(false)
    expect(WorkbenchInvestigation.allowed("patching", "resolved")).toBe(false)
  })

  test("evidence classes come from the server: verified only after the last patch", () => {
    const record = draft()
    const evidence = run(record, [
      ...debugging,
      check(true, ["run_0"]),
      patch("/repo/avg.py", "a"),
      check(true, ["run_1"]),
      { type: "repro", passed: true, summary: "avg.py exits 0" },
    ]).filter((item) => item !== undefined)
    expect(evidence.map((item) => [item.kind, item.class])).toEqual([
      ["exception", "observed"],
      ["check-run", "observed"],
      ["patch", "observed"],
      ["check-run", "verified"],
      ["repro-run", "verified"],
    ])
  })
})

describe("INV-14 final report", () => {
  test("lists observed, inferred, verified and unverified items with IDs (golden file)", async () => {
    const evidence = (id: string, kind: Workbench.Evidence["kind"], cls: "observed" | "verified", summary: string) => ({
      id: Workbench.EvidenceID.make(id),
      kind,
      class: cls,
      summary,
      at: 1,
    })
    const items: Workbench.Evidence[] = [
      evidence("ev_1", "exception", "observed", "ZeroDivisionError: division by zero at /repo/avg.py:3 in average"),
      evidence("ev_2", "patch", "observed", "edited /repo/avg.py"),
      evidence("ev_3", "check-run", "verified", "checks passed (run_1)"),
      evidence("ev_4", "repro-run", "verified", "program run under the debugger exited with code 0"),
    ]
    const record: WorkbenchInvestigation.Info = {
      ...WorkbenchInvestigation.create({
        projectID: "p",
        directory: "/repo",
        sessionID: "ses_1",
        title: "average crashes for empty orders",
        host: { pid: 1 },
        now: 0,
      }),
      id: Workbench.InvestigationID.make("inv_golden"),
      status: "resolved",
      checkpoints: [
        { status: "created", at: 0 },
        { status: "resolved", at: 5, reason: "the reproduction and the checks passed after the last patch" },
      ],
      attempts: [
        {
          n: 1,
          patchHash: "h",
          changes: [{ file: "/repo/avg.py", hash: "a" }],
          errorFingerprints: [],
          errorCount: 0,
          checkIDs: ["run_1"],
          passed: true,
          at: 2,
        },
      ],
      notes: [
        { kind: "hypothesis", text: "average() divides by len(xs) without checking for an empty list", at: 1 },
        { kind: "question", text: "should an empty order average to 0 or be skipped?", at: 2 },
      ],
      evidence: items.map((item) => item.id),
      steps: 3,
      seq: 5,
      lastPatch: 2,
      checkPassed: 3,
      reproPassed: 4,
      unverified: ["/repo/report.py"],
    }
    const golden = await Bun.file(path.join(import.meta.dir, "report.golden.txt")).text()
    expect(WorkbenchInvestigation.report(record, items) + "\n").toBe(golden)
  })
})
