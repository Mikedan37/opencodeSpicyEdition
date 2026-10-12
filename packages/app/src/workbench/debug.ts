import { batch, untrack } from "solid-js"
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { errorText, WorkbenchRequestError, type DebugAction, type WorkbenchClient } from "./client"

export type DebugSession = Workbench.DebugSessionInfo
export type ConsoleRow = Workbench.ConsoleRow
export type Variable = typeof Workbench.VariableView.Type
export type Breakpoint = { line: number; condition?: string; hitCondition?: string; logMessage?: string }

// Saved per workspace. Breakpoints are keyed by project-relative path and sent to the server as absolute paths.
export type DebugPrefs = {
  breakpoints: Record<string, Breakpoint[]>
  // Exception filters per adapter; a missing entry means the server's default.
  exceptions: Record<string, string[]>
  watches: string[]
  history: string[]
}
export const emptyPrefs = (): DebugPrefs => ({ breakpoints: {}, exceptions: {}, watches: [], history: [] })

export const VARIABLE_PAGE = 50
// Mirrors the server's console cap (dap/console.ts); the newest rows are kept.
export const CONSOLE_BYTES = 256 * 1024
const HISTORY = 50
const DROPPED = /^… (\d+) earlier rows dropped/

// The session's capabilities list only boolean DAP capabilities, so the filters each adapter offers live here; the
// server rejects unknown ones with a message naming the real list.
export const EXCEPTION_FILTERS: Record<string, readonly string[]> = {
  debugpy: ["raised", "uncaught", "userUnhandled"],
  "lldb-dap": ["cpp_throw", "cpp_catch", "objc_throw", "objc_catch", "swift_throw", "swift_catch"],
}
// What the server sets when a start request names no filters (dap/launch.ts `defaults`, non-test programs).
const DEFAULT_EXCEPTIONS: Record<string, readonly string[]> = { debugpy: ["uncaught"] }

export const isLive = (session: DebugSession) =>
  session.state === "starting" || session.state === "running" || session.state === "stopped"
// Control commands from the human fail with 409 while the agent owns the session (an idle session is claimed).
export const humanDrives = (session: DebugSession) => session.owner === "human" || session.owner === "idle"

export type DebugConsole = {
  rows: ConsoleRow[]
  bytes: number
  // Rows dropped by the cap, here or on the server (its truncation row counts its own drops).
  dropped: number
  // Highest seq dropped here, so a late backlog cannot bring dropped rows back.
  floor: number
  backlog: "idle" | "loading" | "ready" | "failed"
}
export type VariablePage = { items: Variable[]; done: boolean; loading: boolean; error?: string }
export type WatchValue = { at: string; text: string; error: boolean; ref?: number }
export type VerifiedBreakpoint = { line: number; verified: boolean; message?: string }

const emptyConsole = (): DebugConsole => ({ rows: [], bytes: 0, dropped: 0, floor: -1, backlog: "idle" })

// Appends rows by seq (ignoring ones already held), then trims the oldest rows past the cap. Mutates `console`.
export function mergeRows(console: DebugConsole, incoming: readonly ConsoleRow[]) {
  const last = console.rows.at(-1)?.seq ?? -1
  const fresh = incoming.filter((row) => row.seq > console.floor)
  if (fresh.every((row, index) => row.seq > (index ? fresh[index - 1]!.seq : last))) console.rows.push(...fresh)
  else {
    const held = new Set(console.rows.map((row) => row.seq))
    const added = fresh.filter((row) => !held.has(row.seq) && held.add(row.seq))
    if (!added.length) return
    console.rows = [...console.rows, ...added].toSorted((a, b) => a.seq - b.seq)
    console.bytes += added.reduce((sum, row) => sum + row.text.length, 0)
    return trim(console)
  }
  console.bytes += fresh.reduce((sum, row) => sum + row.text.length, 0)
  trim(console)
}

// ponytail: counts UTF-16 units, not UTF-8 bytes like the server; the cap is approximate for non-ASCII output.
function trim(console: DebugConsole) {
  while (console.bytes > CONSOLE_BYTES && console.rows.length > 1) {
    const row = console.rows.shift()!
    console.bytes -= row.text.length
    console.floor = Math.max(console.floor, row.seq)
    const server = row.kind === "system" ? DROPPED.exec(row.text) : null
    console.dropped += server ? Number(server[1]) : 1
  }
}

// The identifier the cursor is in, for completions without a server-given range.
export function completionRange(text: string, cursor: number) {
  const word = /[A-Za-z_$][\w$]*$/.exec(text.slice(0, cursor))
  return { start: word ? cursor - word[0].length : cursor, end: cursor }
}

// Program arguments typed on one line; quotes group words.
export function splitArgs(text: string) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!)
}

