// Boot-time recovery: when the investigation service starts, every project's active records whose owner is gone
// become interrupted, before any project is opened. A recorded orphan is killed only when its pid and start time
// still match; a reused pid and the records of a live owner are left alone. The "orphans" are plain sleep processes.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Storage } from "../../../src/storage/storage"
import { DebugSession } from "../../../src/workbench/dap/session"
import { WorkbenchInvestigation } from "../../../src/workbench/investigation/investigation"
import { pollWithTimeout, testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(Storage.node))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const spawn = () =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.spawn(["sleep", "60"])),
    (proc) => Effect.sync(() => proc.kill()),
  )

describe("investigation boot recovery", () => {
  it.live("marks orphaned work interrupted and kills only processes whose start time still matches", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const project = `boot-${crypto.randomUUID()}`
      const orphan = yield* spawn()
      const reused = yield* spawn()
      const owner = yield* spawn()
      const started = yield* Effect.promise(() => DebugSession.startTime(orphan.pid))
      const ownerStarted = yield* Effect.promise(() => DebugSession.startTime(owner.pid))
      expect(started).toBeDefined()
      const record = (
        title: string,
        host: WorkbenchInvestigation.Info["host"],
        processes: WorkbenchInvestigation.Info["processes"],
      ) => ({
        ...WorkbenchInvestigation.create({
          projectID: project,
          directory: "/repo",
          sessionID: "ses_boot",
          title,
          host,
          now: Date.now(),
        }),
        status: "debugging" as const,
        processes,
      })
      // An opencode process that is gone (no such pid) left a debuggee running, plus a pid that was reused since.
      const abandoned = record("abandoned", { pid: 999_999, startedAt: "Mon Jan  1 00:00:00 2001" }, [
        { pid: orphan.pid, command: "sleep 60", startedAt: started! },
        { pid: reused.pid, command: "old debuggee", startedAt: "Mon Jan  1 00:00:00 2001" },
      ])
      // Another opencode process that is still running owns this one.
      const live = record("live owner", { pid: owner.pid, ...(ownerStarted ? { startedAt: ownerStarted } : {}) }, [])
      for (const item of [abandoned, live]) yield* storage.write(["workbench", "investigation", project, item.id], item)

      // Starting the service is the boot: nothing else is called.
      yield* Effect.gen(function* () {
        yield* WorkbenchInvestigation.Service
        const read = (id: string) =>
          storage.read<WorkbenchInvestigation.Info>(["workbench", "investigation", project, id])
        const recovered = yield* pollWithTimeout(
          read(abandoned.id).pipe(Effect.map((item) => (item.status === "interrupted" ? item : undefined))),
          "boot recovery never ran",
        )
        expect(recovered.checkpoints.at(-1)?.reason).toBe(`the app restarted; killed ${orphan.pid}`)
        yield* pollWithTimeout(
          Effect.sync(() => (alive(orphan.pid) ? undefined : true)),
          "the orphan survived",
        )
        expect(alive(reused.pid)).toBe(true)
        expect((yield* read(live.id)).status).toBe("debugging")
      }).pipe(Effect.provide(LayerNode.compile(WorkbenchInvestigation.node)))
    }),
  )
})
