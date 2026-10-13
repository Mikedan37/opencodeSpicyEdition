import { createEffect, createMemo, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { type DebugCompletion } from "./client"
import { completionRange, type ConsoleRow } from "./debug"
import { useDebug } from "./debug-context"
import { DebugToolbar, OwnerChip, SessionPicker, VariableNode } from "./debug-ui"
import { useFileLineOpener } from "./open-file"
import { useWorkbench } from "./panel"
import { BUG_GLYPH, Glyph, PanelState, TONE_CLASS } from "./ui"
import { VirtualList } from "./virtual-list"

const FILTERS = ["stdout", "stderr", "console"] as const
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const CHIP_TONE = { human: "info", agent: "warning", program: "neutral", adapter: "neutral" } as const
const KIND_CLASS: Record<ConsoleRow["kind"], string> = {
  stdout: "text-v2-text-text-base",
  stderr: "text-v2-state-fg-danger",
  console: "text-v2-text-text-muted",
  eval: "text-v2-text-text-base",
  result: "text-v2-text-text-base",
  stop: "text-v2-state-fg-warning",
  exception: "text-v2-state-fg-danger",
  system: "italic text-v2-text-text-faint",
}

// Bottom panel Debug Console: program output, evaluations and stops of the selected session, plus an input that
// evaluates in the selected frame with the adapter's completions.
export default function DebugConsolePanel() {
  const debug = useDebug()
  const language = useLanguage()
  const openSetup = useSettingsDialog("workbench")
  const filter = debug.consoleFilter
  const console = () => (debug.state.selected ? debug.state.consoles[debug.state.selected] : undefined)

  createEffect(() => {
    if (debug.state.selected) void debug.backlog(debug.state.selected)
  })

  const rows = createMemo(() => {
    const current = console()
    const visible = (current?.rows ?? []).filter(
      (row) => !(row.kind === "stdout" || row.kind === "stderr" || row.kind === "console") || filter.state[row.kind],
    )
    if (!current?.dropped) return visible
    const dropped: ConsoleRow = {
      seq: -1,
      at: 0,
      kind: "system",
      by: "system",
      text: language.t("workbench.debug.console.dropped", { count: current.dropped }),
    }
    return [dropped, ...visible]
  })
  // A chip marks where attribution changes, so a run of program output carries one.
  const chips = createMemo(() => {
    const list = rows()
    return new Set(
      list.filter((row, index) => row.by !== "system" && row.by !== list[index - 1]?.by).map((row) => row.seq),
    )
  })
  // One Evidence chip per evaluation: its eval and result rows share the id.
  const evidence = createMemo(() => {
    const list = rows()
    return new Set(
      list
        .filter((row, index) => row.evidenceID && row.evidenceID !== list[index - 1]?.evidenceID)
        .map((row) => row.seq),
    )
  })
  // The human's evaluation that is waiting for an LLDB command ask or failed, after the row that was last when it was
  // sent; an ask without one (the page reloaded while it waited) goes last.
  // One object per session, so the list keeps the entry (and a focused button in it) mounted as rows arrive.
  const entry = createMemo(() => debug.state.selected && { attempt: debug.state.selected })
  const items = createMemo((): Item[] => {
    const list = rows()
    const current = entry()
    if (!current) return list
    const attempt = debug.state.attempts[current.attempt]
    if (!attempt?.error && !debug.lldbAsk(current.attempt)) return list
    const at = attempt ? list.findIndex((row) => row.seq > attempt.after) : -1
    return at === -1 ? [...list, current] : [...list.slice(0, at), current, ...list.slice(at)]
  })

  return (
    <div data-component="workbench-debug-console" class="flex min-h-0 flex-1 flex-col">
      <Switch
        fallback={
          <>
            <div class="flex h-10 shrink-0 items-center gap-2 px-2">
              {/* One set of debug controls on screen: the side Debug tab has them while open */}
              <Show when={!debug.sideShown()}>
                <DebugToolbar />
                <span class="mx-1 h-4 w-px shrink-0 bg-v2-border-border-muted" />
              </Show>
              <SessionPicker />
              <div class="ml-2 flex shrink-0 items-center gap-1" role="group">
                <For each={FILTERS}>
                  {(kind) => (
                    <button
                      type="button"
                      data-console-filter={kind}
                      aria-pressed={filter.state[kind]}
                      class="flex h-7 shrink-0 items-center rounded-[6px] px-2 text-[12px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] aria-pressed:bg-v2-background-bg-layer-02 aria-pressed:text-v2-text-text-base"
                      onClick={() => filter.set(kind, (value) => !value)}
                    >
                      {language.t(`workbench.debug.console.filter.${kind}`)}
                    </button>
                  )}
                </For>
              </div>
              <span class="flex-1" />
              <Show when={console()?.backlog === "loading"}>
                <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-v2-text-text-muted">
                  <LoaderV2 width={10} height={10} />
                  {language.t("workbench.debug.console.loading")}
                </span>
              </Show>
              <Show when={console()?.backlog === "failed"}>
                <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                  {language.t("workbench.debug.console.loadFailed")}
                </span>
              </Show>
              <Show when={!debug.sideShown() && debug.selected()}>
                {(session) => <OwnerChip session={session()} />}
              </Show>
            </div>
            <VirtualList
              items={items()}
              itemKey={(item) => ("attempt" in item ? "attempt" : String(item.seq))}
              estimate={18}
              follow
              label={language.t("workbench.debug.console.label")}
              class="flex-1 select-text py-1"
            >
              {(item) =>
                "attempt" in item ? (
                  <Attempt sessionID={item.attempt} />
                ) : (
                  <Line row={item} chip={chips().has(item.seq)} evidence={evidence().has(item.seq)} />
                )
              }
            </VirtualList>
            <Input />
          </>
        }
      >
        <Match when={debug.state.list === "unavailable" && !debug.state.sessions.length}>
          <PanelState icon={<Glyph path={BUG_GLYPH} />} title={language.t("workbench.debug.unavailable")} />
        </Match>
        <Match when={!debug.state.sessions.length}>
          <PanelState
            icon={<Glyph path={BUG_GLYPH} />}
            title={language.t("workbench.debug.title")}
            description={language.t("workbench.debug.description")}
          >
            <ButtonV2 size="small" variant="neutral" onClick={() => debug.openStart()}>
              {language.t("workbench.debug.action.start")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" data-action="open-setup" onClick={openSetup}>
              {language.t("workbench.setup.open")}
            </ButtonV2>
          </PanelState>
        </Match>
      </Switch>
    </div>
  )
}

type Item = ConsoleRow | { attempt: string }

function Line(props: { row: ConsoleRow; chip: boolean; evidence: boolean }) {
  const language = useLanguage()
  const debug = useDebug()
  const workbench = useWorkbench()
  const openAt = useFileLineOpener()
  const text = () => props.row.text.replace(ANSI, "")
  const by = () => (props.row.by === "system" ? undefined : props.row.by)
  // A result's reference lives only until the program moves on, so only results from the current pause expand.
  const expandable = () => {
    const session = debug.selected()
    const current = session?.state === "stopped" && session.stop && props.row.at >= session.stop.at
    return current ? props.row.variablesReference : undefined
  }
  return (
    <div
      data-console-row={props.row.seq}
      data-kind={props.row.kind}
      data-by={props.row.by}
      class="flex min-w-0 items-start gap-2 px-3 font-mono text-[12px] leading-[18px]"
    >
      <span class="flex w-16 shrink-0 justify-end pt-px">
        <Show when={props.chip && by()}>
          {(value) => (
            <span
              data-slot="console-chip"
              class={`rounded-full px-1.5 font-sans text-[10px] font-[530] leading-4 ${TONE_CLASS[CHIP_TONE[value()]]}`}
            >
              {language.t(`workbench.debug.console.by.${value()}`)}
            </span>
          )}
        </Show>
      </span>
      <div class={`min-w-0 flex-1 whitespace-pre-wrap break-words ${KIND_CLASS[props.row.kind]}`}>
        <Switch fallback={text()}>
          <Match when={props.row.kind === "eval"}>
            <span class="text-v2-text-text-faint">› </span>
            {text()}
          </Match>
          <Match when={props.row.kind === "result" && expandable()}>
            {(ref) => (
              <VariableNode
                variable={{ name: "", value: text(), variablesReference: ref() }}
                path={["console", String(props.row.seq)]}
              />
            )}
          </Match>
        </Switch>
      </div>
      <Show when={props.row.location}>
        {(location) => (
          <button
            type="button"
            disabled={!debug.relative(location().file)}
            class="shrink-0 text-[11px] text-v2-text-text-faint enabled:hover:text-v2-text-text-accent enabled:hover:underline"
            title={location().file}
            onClick={() => openAt(location().file, location().line, false)}
          >
            {getFilename(location().file)}:{location().line}
          </button>
        )}
      </Show>
      <Show when={props.evidence && props.row.evidenceID}>
        {(id) => (
          // The agent's evaluation is evidence in its debug session's investigation (CON-05).
          <button
            type="button"
            data-slot="console-evidence"
            data-evidence={id()}
            disabled={!debug.selected()?.investigationID}
            title={language.t("workbench.debug.console.evidence.title")}
            class={`shrink-0 rounded-full px-1.5 font-sans text-[10px] font-[530] leading-4 outline-none enabled:hover:underline focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] ${TONE_CLASS.success}`}
            onClick={() => {
              workbench.investigations.focus(debug.selected()!.investigationID!, id())
              workbench.open("activity")
            }}
          >
            {language.t("workbench.debug.console.evidence")}
          </button>
        )}
      </Show>
    </div>
  )
}

// The human's evaluation while a debug.lldbCommand ask holds it (CON-07), or after it failed: the typed command, the
// ask under it, and the error.
function Attempt(props: { sessionID: string }) {
  const debug = useDebug()
  const language = useLanguage()
  const attempt = () => debug.state.attempts[props.sessionID]
  const ask = () => debug.lldbAsk(props.sessionID)
  const command = () => attempt()?.expression ?? `\`${String(ask()?.metadata?.command ?? "")}`
  return (
    <div data-console-attempt class="flex min-w-0 items-start gap-2 px-3 font-mono text-[12px] leading-[18px]">
      <span class="flex w-16 shrink-0 justify-end pt-px">
        <span
          data-slot="console-chip"
          class={`rounded-full px-1.5 font-sans text-[10px] font-[530] leading-4 ${TONE_CLASS[CHIP_TONE.human]}`}
        >
          {language.t("workbench.debug.console.by.human")}
        </span>
      </span>
      <div class="min-w-0 flex-1 whitespace-pre-wrap break-words text-v2-text-text-base">
        <span class="text-v2-text-text-faint">› </span>
        {command()}
        <Show when={ask()}>
          {(value) => (
            <div
              role="group"
              data-slot="lldb-ask"
              data-request={value().id}
              aria-label={language.t("workbench.debug.lldb.label")}
              class="my-1 flex flex-wrap items-center gap-2 whitespace-normal rounded-[6px] bg-v2-state-bg-warning px-2 py-1.5 font-sans text-[12px] text-v2-text-text-base"
            >
              <span class="min-w-0 flex-1">{language.t("workbench.debug.lldb.ask")}</span>
              <ButtonV2
                size="small"
                variant="contrast"
                disabled={debug.answering(value().id)}
                onClick={() => void debug.answer(value().id, "once")}
              >
                {language.t("workbench.debug.lldb.once")}
              </ButtonV2>
              <ButtonV2
                size="small"
                variant="neutral"
                disabled={debug.answering(value().id)}
                title={language.t("workbench.debug.lldb.always.title")}
                onClick={() => void debug.answer(value().id, "always")}
              >
                {language.t("workbench.debug.lldb.always")}
              </ButtonV2>
              <ButtonV2
                size="small"
                variant="neutral"
                disabled={debug.answering(value().id)}
                onClick={() => void debug.answer(value().id, "reject")}
              >
                {language.t("workbench.debug.lldb.reject")}
              </ButtonV2>
            </div>
          )}
        </Show>
        <Show when={attempt()?.error}>
          {(error) => (
            <div data-slot="attempt-error" class="text-v2-state-fg-danger">
              {error()}
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function Input() {
  const debug = useDebug()
  const language = useLanguage()
  let input!: HTMLTextAreaElement
  let timer: ReturnType<typeof setTimeout> | undefined
  let asked = 0
  onCleanup(() => clearTimeout(timer))
  const [state, setState] = createStore({
    text: "",
    items: [] as DebugCompletion[],
    active: 0,
    // Index into the history while recalling; -1 is the line being typed, kept in `draft`.
    history: -1,
    draft: "",
    busy: false,
    // Where the line the completions are for starts in the (multi-line) text.
    base: 0,
  })
  const ready = () => debug.selected()?.state === "stopped"
  const completes = () => !!debug.selected()?.capabilities.includes("supportsCompletionsRequest")
  const close = () => setState({ items: [], active: 0 })

  // Completions are for the line the cursor is on.
  const suggest = () => {
    clearTimeout(timer)
    const ask = ++asked
    if (!ready() || !completes() || !state.text.trim()) return close()
    const text = state.text
    const cursor = input.selectionStart ?? text.length
    const base = text.lastIndexOf("\n", cursor - 1) + 1
    const end = text.indexOf("\n", cursor)
    const line = text.slice(base, end === -1 ? undefined : end)
    timer = setTimeout(
      () =>
        debug.completions(line, cursor - base + 1).then(
          (items) => ask === asked && setState({ items: items.slice(0, 50), active: 0, base }),
          () => ask === asked && close(),
        ),
      150,
    )
  }
  // debugpy (like VS Code) counts `start` from 0 even though the session asked for 1-based columns.
  const accept = (item: DebugCompletion) => {
    const cursor = input.selectionStart ?? state.text.length
    const range =
      item.start === undefined
        ? completionRange(state.text, cursor)
        : { start: state.base + item.start, end: state.base + item.start + (item.length ?? 0) }
    const insert = item.text ?? item.label
    asked++
    setState({ text: state.text.slice(0, range.start) + insert + state.text.slice(range.end), items: [], active: 0 })
    const caret = range.start + insert.length
    queueMicrotask(() => input.setSelectionRange(caret, caret))
  }
  const submit = () => {
    const expression = state.text.trim()
    if (!expression || !ready() || state.busy) return
    asked++
    setState({ text: "", items: [], history: -1, busy: true })
    // A failure shows in the console under the expression (debug.state.attempts).
    debug
      .evaluate(expression)
      .catch(() => undefined)
      .finally(() => {
        setState("busy", false)
        input.focus()
      })
  }
  const recall = (step: number) => {
    const list = debug.prefs.history
    if (!list.length) return
    const from = state.history === -1 ? list.length : state.history
    const next = Math.min(list.length, Math.max(0, from + step))
    if (state.history === -1) setState("draft", state.text)
    setState({ history: next === list.length ? -1 : next, text: next === list.length ? state.draft : list[next]! })
  }
  // Enter submits and Shift+Enter starts a new line; Up and Down recall history only from the first and the last line,
  // so they still move between the lines of a multi-line input.
  const keydown = (event: KeyboardEvent) => {
    const open = state.items.length > 0
    const enter = event.key === "Enter" && !event.shiftKey && !event.isComposing
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      return setState("active", (state.active + step + state.items.length) % state.items.length)
    }
    if (open && (event.key === "Tab" || enter)) {
      event.preventDefault()
      return accept(state.items[state.active]!)
    }
    if (open && event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close()
    }
    if (enter) {
      event.preventDefault()
      return submit()
    }
    if (event.key === "Enter") return close()
    const first = !state.text.slice(0, input.selectionStart ?? 0).includes("\n")
    const last = !state.text.slice(input.selectionEnd ?? state.text.length).includes("\n")
    if ((event.key === "ArrowUp" && first) || (event.key === "ArrowDown" && last)) {
      event.preventDefault()
      recall(event.key === "ArrowUp" ? -1 : 1)
    }
  }

  return (
    <div class="relative flex min-h-9 shrink-0 items-start gap-2 border-t border-v2-border-border-muted px-3 py-2">
      <Show when={state.items.length}>
        <div
          id="debug-console-completions"
          role="listbox"
          aria-label={language.t("workbench.debug.console.completions")}
          class="absolute bottom-full left-8 z-20 mb-1 max-h-48 w-80 overflow-y-auto rounded-[8px] bg-v2-background-bg-base py-1 shadow-[var(--v2-elevation-raised)]"
        >
          <For each={state.items}>
            {(item, index) => (
              <div
                id={`debug-console-completion-${index()}`}
                role="option"
                aria-selected={index() === state.active}
                data-completion={item.label}
                class="flex h-6 cursor-default items-center gap-2 px-2 font-mono text-[12px] text-v2-text-text-base aria-selected:bg-v2-background-bg-layer-02"
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept(item)
                }}
              >
                <span class="min-w-0 truncate">{item.label}</span>
                <Show when={item.type}>
                  <span class="ml-auto shrink-0 font-sans text-[11px] text-v2-text-text-faint">{item.type}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <span class="shrink-0 font-mono text-[12px] leading-5 text-v2-text-text-faint">›</span>
      <textarea
        ref={input}
        data-slot="debug-console-input"
        // Grows with its lines, up to 8.
        rows={Math.min(8, state.text.split("\n").length)}
        class="min-w-0 flex-1 resize-none bg-transparent font-mono text-[12px] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:cursor-not-allowed"
        aria-label={language.t("workbench.debug.console.input")}
        aria-autocomplete="list"
        aria-controls={state.items.length ? "debug-console-completions" : undefined}
        aria-activedescendant={state.items.length ? `debug-console-completion-${state.active}` : undefined}
        placeholder={
          ready() ? language.t("workbench.debug.console.input") : language.t("workbench.debug.console.input.paused")
        }
        disabled={!ready()}
        spellcheck={false}
        autocomplete="off"
        value={state.text}
        onInput={(event) => {
          setState({ text: event.currentTarget.value, history: -1 })
          suggest()
        }}
        onKeyDown={keydown}
        onBlur={close}
      />
      <Show when={state.busy}>
        <LoaderV2 width={12} height={12} />
      </Show>
    </div>
  )
}
