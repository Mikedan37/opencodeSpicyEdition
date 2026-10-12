import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createEditorStore, guardUnload } from "@/workbench/editor"

function target() {
  const listeners = new Set<EventListener>()
  const calls: string[] = []
  return {
    calls,
    listeners,
    addEventListener: (type: string, listener: EventListener) => {
      calls.push(`add ${type}`)
      listeners.add(listener)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      calls.push(`remove ${type}`)
      listeners.delete(listener)
    },
  }
}

describe("editor unload guard", () => {
  test("a beforeunload handler is registered while any buffer is dirty, and removed when none is", async () => {
    const files: Record<string, string> = { "a.ts": "a\n", "b.ts": "b\n" }
    const store = createEditorStore({
      readFile: async (path) => ({ content: files[path]!, hash: `h:${files[path]}` }),
      writeFile: async (input) => ({ hash: `h:${input.content}` }),
    })
    const page = target()
    const dispose = createRoot((dispose) => {
      guardUnload(store.anyDirty, page as unknown as Window)
      return dispose
    })
    await store.load("a.ts")
    await store.load("b.ts")
    expect(page.calls).toEqual([])

    store.setDirty("a.ts", true)
    store.setDirty("b.ts", true)
    expect(page.calls).toEqual(["add beforeunload"])

    // The handler asks: the browser shows its leave-page confirmation for a cancelled beforeunload.
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent
    for (const listener of page.listeners) listener(event)
    expect(event.defaultPrevented).toBe(true)

    // Still one dirty buffer: still asking.
    expect(await store.save("a.ts", "a2\n")).toBe("saved")
    store.setDirty("a.ts", false)
    expect(page.calls).toEqual(["add beforeunload"])

    store.discard("b.ts")
    expect(page.calls).toEqual(["add beforeunload", "remove beforeunload"])
    expect(page.listeners.size).toBe(0)

    store.setDirty("a.ts", true)
    dispose()
    expect(page.calls).toEqual(["add beforeunload", "remove beforeunload", "add beforeunload", "remove beforeunload"])
  })
})
