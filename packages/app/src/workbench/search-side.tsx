// The side panel's Search tab: project-wide search and replace. The state lives in SearchProvider (pages/session.tsx)
// so results survive switching tabs and Cmd/Ctrl+Shift+F works with the panel closed; the panel UI is
// search-panel.tsx. Replaces go through PUT /workbench/file with the hash each file had when it was searched, so a file
// changed since is refused (409) and skipped, never overwritten; files with unsaved edits in the editor are skipped.
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  lazy,
  on,
  onCleanup,
  runWithOwner,
  Show,
  Suspense,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Tabs } from "@opencode-ai/ui/tabs"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSessionKey } from "@/pages/session/session-layout"
import { errorText, WorkbenchRequestError } from "./client"
import { useEditor } from "./editor-context"
import { SEARCH_KEYS } from "./keys"
import { useWorkbench } from "./panel"
import { compile, matchFiles, relisted, replaceIn, type FileMatches, type SearchFile, type SearchQuery } from "./search"
import { PanelState } from "./ui"
import "./search-side.css"

const SearchPanel = lazy(() => import("./search-panel"))
export const SEARCH_SIDE_TAB = "workbench:search"
const TRIGGER_ID = "workbench-search-side-tab"

export type SkipReason = "changed" | "unsaved" | "unreadable" | "failed"
export type ReplaceReport = {
  matches: number
  files: number
  skipped: { path: string; reason: SkipReason; message?: string }[]
}

function createSearch() {
  const workbench = useWorkbench()
  const editor = useEditor()
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const { sessionKey } = useSessionKey()
  const owner = getOwner()

  const [state, setState] = createStore({
    query: { pattern: "", regex: false, caseSensitive: false, word: false, include: "", exclude: "" } as SearchQuery,
    replace: "",
    replaceOpen: false,
    status: "idle" as "idle" | "searching" | "done" | "failed",
    error: undefined as string | undefined,
    // Results keep the query they were found with: their matches and replaces use it, not the one being typed.
    results: undefined as { query: SearchQuery; files: SearchFile[]; listed: number; total: number } | undefined,
    collapsed: {} as Record<string, boolean>,
    replacing: false,
    report: undefined as ReplaceReport | undefined,
  })
  const [shown, setShown] = createSignal(false)
  const [focusRequest, setFocusRequest] = createSignal(0)

  const regex = createMemo(() => {
    const compiled = state.results && compile(state.results.query)
    return compiled instanceof RegExp ? compiled : undefined
  })
  const entries = createMemo(() => {
    const re = regex()
    return re && state.results ? matchFiles(state.results.files, re) : []
  })

  // Typing searches after a pause; an answer to an older query is dropped.
  let latest = 0
  const run = async () => {
    const query = { ...state.query }
    const id = ++latest
    if (!query.pattern) return setState({ status: "idle", error: undefined, results: undefined, report: undefined })
    const compiled = compile(query)
    if (!(compiled instanceof RegExp)) return setState({ status: "failed", error: compiled.error, results: undefined })
    setState({ status: "searching", error: undefined })
    const result = await workbench.client.search(query).catch((error: unknown) => new Error(errorText(error)))
    if (id !== latest) return
    if (result instanceof Error) return setState({ status: "failed", error: result.message, results: undefined })
    setState({
      status: "done",
      results: { query, files: [...result.files], listed: result.listed, total: result.total },
      collapsed: {},
      report: undefined,
    })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => void run(), delay)
  }
  createEffect(
    on(
      () => JSON.stringify(state.query),
      () => schedule(250),
      { defer: true },
    ),
  )
  onCleanup(() => clearTimeout(timer))

  // One file: its text now, the listed matches replaced in it, written over the bytes it had when searched.
  const write = async (
    file: SearchFile,
    matches: FileMatches["matches"],
    re: RegExp,
    regex: boolean,
    replacement: string,
  ): Promise<{ content: string; hash: string } | { reason: SkipReason; message?: string }> => {
    try {
      const current = await workbench.client.readFile(file.path)
      const targets = matches.map((match) => ({
        line: match.line.line,
        start: match.start,
        text: match.line.text.slice(match.start, match.end),
      }))
      const content = replaceIn(current.content, targets, re, replacement, regex)
      if (content === undefined) return { reason: "changed" }
      const written = await workbench.client.writeFile({ path: file.path, content, baseHash: file.hash! })
      return { content, hash: written.hash }
    } catch (error) {
      // 409: changed since the search; 404: deleted since.
      if (error instanceof WorkbenchRequestError && (error.status === 409 || error.status === 404))
        return { reason: "changed" }
      return { reason: "failed", message: errorText(error) }
    }
  }

  const replace = async (targets: readonly FileMatches[]) => {
    const results = state.results
    const re = regex()
    if (!results || !re || state.replacing) return
    const replacement = state.replace
    setState({ replacing: true, report: undefined })
    const report: ReplaceReport = { matches: 0, files: 0, skipped: [] }
    for (const { file, matches } of targets) {
      if (!file.hash) {
        report.skipped.push({ path: file.path, reason: "unreadable" })
        continue
      }
      // A buffer with unsaved edits is never written under: its save would be refused, or its edits lost.
      if (editor.store.dirty(file.path)) {
        report.skipped.push({ path: file.path, reason: "unsaved" })
        continue
      }
      const outcome = await write(file, matches, re, results.query.regex, replacement)
      if ("reason" in outcome) {
        report.skipped.push({ path: file.path, ...outcome })
        continue
      }
      report.matches += matches.length
      report.files += 1
      // Unless a new search replaced these results meanwhile.
      if (state.results === results)
        setState("results", "files", (files) =>
          files.map((item) => (item.path === file.path ? relisted(item, outcome.content, outcome.hash) : item)),
        )
    }
    setState({ replacing: false, report })
  }

  // The panels' opened flags live in the layout; a view is built only for the call, as the Workbench provider does.
  const withView = (fn: (view: ReturnType<typeof layout.view>) => void) =>
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        fn(layout.view(sessionKey()))
        dispose()
      }),
    )
  const show = () => {
    workbench.hideSide()
    withView((view) => !view.reviewPanel.opened() && view.reviewPanel.open())
    setShown(true)
    setFocusRequest((value) => value + 1)
  }
  // The Debug tab and this one take turns in front of the panel's tabs.
  createEffect(on(workbench.side, (debug) => debug && setShown(false), { defer: true }))

  command.register("workbench-search", () => [
    {
      id: SEARCH_KEYS.show,
      title: language.t("workbench.search.command.show"),
      category: language.t("workbench.search.category"),
      keybind: "mod+shift+f",
      onSelect: () => show(),
    },
  ])

  return {
    state,
    setState,
    entries,
    regex,
    replace,
    search: () => schedule(0),
    shown,
    show,
    hide: () => setShown(false),
    focusRequest,
  }
}

