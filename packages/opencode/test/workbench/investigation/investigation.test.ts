// Investigation service against the real JSON store: per-key locking (INV-02), restart recovery
// with real processes (INV-04), edits as patches, and resolution from recorded events (INV-13).
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Workbench } from "@opencode-ai/schema/workbench"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { Storage } from "../../../src/storage/storage"
import { WorkbenchDebug } from "../../../src/workbench/dap/service"
import { DebugSession } from "../../../src/workbench/dap/session"
import { WorkbenchInvestigation } from "../../../src/workbench/investigation/investigation"
import { DebugToolNode } from "../../../src/workbench/tool/debug"
import { disposeAllInstances, disposeAllInstancesEffect, TestInstance } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([DebugToolNode, EventV2Bridge.node, Storage.node])))
const dbg = Workbench.DebugSessionID.make("dbg_inv")

afterEach(async () => {
  await disposeAllInstances()
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("investigation service", () => {
  it.instance(
    "UX #15 a record stored with the old reason format is listed and read with rule, sentence and runs apart",
    () =>
      Effect.gen(function* () {
        const investigations = yield* WorkbenchInvestigation.Service
        const storage = yield* Storage.Service
        const test = yield* TestInstance
        const created = yield* investigations.open({ sessionID: "ses_legacy", title: "legacy reasons" })
        const stored = {
          ...(yield* storage.read<Record<string, unknown>>([
            "workbench",
            "investigation",
            created.projectID,
            created.id,
          ])),
          status: "blocked",
          checkpoints: [
            { status: "created", at: 1 },
            { status: "blocked", at: 2, reason: "S1: repair attempts used up (checks run_1, run_2, run_3)" },
          ],
        }
        yield* storage.write(["workbench", "investigation", created.projectID, created.id], stored)
        expect(test.directory).toBe(created.directory)

        const full = yield* investigations.full(created.id)
        expect(full.investigation.checkpoints.at(-1)).toEqual({
          status: "blocked",
          at: 2,
          rule: "S1",
          reason: "repair attempts used up",
          runIDs: ["run_1", "run_2", "run_3"].map((id) => Workbench.RunID.make(id)),
        })
        expect(full.report).toContain("Status: blocked (S1: repair attempts used up (checks run_1, run_2, run_3))")
        expect(yield* investigations.list()).toEqual([
          expect.objectContaining({ id: created.id, rule: "S1", reason: "repair attempts used up" }),
        ])
      }),
    { git: true },
  )

  it.instance(
    "INV-02 concurrent updates to one record lose nothing",
    () =>
      Effect.gen(function* () {
        const investigations = yield* WorkbenchInvestigation.Service
        const record = yield* investigations.open({ sessionID: "ses_inv2", title: "concurrency" })
        yield* Effect.all(
          Array.from({ length: 25 }, (_, index) =>
            investigations.note(record.id, { kind: "hypothesis", text: `note ${index}` }),
          ),
          { concurrency: "unbounded" },
        )
        yield* Effect.all(
          Array.from({ length: 25 }, () => investigations.record(record.id, { type: "debug.steps", delta: 1 })),
          { concurrency: "unbounded" },
        )
        const full = yield* investigations.full(record.id)
        expect(full.investigation.notes.map((item) => item.text).toSorted()).toEqual(
          Array.from({ length: 25 }, (_, index) => `note ${index}`).toSorted(),
        )
        expect(full.investigation.steps).toBe(25)
        // Notes are the model's inferences: no evidence, no status change.
        expect(full.investigation.evidence).toEqual([])
        expect(full.investigation.status).toBe("created")
      }),
    { git: true },
  )

  it.instance(
    "INV-04 restart while debugging: interrupted, nothing relaunched, recorded processes cleaned up",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const investigations = yield* WorkbenchInvestigation.Service
        const storage = yield* Storage.Service
        const debugging = yield* investigations.open({
          sessionID: "ses_inv4",
          title: "restart",
          target: { program: "avg.py" },
        })
        const elsewhere = yield* investigations.open({ sessionID: "ses_inv4_other", title: "owned by another process" })
        const owned = Bun.spawn(["sleep", "60"])
        const reused = Bun.spawn(["sleep", "60"])
        const other = Bun.spawn(["sleep", "60"])
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const proc of [owned, reused, other]) proc.kill()
          }),
        )
        const started = yield* Effect.promise(() => DebugSession.startTime(owned.pid))
        expect(started).toBeDefined()
        yield* investigations.record(debugging.id, { type: "debug.started", debugSessionID: dbg })
        yield* investigations.record(debugging.id, {
          type: "debug.processes",
          processes: [
            { pid: owned.pid, command: "sleep 60", startedAt: started! },
            // Same pid number but a different start time: a reused pid, never killed.
            { pid: reused.pid, command: "old process", startedAt: "Mon Jan  1 00:00:00 2001" },
          ],
        })
        yield* investigations.record(debugging.id, {
          type: "debug.stopped",
          debugSessionID: dbg,
          snapshot: { reason: "breakpoint", threadID: 1, frames: [], locals: [], at: 1 },
        })
        yield* investigations.record(elsewhere.id, { type: "debug.started", debugSessionID: dbg })
        // The second record belongs to another opencode process that is still alive.
        const otherStarted = yield* Effect.promise(() => DebugSession.startTime(other.pid))
        yield* storage.update<WorkbenchInvestigation.Draft>(
          ["workbench", "investigation", debugging.projectID, elsewhere.id],
          (draft) => {
            draft.host = { pid: other.pid, ...(otherStarted ? { startedAt: otherStarted } : {}) }
          },
        )
        expect((yield* investigations.get(debugging.id)).status).toBe("debugging")

        yield* disposeAllInstancesEffect
        const after = yield* investigations.full(debugging.id)
        expect(after.investigation.status).toBe("interrupted")
        expect(after.investigation.checkpoints.at(-1)?.reason).toBe(`the app restarted; killed ${owned.pid}`)
        yield* pollWithTimeout(
          Effect.sync(() => (alive(owned.pid) ? undefined : true)),
          "owned process survived",
        )
        expect(alive(reused.pid)).toBe(true)
        expect((yield* investigations.get(elsewhere.id)).status).toBe("reproducing")
        const debug = yield* WorkbenchDebug.Service
        expect(yield* debug.list()).toEqual([])
        expect(test.directory).toBe(after.investigation.directory)
      }),
    { git: true },
  )

  it.instance(
    "edits become patches; resolved once checks and the reproduction pass after the last patch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const investigations = yield* WorkbenchInvestigation.Service
        const events = yield* EventV2Bridge.Service
        const record = yield* investigations.open({ sessionID: "ses_inv13", title: "average crashes" })
        yield* investigations.record(record.id, { type: "debug.started", debugSessionID: dbg })
        yield* investigations.record(record.id, {
          type: "debug.stopped",
          debugSessionID: dbg,
          snapshot: {
            reason: "exception",
            threadID: 1,
            frames: [{ id: 1, name: "average", file: path.join(test.directory, "avg.py"), line: 3 }],
            locals: [{ name: "xs", value: "[]", variablesReference: 0 }],
            exception: { id: "ZeroDivisionError", description: "division by zero" },
            at: 1,
          },
        })
        const file = path.join(test.directory, "avg.py")
        yield* Effect.promise(() => Bun.write(file, "def average(xs):\n    return sum(xs) / len(xs) if xs else 0\n"))
        yield* events.publish(FileSystem.Event.Edited, { file })
        const patched = yield* pollWithTimeout(
          investigations.get(record.id).pipe(Effect.map((item) => (item.attempts.length === 1 ? item : undefined))),
          "the edit never became a patch",
        )
        expect(patched.status).toBe("patching")
        expect(patched.attempts[0]?.changes.map((item) => item.file)).toEqual([file])

        yield* investigations.record(record.id, { type: "check", passed: true, runIDs: ["run_1"], problems: [] })
        expect((yield* investigations.get(record.id)).status).toBe("verifying")
        yield* investigations.record(record.id, { type: "debug.ended", debugSessionID: dbg, exitCode: 0 })
        const done = yield* investigations.full(record.id)
        expect(done.investigation.status).toBe("resolved")
        expect(done.evidence.filter((item) => item.class === "verified").map((item) => item.kind)).toEqual([
          "check-run",
          "repro-run",
        ])
        expect(done.report).toContain("Verified")
        expect(yield* investigations.list()).toEqual([expect.objectContaining({ id: record.id, status: "resolved" })])
        // A resolved investigation never moves again.
        const cancel = yield* investigations.cancel(record.id, "late").pipe(Effect.flip)
        expect(cancel.message).toBe(`investigation ${record.id} cannot go from resolved to cancelled`)
      }),
    { git: true },
  )
})
