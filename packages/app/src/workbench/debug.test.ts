import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchRequestError } from "./client"
import {
  completionRange,
  CONSOLE_BYTES,
  createDebugState,
  emptyPrefs,
  guessAdapter,
  launchConfigurations,
  mergeRows,
  splitArgs,
  type DebugConsole,
  type DebugSession,
} from "./debug"

const session = (id: string, patch: Partial<DebugSession> = {}): DebugSession =>
  ({
    id,
    adapter: "debugpy",
    program: "/repo/app.py",
    state: "running",
    owner: "human",
    capabilities: [],
    startedAt: Number(id.replace(/\D/g, "")) || 1,
    ...patch,
  }) as DebugSession

const stop = (at: number, frames = [{ id: 7, name: "main", file: "/repo/app.py", line: 3 }]) =>
  ({ reason: "breakpoint", threadID: 1, frames, locals: [], at }) as unknown as Workbench.StopSnapshot

const row = (seq: number, text = `row ${seq}`, kind: Workbench.ConsoleRow["kind"] = "stdout") =>
  ({ seq, at: seq, kind, by: kind === "stdout" ? "program" : "system", text }) as Workbench.ConsoleRow

function setup(overrides: Record<string, (...args: any[]) => Promise<unknown>> = {}) {
  const calls: { name: string; args: unknown[] }[] = []
  const stub =
    (name: string, value: (...args: any[]) => unknown = () => undefined) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return (overrides[name] ?? ((...rest: unknown[]) => Promise.resolve(value(...rest))))(...args)
    }
  const client = {
    debugSessions: stub("debugSessions", () => []),
    debugStart: stub("debugStart", () => session("dbg_9")),
    debugControl: stub("debugControl", (id: string) => session(id)),
    debugBreakpoints: stub("debugBreakpoints", (_id: string, body: { breakpoints?: { line: number }[] }) => ({
      breakpoints: (body.breakpoints ?? []).map((item) => ({ line: item.line, verified: item.line !== 99 })),
    })),
    debugVariables: stub("debugVariables", () => []),
    debugEvaluate: stub("debugEvaluate", (_id: string, expression: string) =>
      row(100, `value of ${expression}`, "result"),
    ),
    debugCompletions: stub("debugCompletions", () => []),
    debugOutput: stub("debugOutput", () => []),
    debugOwner: stub("debugOwner", (id: string) => session(id)),
    debugStop: stub("debugStop", (id: string) => session(id, { state: "terminated" })),
  } as unknown as Parameters<typeof createDebugState>[0]["client"]
  const debug = createDebugState({ client, directory: "/repo/", prefs: createStore(emptyPrefs()) })
  return { debug, calls }
}

describe("debug sessions", () => {
  test("events keep sessions newest first; a new session takes the selection only when the selected one ended", () => {
    const { debug } = setup()
    debug.update(session("dbg_1"))
    expect(debug.state.selected).toBe("dbg_1")
    debug.update(session("dbg_2"))
    expect(debug.state.sessions.map((item) => String(item.id))).toEqual(["dbg_2", "dbg_1"])
    expect(debug.state.selected).toBe("dbg_1")
    debug.update(session("dbg_1", { state: "terminated" }))
    debug.update(session("dbg_3"))
    expect(debug.state.selected).toBe("dbg_3")
  })

  test("a new stop selects the top frame and drops variable pages of the previous stop", async () => {
    const { debug, calls } = setup({
      debugVariables: () =>
        Promise.resolve(
          Array.from({ length: 50 }, (_, index) => ({ name: `v${index}`, value: "1", variablesReference: 0 })),
        ),
    })
    debug.update(session("dbg_1", { state: "stopped", stop: stop(1) }))
    debug.selectFrame(8)
    await debug.children(5)
    expect(debug.page(5)).toMatchObject({ done: false, loading: false })
    await debug.children(5, true)
    expect(debug.page(5)?.items).toHaveLength(100)
    expect(calls.filter((call) => call.name === "debugVariables").map((call) => call.args)).toEqual([
      ["dbg_1", 5, 0],
      ["dbg_1", 5, 50],
    ])

    debug.update(
      session("dbg_1", { state: "stopped", stop: stop(2, [{ id: 9, name: "f", file: "/repo/b.py", line: 1 }]) }),
    )
    expect(debug.frameID()).toBe(9)
    expect(debug.page(5)).toBeUndefined()
    expect(Object.keys(debug.state.pages)).toEqual([])
  })

  test("a control reply does not undo a stop that arrived first; an ended session stays ended", async () => {
    let release!: (value: DebugSession) => void
    const { debug } = setup({ debugControl: () => new Promise<DebugSession>((resolve) => (release = resolve)) })
    debug.update(session("dbg_1", { state: "stopped", stop: stop(1) }))
    const pending = debug.control("next")
    debug.update(session("dbg_1", { state: "stopped", stop: stop(2) }))
    release(session("dbg_1", { state: "running" }))
    await pending
    expect(debug.selected()).toMatchObject({ state: "stopped", stop: { at: 2 } })

    const { debug: other } = setup()
    other.update(session("dbg_1", { state: "stopped", stop: stop(1) }))
    await other.control("continue")
    expect(other.selected()?.state).toBe("running")
  })

  test("the list adds unseen sessions and selects the newest live one", async () => {
    const { debug } = setup({
      debugSessions: () =>
        Promise.resolve([
          session("dbg_1", { state: "terminated" }),
          session("dbg_2"),
          session("dbg_3", { state: "terminated" }),
        ]),
    })
    debug.update(session("dbg_3", { state: "failed", error: "boom" }))
    await debug.load()
    expect(debug.state.sessions.map((item) => [String(item.id), item.state])).toEqual([
      ["dbg_3", "failed"],
      ["dbg_2", "running"],
      ["dbg_1", "terminated"],
    ])
    expect(debug.state.selected).toBe("dbg_2")

    const missing = setup({
      debugSessions: () => Promise.reject(new WorkbenchRequestError("unavailable", "/workbench/debug/sessions: 404")),
    })
    await missing.debug.load()
    expect(missing.debug.state.list).toBe("unavailable")
  })
})