export type SearchContextValue = ReturnType<typeof createSearch>
const SearchContext = createContext<SearchContextValue>()

export function SearchProvider(props: ParentProps) {
  return <SearchContext.Provider value={createSearch()}>{props.children}</SearchContext.Provider>
}

export function useSearch() {
  const value = useContext(SearchContext)
  if (!value) throw new Error("Search context must be used within SearchProvider")
  return value
}

// Like the Debug tab (debug-side.tsx), the Search tab shows over the tab the side panel has selected; opening another
// tab, or any file, hides it.
export function useSearchSideTab(active: Accessor<string | undefined>) {
  const search = useSearch()
  createEffect(on(active, () => search.hide(), { defer: true }))
  return {
    value: () => (search.shown() ? SEARCH_SIDE_TAB : undefined),
    // Tabs onChange; true for the Search tab, which opens only on an explicit press of its trigger.
    select(value: string) {
      if (value === SEARCH_SIDE_TAB) return true
      search.hide()
      return false
    },
  }
}

export function SearchSideTrigger() {
  const search = useSearch()
  const language = useLanguage()
  return (
    <Tabs.Trigger
      value={SEARCH_SIDE_TAB}
      id={TRIGGER_ID}
      data-workbench-side-tab="search"
      onPointerDown={(event) => event.pointerType === "mouse" && event.button === 0 && search.show()}
      onClick={() => search.show()}
    >
      {language.t("workbench.search.tab")}
    </Tabs.Trigger>
  )
}

export function SearchSideContent() {
  const search = useSearch()
  const language = useLanguage()
  return (
    <Show when={search.shown()}>
      <div
        data-component="workbench-search-side"
        role="tabpanel"
        aria-labelledby={TRIGGER_ID}
        class="flex min-h-0 flex-1 flex-col overflow-hidden bg-v2-background-bg-base"
      >
        <Suspense fallback={<PanelState icon={<LoaderV2 />} title={language.t("common.loading")} />}>
          <SearchPanel />
        </Suspense>
      </div>
    </Show>
  )
}