// Configuration names from .vscode/launch.json (JSONC). The server resolves the chosen one itself.
// ponytail: strips comments and trailing commas only; a string holding ",}" would be mangled.
export function launchConfigurations(text: string): { name: string; type?: string }[] {
  let json = ""
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y
      end.lastIndex = index
      const match = end.exec(text)
      json += match?.[0] ?? text.slice(index)
      index += (match?.[0].length ?? text.length) - 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end - 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      index = end === -1 ? text.length : end + 1
      continue
    }
    json += char
  }
  try {
    const value = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1")) as { configurations?: unknown }
    if (!Array.isArray(value.configurations)) return []
    return value.configurations.flatMap((item: { name?: unknown; type?: unknown }) =>
      typeof item?.name === "string"
        ? [{ name: item.name, ...(typeof item.type === "string" ? { type: item.type } : {}) }]
        : [],
    )
  } catch {
    return []
  }
}

// Which adapter the server will pick (dap/launch.ts), so saved exception filters go to the right one.
export function guessAdapter(input: { program?: string; type?: string }) {
  if (input.type !== undefined) return input.type === "python" || input.type === "debugpy" ? "debugpy" : "lldb-dap"
  return input.program?.endsWith(".py") ? "debugpy" : "lldb-dap"
}

type Client = Pick<
  WorkbenchClient,
  | "debugSessions"
  | "debugStart"
  | "debugControl"
  | "debugBreakpoints"
  | "debugVariables"
  | "debugEvaluate"
  | "debugCompletions"
  | "debugOutput"
  | "debugOwner"
  | "debugStop"
>

