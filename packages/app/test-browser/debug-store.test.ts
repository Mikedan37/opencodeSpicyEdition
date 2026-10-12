import { describe, expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { createDebugState, emptyPrefs } from "@/workbench/debug"

const session = (at: number) =>
  ({
    id: "dbg_one",
    adapter: "debugpy",
    state: "stopped",
    owner: "human",
    capabilities: [],
    startedAt: 1,
    stop: { reason: "step", threadID: 1, frames: [{ id: 1, name: "main" }], locals: [], at },
  }) as unknown as Workbench.DebugSessionInfo

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("debug store in effects", () => {
  test("an effect that loads a page or the backlog does not retry a failure by itself, but loads again after a stop", async () => {
    const calls = { variables: 0, output: 0 }
    // A retry loop would spin on microtasks; past a few calls the requests hang so the assertions can report it.
    const fail = (count: number) =>
      count > 3 ? new Promise<never>(() => undefined) : Promise.reject(new Error("adapter error"))
    const debug = createDebugState({
      client: {
        debugVariables: () => fail(++calls.variables),
        debugOutput: () => fail(++calls.output),
      } as unknown as Parameters<typeof createDebugState>[0]["client"],
      directory: "/repo",
      prefs: createStore(emptyPrefs()),
    })
    debug.update(session(1))
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        if (!debug.page(20)) void debug.children(20)
      })
      createEffect(() => {
        if (debug.state.selected) void debug.backlog(debug.state.selected)
      })
      return dispose
    })
    await settle()
    await settle()
    expect(debug.page(20)?.error).toBe("adapter error")
    expect(debug.state.consoles.dbg_one?.backlog).toBe("failed")
    expect(calls).toEqual({ variables: 1, output: 1 })

    // References die with their stop: the next stop loads the page again
    debug.update(session(2))
    await settle()
    expect(calls.variables).toBe(2)
    dispose()
  })
})