describe("debug console", () => {
  test("rows merge by seq; a late backlog fills in before live rows", () => {
    const console: DebugConsole = { rows: [], bytes: 0, dropped: 0, floor: -1, backlog: "idle" }
    mergeRows(console, [row(5), row(6)])
    mergeRows(console, [row(6), row(7)])
    mergeRows(console, [row(2, "… 1 earlier rows dropped (256 KB output cap)", "system"), row(3), row(4), row(5)])
    expect(console.rows.map((item) => item.seq)).toEqual([2, 3, 4, 5, 6, 7])
  })

  test("the cap drops the oldest rows and counts the server's own drops", () => {
    const console: DebugConsole = { rows: [], bytes: 0, dropped: 0, floor: -1, backlog: "idle" }
    const big = "x".repeat(CONSOLE_BYTES / 2)
    mergeRows(console, [row(1, "… 40 earlier rows dropped (256 KB output cap)", "system"), row(2, big), row(3, big)])
    expect(console.rows.map((item) => item.seq)).toEqual([2, 3])
    mergeRows(console, [row(4, big)])
    expect(console.rows.map((item) => item.seq)).toEqual([3, 4])
    expect(console.dropped).toBe(41)
    mergeRows(console, [row(2, "late backlog copy")])
    expect(console.rows.map((item) => item.seq)).toEqual([3, 4])
  })

  test("backlog loads once and keeps live rows; evaluate records history and shows its result", async () => {
    const { debug, calls } = setup({ debugOutput: () => Promise.resolve([row(1), row(2)]) })
    debug.update(session("dbg_1", { state: "stopped", stop: stop(1) }))
    debug.output("dbg_1", [row(3)])
    await debug.backlog("dbg_1")
    await debug.backlog("dbg_1")
    expect(debug.state.consoles.dbg_1?.rows.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(calls.filter((call) => call.name === "debugOutput")).toHaveLength(1)

    await debug.evaluate("len(items)")
    await debug.evaluate("x")
    await debug.evaluate("len(items)")
    expect(debug.prefs.history).toEqual(["x", "len(items)"])
    expect(calls.find((call) => call.name === "debugEvaluate")?.args).toEqual(["dbg_1", "len(items)", 7])
    expect(debug.state.consoles.dbg_1?.rows.at(-1)).toMatchObject({ seq: 100, kind: "result" })
  })

  test("completion range covers the identifier before the cursor", () => {
    expect(completionRange("print(obj.att", 13)).toEqual({ start: 10, end: 13 })
    expect(completionRange("x + ", 4)).toEqual({ start: 4, end: 4 })
  })
})

describe("breakpoints, exceptions and watches", () => {
  test("toggling saves sorted breakpoints and syncs absolute paths to running sessions the human drives", async () => {
    const { debug, calls } = setup()
    debug.update(session("dbg_1", { state: "stopped", stop: stop(1) }))
    debug.update(session("dbg_2", { owner: "agent" }))
    debug.update(session("dbg_3", { state: "terminated" }))
    await debug.toggleBreakpoint("src/app.py", 12)
    await debug.toggleBreakpoint("src/app.py", 99)
    await debug.toggleBreakpoint("src/app.py", 4)
    expect(debug.breakpoints("src/app.py").map((item) => item.line)).toEqual([4, 12, 99])
    const sent = calls.filter((call) => call.name === "debugBreakpoints")
    expect(sent.map((call) => call.args[0])).toEqual(["dbg_1", "dbg_1", "dbg_1"])
    expect(sent.at(-1)?.args[1]).toEqual({
      file: "/repo/src/app.py",
      breakpoints: [{ line: 4 }, { line: 12 }, { line: 99 }],
    })
    expect(debug.verified("src/app.py")?.find((item) => item.line === 99)?.verified).toBe(false)

    await debug.editBreakpoint("src/app.py", 12, { condition: "x > 2", logMessage: "  " })
    expect(debug.breakpoints("src/app.py")[1]).toEqual({ line: 12, condition: "x > 2" })
    await debug.toggleBreakpoint("src/app.py", 4)
    await debug.removeBreakpoint("src/app.py", 12)
    await debug.removeBreakpoint("src/app.py", 99)
    expect(debug.prefs.breakpoints).toEqual({})
  })

  test("a refused sync rejects with the server's error but keeps the edit", async () => {
    const { debug } = setup({
      debugBreakpoints: () =>
        Promise.reject(new WorkbenchRequestError("failed", "debugpy does not support log points")),
    })
    debug.update(session("dbg_1"))
    await expect(debug.toggleBreakpoint("a.py", 1)).rejects.toThrow("debugpy does not support log points")
    expect(debug.breakpoints("a.py")).toEqual([{ line: 1 }])
  })

  test("start sends every saved breakpoint as an absolute path", async () => {
    const { debug, calls } = setup()
    await debug.toggleBreakpoint("a.py", 3)
    await debug.toggleBreakpoint("/elsewhere/b.py", 8)
    await debug.start({ program: "a.py" })
    expect(calls.find((call) => call.name === "debugStart")?.args[0]).toEqual({
      program: "a.py",
      breakpoints: [
        { file: "/repo/a.py", line: 3 },
        { file: "/elsewhere/b.py", line: 8 },
      ],
    })
    expect(debug.state.selected).toBe("dbg_9")
  })

  test("exception filters start from the server default and are pushed to sessions of that adapter", async () => {
    const { debug, calls } = setup()
    debug.update(session("dbg_1"))
    debug.update(session("dbg_2", { adapter: "lldb-dap" }))
    expect(debug.exceptions("debugpy")).toEqual(["uncaught"])
    await debug.setException("debugpy", "raised", true)
    expect(debug.exceptions("debugpy")).toEqual(["uncaught", "raised"])
    expect(calls.filter((call) => call.name === "debugBreakpoints").map((call) => call.args)).toEqual([
      ["dbg_1", { exceptions: ["uncaught", "raised"] }],
    ])
  })

  test("watches evaluate in the selected frame; a newer pass wins", async () => {
    const { debug, calls } = setup({
      debugEvaluate: (_id: string, expression: string) =>
        expression === "boom"
          ? Promise.resolve(row(1, "NameError: boom", "exception"))
          : Promise.resolve({ ...row(2, `= ${expression}`, "result"), variablesReference: 4 }),
    })
    debug.addWatch(" total ")
    debug.addWatch("total")
    debug.addWatch("boom")
    expect(debug.prefs.watches).toEqual(["total", "boom"])
    await debug.evaluateWatches()
    expect(calls).toHaveLength(0)

    debug.update(session("dbg_1", { state: "stopped", stop: stop(1) }))
    debug.selectFrame(3)
    await debug.evaluateWatches()
    expect(debug.state.watch.total).toEqual({ at: "dbg_1:1:3", text: "= total", error: false, ref: 4 })
    expect(debug.state.watch.boom).toMatchObject({ error: true, text: "NameError: boom" })
    expect(debug.watchAt()).toBe("dbg_1:1:3")
    debug.removeWatch("boom")
    expect(debug.prefs.watches).toEqual(["total"])
  })
})

describe("start dialog helpers", () => {
  test("launch.json is read as JSONC; only named configurations count", () => {
    const text = `{
      // Use IntelliSense to learn about possible attributes.
      "version": "0.2.0",
      "configurations": [
        { "name": "Current file", "type": "debugpy", "program": "\${file}", /* inline */ "console": "integratedTerminal", },
        { "name": "URL // not a comment", "type": "lldb-dap", "args": ["a \\"quoted\\" b"] },
        { "type": "python" },
      ],
    }`
    expect(launchConfigurations(text)).toEqual([
      { name: "Current file", type: "debugpy" },
      { name: "URL // not a comment", type: "lldb-dap" },
    ])
    expect(launchConfigurations("{ not json")).toEqual([])
    expect(launchConfigurations('{"configurations": 3}')).toEqual([])
  })

  test("arguments split on spaces outside quotes; the adapter follows the server's rule", () => {
    expect(splitArgs(` --name "Ada Lovelace" 'x y'  3 `)).toEqual(["--name", "Ada Lovelace", "x y", "3"])
    expect(guessAdapter({ program: "src/app.py" })).toBe("debugpy")
    expect(guessAdapter({ program: "target/debug/app" })).toBe("lldb-dap")
    expect(guessAdapter({ type: "python" })).toBe("debugpy")
    expect(guessAdapter({ type: "lldb" })).toBe("lldb-dap")
  })
})