// Debug sessions of one project from workbench.debug.* events plus the debug routes. Requests act as the human.
export function createDebugState(input: {
  client: Client
  directory: string
  prefs: [DebugPrefs, SetStoreFunction<DebugPrefs>]
}) {
  const client = input.client
  const [prefs, setPrefs] = input.prefs
  const root = input.directory.replace(/\/+$/, "")
  const [state, setState] = createStore({
    sessions: [] as DebugSession[],
    list: "idle" as "idle" | "loading" | "ready" | "unavailable" | "failed",
    selected: undefined as string | undefined,
    // Selected frame per session; reset to the top frame on every stop.
    frame: {} as Record<string, number | undefined>,
    // Child pages keyed `${session}:${stop.at}:${ref}`; references die with their stop.
    pages: {} as Record<string, VariablePage>,
    // Expanded tree nodes keyed by name path, so a step keeps the tree open.
    expanded: {} as Record<string, boolean>,
    consoles: {} as Record<string, DebugConsole>,
    watch: {} as Record<string, WatchValue>,
    verified: {} as Record<string, Record<string, VerifiedBreakpoint[]>>,
    exits: {} as Record<string, number>,
  })

  const find = (id: string | undefined) => (id ? state.sessions.find((item) => item.id === id) : undefined)
  const selected = () => find(state.selected)
  const relative = (file: string) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined)
  const absolute = (file: string) => (file.startsWith("/") ? file : `${root}/${file}`)
  const frameID = (session = selected()) => session?.stop && (state.frame[session.id] ?? session.stop.frames[0]?.id)
  const stopAt = (session: DebugSession) => `${session.id}:${session.stop?.at ?? 0}`

  // `adopt`: a session seen for the first time takes the selection unless the selected one is still running.
  function update(next: DebugSession, adopt = true) {
    const at = state.sessions.findIndex((item) => item.id === next.id)
    // Read before reconcile: the store proxy shows the new value afterwards.
    const before = state.sessions[at]?.stop?.at
    batch(() => {
      if (at === -1) setState("sessions", (list) => [next, ...list].toSorted((a, b) => b.startedAt - a.startedAt))
      else setState("sessions", at, reconcile(next))
      if (next.stop && next.stop.at !== before) {
        setState("frame", next.id, next.stop.frames[0]?.id)
        setState(
          "pages",
          produce((pages) => {
            for (const key of Object.keys(pages)) if (key.startsWith(`${next.id}:`)) delete pages[key]
          }),
        )
      }
      const current = selected()
      if (adopt && at === -1 && (!current || !isLive(current))) setState("selected", next.id)
    })
  }

  // Applies a route's reply unless an event already moved the session on (a new stop or an end).
  const settle = (id: string) => {
    const before = find(id)?.stop?.at
    return (session: DebugSession) => {
      const current = find(id)
      if (current && (!isLive(current) || current.stop?.at !== before)) return current
      update(session)
      return session
    }
  }

  function load() {
    if (state.list === "loading" || state.list === "ready") return Promise.resolve()
    setState("list", "loading")
    return client.debugSessions().then(
      (list) =>
        batch(() => {
          // Event snapshots are newer than the list, so the list only adds sessions not seen yet.
          for (const session of list) if (!find(session.id)) update(session, false)
          const current = selected()
          const pick =
            current && isLive(current) ? current : (state.sessions.find(isLive) ?? current ?? state.sessions[0])
          if (pick) setState("selected", pick.id)
          setState("list", "ready")
        }),
      (error: unknown) => setState("list", unavailable(error) ? "unavailable" : "failed"),
    )
  }

  function output(sessionID: string, rows: readonly ConsoleRow[]) {
    if (!rows.length) return
    if (!state.consoles[sessionID]) setState("consoles", sessionID, emptyConsole())
    setState(
      "consoles",
      sessionID,
      produce((draft) => mergeRows(draft, rows)),
    )
  }

  // The rows from before this view saw the session; live rows that arrived first are kept. Loaders read the store
  // untracked, so an effect that calls one does not rerun (and retry) when its request settles.
  const backlog = (sessionID: string) => untrack(() => loadBacklog(sessionID))
  function loadBacklog(sessionID: string) {
    const current = state.consoles[sessionID]?.backlog
    if (current === "loading" || current === "ready") return Promise.resolve()
    if (!state.consoles[sessionID]) setState("consoles", sessionID, emptyConsole())
    setState("consoles", sessionID, "backlog", "loading")
    return client.debugOutput(sessionID, 0).then(
      (rows) =>
        batch(() => {
          output(sessionID, rows)
          setState("consoles", sessionID, "backlog", "ready")
        }),
      () => setState("consoles", sessionID, "backlog", "failed"),
    )
  }

  function start(body: Workbench.DebugStartInput) {
    const breakpoints = Object.entries(prefs.breakpoints).flatMap(([file, list]) =>
      list.map((item) => ({ file: absolute(file), ...item })),
    )
    return client.debugStart({ ...body, ...(breakpoints.length ? { breakpoints } : {}) }).then((session) => {
      batch(() => {
        update(session)
        setState("selected", session.id)
      })
      return session
    })
  }

  const control = (action: DebugAction, id = state.selected) =>
    id ? client.debugControl(id, action).then(settle(id)) : Promise.resolve(undefined)
  // Take over (human), hand to the agent, or release (idle); the human may set any owner.
  const setOwner = (owner: "idle" | "agent" | "human", id = state.selected) =>
    id ? client.debugOwner(id, owner).then(settle(id)) : Promise.resolve(undefined)
  const stop = (id = state.selected) => (id ? client.debugStop(id).then(settle(id)) : Promise.resolve(undefined))

  function selectFrame(id: number) {
    if (state.selected) setState("frame", state.selected, id)
  }

  const pageKey = (session: DebugSession, ref: number) => `${stopAt(session)}:${ref}`
  const page = (ref: number) => {
    const session = selected()
    return session?.stop ? state.pages[pageKey(session, ref)] : undefined
  }
  // Loads the first page of a reference's children, or the next page with `more`; a failed page loads again only when
  // asked.
  const children = (ref: number, more = false) => untrack(() => loadChildren(ref, more))
  function loadChildren(ref: number, more: boolean) {
    const session = selected()
    if (!session?.stop || ref <= 0) return Promise.resolve()
    const key = pageKey(session, ref)
    const current = state.pages[key]
    if (current?.loading || current?.done || (current && !more && !current.error)) return Promise.resolve()
    const held = current?.items ?? []
    setState("pages", key, { items: held, done: false, loading: true, error: undefined })
    return client.debugVariables(session.id, ref, held.length).then(
      (items) => {
        if (state.pages[key])
          setState("pages", key, { items: [...held, ...items], done: items.length < VARIABLE_PAGE, loading: false })
      },
      (error: unknown) => {
        if (state.pages[key]) setState("pages", key, { loading: false, error: errorText(error) })
      },
    )
  }
  const expandKey = (path: readonly string[]) => `${state.selected}\u0000${path.join("\u0000")}`
  const expanded = (path: readonly string[]) => !!state.expanded[expandKey(path)]
  const toggle = (path: readonly string[]) => setState("expanded", expandKey(path), (value) => !value)

  function remember(expression: string) {
    setPrefs("history", (list) => [...list.filter((item) => item !== expression), expression].slice(-HISTORY))
  }

  // Runs program code in the selected frame; the eval and result rows also arrive as console output.
  function evaluate(expression: string) {
    const session = selected()
    if (!session) return Promise.reject(new Error("no debug session"))
    remember(expression)
    return client.debugEvaluate(session.id, expression, frameID(session)).then((row) => {
      output(session.id, [row])
      return row
    })
  }

  const completions = (text: string, column: number) => {
    const session = selected()
    if (!session) return Promise.resolve([])
    return client.debugCompletions(session.id, text, column, frameID(session))
  }

  // Watches run one after another; a newer pass (the next stop or frame) abandons an older one.
  let pass = 0
  async function evaluateWatches() {
    const session = selected()
    if (!session?.stop || session.state !== "stopped") return
    const frame = frameID(session)
    const at = `${stopAt(session)}:${frame ?? ""}`
    const run = ++pass
    for (const expression of [...prefs.watches]) {
      const value = await client.debugEvaluate(session.id, expression, frame).then(
        (row): WatchValue => ({ at, text: row.text, error: row.kind === "exception", ref: row.variablesReference }),
        (error: unknown): WatchValue => ({ at, text: errorText(error), error: true }),
      )
      if (run !== pass) return
      setState("watch", expression, value)
    }
  }
  const watchAt = () => {
    const session = selected()
    return session?.stop ? `${stopAt(session)}:${frameID(session) ?? ""}` : undefined
  }
  function addWatch(expression: string) {
    const value = expression.trim()
    if (!value || prefs.watches.includes(value)) return
    setPrefs("watches", (list) => [...list, value])
  }
  const removeWatch = (expression: string) => setPrefs("watches", (list) => list.filter((item) => item !== expression))

  const breakpoints = (file: string) => prefs.breakpoints[file] ?? []
  const verified = (file: string) => (state.selected ? state.verified[state.selected]?.[file] : undefined)

  // Pushes one file's breakpoints to every live session the human drives; rejects with the first failure.
  async function sync(file: string) {
    const body = {
      file: absolute(file),
      breakpoints: breakpoints(file).map((item) => ({ ...item })),
    }
    const targets = state.sessions.filter(
      (session) => (session.state === "running" || session.state === "stopped") && session.owner === "human",
    )
    const results = await Promise.allSettled(
      targets.map((session) =>
        client
          .debugBreakpoints(session.id, body)
          .then((result) =>
            setState("verified", session.id, (current) => ({ ...current, [file]: [...result.breakpoints] })),
          ),
      ),
    )
    const failed = results.find((result) => result.status === "rejected")
    if (failed) throw failed.reason
  }

  function setBreakpoints(file: string, list: Breakpoint[]) {
    setPrefs(
      "breakpoints",
      produce((draft) => {
        if (list.length) draft[file] = list.toSorted((a, b) => a.line - b.line)
        else delete draft[file]
      }),
    )
    return sync(file)
  }
  function toggleBreakpoint(file: string, line: number) {
    const list = breakpoints(file)
    return setBreakpoints(
      file,
      list.some((item) => item.line === line) ? list.filter((item) => item.line !== line) : [...list, { line }],
    )
  }
  function editBreakpoint(file: string, line: number, patch: Omit<Breakpoint, "line">) {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value?.trim())) as typeof patch
    return setBreakpoints(
      file,
      breakpoints(file).map((item) => (item.line === line ? { line, ...clean } : item)),
    )
  }
  const removeBreakpoint = (file: string, line: number) =>
    setBreakpoints(
      file,
      breakpoints(file).filter((item) => item.line !== line),
    )

  const exceptions = (adapter: string) => prefs.exceptions[adapter] ?? DEFAULT_EXCEPTIONS[adapter] ?? []
  async function setException(adapter: string, filter: string, on: boolean) {
    const current = exceptions(adapter)
    const next = on ? [...new Set([...current, filter])] : current.filter((item) => item !== filter)
    setPrefs("exceptions", adapter, next)
    const targets = state.sessions.filter(
      (session) =>
        session.adapter === adapter &&
        (session.state === "running" || session.state === "stopped") &&
        session.owner === "human",
    )
    const results = await Promise.allSettled(
      targets.map((session) => client.debugBreakpoints(session.id, { exceptions: next })),
    )
    const failed = results.find((result) => result.status === "rejected")
    if (failed) throw failed.reason
  }

  return {
    state,
    prefs,
    selected,
    find,
    frameID,
    relative,
    absolute,
    update,
    load,
    output,
    backlog,
    select: (id: string) => setState("selected", id),
    selectFrame,
    start,
    control,
    setOwner,
    stop,
    page,
    children,
    expanded,
    toggle,
    evaluate,
    completions,
    evaluateWatches,
    watchAt,
    addWatch,
    removeWatch,
    breakpoints,
    verified,
    toggleBreakpoint,
    editBreakpoint,
    removeBreakpoint,
    exceptions,
    setException,
    exited: (ptyID: string, code: number) => setState("exits", ptyID, code),
  }
}

export type DebugState = ReturnType<typeof createDebugState>

function unavailable(error: unknown) {
  return error instanceof WorkbenchRequestError && error.kind === "unavailable"
}
