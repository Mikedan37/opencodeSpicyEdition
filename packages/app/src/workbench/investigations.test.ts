import { describe, expect, test } from "bun:test"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchRequestError } from "./client"
import { createInvestigationsState } from "./investigations"

const summary = (id: string, patch: Partial<Workbench.InvestigationSummary> = {}) =>
  ({
    id,
    title: id,
    status: "debugging",
    attempts: 0,
    evidenceCount: 0,
    updatedAt: 1,
    ...patch,
  }) as Workbench.InvestigationSummary

const detail = (id: string) =>
  ({ investigation: { id }, evidence: [], report: `report ${id}` }) as unknown as Workbench.InvestigationDetail

describe("investigations", () => {
  test("events and the list merge newest first; an older reply never replaces a newer event", async () => {
    const inv = createInvestigationsState({
      investigations: () => Promise.resolve([summary("inv_1", { updatedAt: 1 }), summary("inv_2", { updatedAt: 3 })]),
      investigation: () => Promise.reject(new Error("unused")),
      resumeInvestigation: () => Promise.resolve(summary("inv_1", { status: "reproducing", updatedAt: 2 })),
      cancelInvestigation: () => Promise.reject(new WorkbenchRequestError("failed", "already ended")),
    })
    inv.update(summary("inv_1", { status: "needs_human", updatedAt: 5 }))
    await inv.load()
    expect(inv.state.list.map((item) => [String(item.id), item.status])).toEqual([
      ["inv_1", "needs_human"],
      ["inv_2", "debugging"],
    ])
    expect(inv.waiting()).toBe(1)
    await inv.resume("inv_1")
    expect(inv.find("inv_1")?.status).toBe("needs_human")
    await expect(inv.cancel("inv_2")).rejects.toThrow("already ended")
    expect(inv.state.busy.inv_2).toBeUndefined()

    const missing = createInvestigationsState({
      investigations: () => Promise.reject(new WorkbenchRequestError("unavailable", "404")),
      investigation: () => Promise.reject(new Error("unused")),
      resumeInvestigation: () => Promise.reject(new Error("unused")),
      cancelInvestigation: () => Promise.reject(new Error("unused")),
    })
    await missing.load()
    expect(missing.state.status).toBe("unavailable")
  })

  test("the record loads once, again after a newer summary, and a failure waits for a retry", async () => {
    let calls = 0
    let failing = false
    const inv = createInvestigationsState({
      investigations: () => Promise.resolve([]),
      investigation: (id) => {
        calls++
        return failing ? Promise.reject(new WorkbenchRequestError("failed", "not found")) : Promise.resolve(detail(id))
      },
      resumeInvestigation: () => Promise.reject(new Error("unused")),
      cancelInvestigation: () => Promise.reject(new Error("unused")),
    })
    inv.update(summary("inv_1"))
    await inv.detail("inv_1")
    await inv.detail("inv_1")
    expect(calls).toBe(1)
    expect(inv.state.details.inv_1).toMatchObject({ status: "ready", stale: false })

    inv.update(summary("inv_1", { status: "verifying", updatedAt: 2 }))
    expect(inv.state.details.inv_1?.stale).toBe(true)
    failing = true
    await inv.detail("inv_1")
    expect(inv.state.details.inv_1).toMatchObject({ status: "failed", error: "not found" })
    expect(calls).toBe(2)
    failing = false
    await inv.detail("inv_1")
    expect(inv.state.details.inv_1?.status).toBe("ready")
    expect(calls).toBe(3)
  })
})
