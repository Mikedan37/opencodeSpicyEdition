import { createContext, createEffect, createRoot, on, onCleanup, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { Workbench } from "@opencode-ai/schema/workbench"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { LocalPTY } from "@/context/terminal"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionKey } from "@/pages/session/session-layout"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { errorText, type DebugAction } from "./client"
import { createDebugState, emptyPrefs, isLive } from "./debug"
import { DEBUG_KEYS } from "./keys"
import { DebugStartDialog } from "./debug-start"
import { useFileLineOpener } from "./open-file"
import { useWorkbench } from "./panel"

const events = {
  updated: Schema.decodeUnknownOption(Workbench.Event.DebugUpdated.data),
  output: Schema.decodeUnknownOption(Workbench.Event.DebugOutput.data),
  exited: Schema.decodeUnknownOption(Pty.Event.Exited.data),
}

function createDebug() {
  const workbench = useWorkbench()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const layout = useLayout()
  const file = useFile()
  const { sessionKey } = useSessionKey()
  const openAt = useFileLineOpener()
  const [prefs, setPrefs] = persisted(
    Persist.serverWorkspace(serverSDK().scope, workbench.directory, "workbench-debug"),
    createStore(emptyPrefs()),
  )
  const debug = createDebugState({ client: workbench.client, directory: workbench.directory, prefs: [prefs, setPrefs] })
  const [consoleFilter, setConsoleFilter] = createStore({ stdout: true, stderr: true, console: true })
  void debug.load()

  const stop = sdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: unknown }
    if (details.type === "workbench.debug.updated")
      return Option.map(events.updated(details.properties), (data) => debug.update(data.session))
    if (details.type === "workbench.debug.output")
      return Option.map(events.output(details.properties), (data) => debug.output(data.debugSessionID, data.rows))
    if (details.type === "pty.exited")
      return Option.map(events.exited(details.properties), (data) => debug.exited(data.id, data.exitCode))
  })
  onCleanup(stop)

  const fail = (title: string) => (error: unknown) =>
    showToast({ variant: "error", title, description: errorText(error) })
  const run = (action: DebugAction) => debug.control(action).catch(fail(language.t("workbench.debug.failed.control")))
  const setOwner = (owner: "idle" | "agent" | "human", id?: string) =>
    debug.setOwner(owner, id).catch(fail(language.t("workbench.debug.failed.owner")))
  const end = () => debug.stop().catch(fail(language.t("workbench.debug.failed.stop")))

  // A stop the human is driving brings its file forward in the side panel, whatever tab is in front, unless the user
  // is typing in that panel (a watch, a breakpoint condition, a comment).
  createEffect(
    on(
      // Keyed by the stop alone: taking over an agent's paused session is not a new stop.
      () => {
        const session = debug.selected()
        return session?.stop ? `${session.id}:${session.stop.at}` : undefined
      },
      (key) => {
        const session = debug.selected()
        const frame = session?.stop?.frames[0]
        if (!key || session?.owner !== "human" || typingInSidePanel()) return
        if (!frame?.file || !frame.line || !debug.relative(frame.file)) return
        openAt(frame.file, frame.line, false)
      },
      { defer: true },
    ),
  )

  // Watches run program code, so they refresh by themselves only while the human drives the session.
  createEffect(
    on(
      () => {
        const session = debug.selected()
        if (session?.state !== "stopped" || session.owner !== "human") return
        return `${debug.watchAt()}\n${debug.prefs.watches.join("\n")}`
      },
      (key) => {
        if (key) void debug.evaluateWatches()
      },
    ),
  )

  // The active file tab's path; a throwaway root keeps the layout memos from piling up per keypress.
  const activeFile = () =>
    createRoot((dispose) => {
      const tab = layout.tabs(sessionKey()).active()
      dispose()
      return tab ? file.pathFromTab(tab) : undefined
    })
  const openStart = () => {
    const path = activeFile()
    dialog.show(() => <DebugStartDialog file={path} />)
  }
  const viewers = new Map<string, () => number | undefined>()
  // F9: the line the active file's viewer shows selected (its saved selection when it is not mounted), else the paused
  // line when that file is the one paused in.
  const toggleAtCursor = () => {
    const path = activeFile()
    const viewer = path ? viewers.get(path) : undefined
    const range = path && !viewer ? (file.selectedLines(path) as SelectedLineRange | undefined) : undefined
    const session = debug.selected()
    const frame = session?.stop?.frames.find((item) => item.id === debug.frameID())
    const paused = frame?.file && debug.relative(frame.file) === path ? frame.line : undefined
    const line = viewer?.() ?? (range ? Math.min(range.start, range.end) : paused)
    if (!path || !line) return showToast({ title: language.t("workbench.debug.toggle.none") })
    void debug.toggleBreakpoint(path, line).catch(fail(language.t("workbench.debug.failed.breakpoints")))
  }

  command.register("debug", () => {
    const session = debug.selected()
    const live = !!session && isLive(session)
    const stopped = session?.state === "stopped"
    const category = language.t("workbench.debug.category")
    // Keys stay bound while hidden so they never fall through to the browser (F5 reloads the page).
    return [
      {
        id: DEBUG_KEYS.continue,
        title: language.t(live ? "workbench.debug.action.continue" : "workbench.debug.action.start"),
        category,
        keybind: "f5",
        hidden: live && !stopped,
        onSelect: () => (live ? stopped && void run("continue") : openStart()),
      },
      {
        id: DEBUG_KEYS.pause,
        title: language.t("workbench.debug.action.pause"),
        category,
        hidden: session?.state !== "running",
        onSelect: () => void run("pause"),
      },
      ...(
        [
          [DEBUG_KEYS.next, "next", "f10"],
          [DEBUG_KEYS.stepIn, "stepIn", "f11"],
          [DEBUG_KEYS.stepOut, "stepOut", "shift+f11"],
        ] as const
      ).map(([id, action, keybind]) => ({
        id,
        title: language.t(`workbench.debug.action.${action}`),
        category,
        keybind,
        hidden: !stopped,
        onSelect: () => stopped && void run(action),
      })),
      {
        id: DEBUG_KEYS.stop,
        title: language.t("workbench.debug.action.stop"),
        category,
        keybind: "shift+f5",
        hidden: !live,
        onSelect: () => live && void end(),
      },
      {
        id: DEBUG_KEYS.toggleBreakpoint,
        title: language.t("workbench.debug.action.toggleBreakpoint"),
        category,
        keybind: "f9",
        onSelect: toggleAtCursor,
      },
      {
        id: DEBUG_KEYS.show,
        title: language.t("workbench.debug.action.show"),
        category,
        onSelect: workbench.showSide,
      },
    ]
  })

  return {
    ...debug,
    run,
    setOwner,
    end,
    openStart,
    consoleFilter: { state: consoleFilter, set: setConsoleFilter },
    // Terminal snapshots of program PTYs, so the Run tab restores a terminal it unmounted.
    terminals: new Map<string, Partial<LocalPTY> & { id: string }>(),
    // The line each mounted file viewer shows selected, by project-relative path (debug-file.tsx registers them).
    viewers,
  }
}

function typingInSidePanel() {
  const element = document.activeElement
  if (!(element instanceof HTMLElement) || !element.closest("#review-panel")) return false
  return element.isContentEditable || element.matches("input, textarea, select")
}

export type DebugContextValue = ReturnType<typeof createDebug>
const DebugContext = createContext<DebugContextValue>()

export function DebugProvider(props: ParentProps) {
  return <DebugContext.Provider value={createDebug()}>{props.children}</DebugContext.Provider>
}

export function useDebug() {
  const value = useContext(DebugContext)
  if (!value) throw new Error("Debug context must be used within WorkbenchProviders")
  return value
}

// The editor gutter wraps the app-wide File component, which also renders outside session pages.
export const useDebugOptional = () => useContext(DebugContext)
