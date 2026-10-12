import { createMemo, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { EXCEPTION_FILTERS, isLive, type Breakpoint } from "./debug"
import { useDebug } from "./debug-context"
import { DebugToolbar, OwnerChip, SessionPicker, VariableNode } from "./debug-ui"
import { useFileLineOpener } from "./open-file"
import { BUG_GLYPH, Glyph } from "./ui"

const SECTIONS = ["stack", "variables", "watch", "breakpoints"] as const
const ROW =
  "flex h-[22px] w-full min-w-0 items-center gap-2 px-3 text-left text-[12px] outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
const NOTE = "px-3 py-1 text-[12px] leading-[18px] text-v2-text-text-muted"

// Side panel Debug tab: toolbar, call stack, variables, watches and breakpoints of the selected session.
export default function DebugPanel() {
  const debug = useDebug()
  const language = useLanguage()
  const [ui, setUi] = createStore({ closed: {} as Partial<Record<(typeof SECTIONS)[number], boolean>> })
  const session = () => debug.selected()

  return (
    <div data-component="workbench-debug" class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-v2-border-border-muted px-2">
        <DebugToolbar />
        <span class="mx-1 h-4 w-px shrink-0 bg-v2-border-border-muted" />
        <SessionPicker />
        <span class="flex-1" />
        <Show when={session()}>{(current) => <OwnerChip session={current()} />}</Show>
      </div>
      <Status />
      <div class="min-h-0 flex-1 overflow-y-auto pb-4">
        <For each={SECTIONS}>
          {(id) => (
            <section data-debug-section={id} class="border-b border-v2-border-border-muted">
              <button
                type="button"
                aria-expanded={!ui.closed[id]}
                class="flex h-7 w-full items-center gap-1 px-2 text-left text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
                onClick={() => setUi("closed", id, (value) => !value)}
              >
                <Icon name={ui.closed[id] ? "chevron-right" : "chevron-down"} size="small" />
                {language.t(`workbench.debug.section.${id}`)}
              </button>
              <Show when={!ui.closed[id]}>
                <div class="pb-2">
                  {
                    {
                      stack: () => <CallStack />,
                      variables: () => <Variables />,
                      watch: () => <Watches />,
                      breakpoints: () => <Breakpoints />,
                    }[id]() as JSX.Element
                  }
                </div>
              </Show>
            </section>
          )}
        </For>
      </div>
    </div>
  )
}

function Status() {
  const debug = useDebug()
  const language = useLanguage()
  const text = () => {
    const current = debug.selected()
    if (debug.state.list === "unavailable") return language.t("workbench.debug.unavailable")
    if (!current) return language.t("workbench.debug.status.none")
    if (current.state === "stopped" && current.stop) {
      const reason = current.stop.description || current.stop.reason
      return language.t("workbench.debug.status.stopped", { reason })
    }
    if (current.state === "failed" && current.error)
      return language.t("workbench.debug.status.failed", { error: current.error })
    return language.t(`workbench.debug.state.${current.state}`)
  }
  const exception = () => debug.selected()?.stop?.exception
  return (
    <div class="shrink-0 px-3 py-1.5" data-slot="debug-status">
      <Show
        when={debug.selected() || debug.state.list === "unavailable"}
        fallback={
          <div class="flex items-center gap-2 text-[12px] text-v2-text-text-muted">
            <span class="text-v2-icon-icon-muted">
              <Glyph path={BUG_GLYPH} size={16} />
            </span>
            {text()}
          </div>
        }
      >
        <div
          class="select-text text-[12px] leading-[18px]"
          classList={{
            "text-v2-state-fg-danger": debug.selected()?.state === "failed",
            "text-v2-state-fg-warning": debug.selected()?.state === "stopped",
            "text-v2-text-text-muted": debug.selected()?.state !== "failed" && debug.selected()?.state !== "stopped",
          }}
        >
          {text()}
        </div>
      </Show>
      <Show when={exception()}>
        {(value) => (
          <div class="mt-1 select-text whitespace-pre-wrap break-words rounded-[6px] bg-v2-state-bg-danger px-2 py-1 font-mono text-[11px] text-v2-state-fg-danger">
            {[value().id, value().description].filter(Boolean).join(": ")}
          </div>
        )}
      </Show>
    </div>
  )
}

function CallStack() {
  const debug = useDebug()
  const language = useLanguage()
  const openAt = useFileLineOpener()
  const frames = () => debug.selected()?.stop?.frames ?? []
  return (
    <Show when={frames().length} fallback={<div class={NOTE}>{language.t("workbench.debug.stack.empty")}</div>}>
      <div role="list" aria-label={language.t("workbench.debug.section.stack")}>
        <For each={frames()}>
          {(frame) => {
            const inside = () => !!frame.file && !!debug.relative(frame.file)
            const current = () => frame.id === debug.frameID()
            return (
              <div role="listitem" class="group flex items-center" data-frame={frame.id}>
                <button
                  type="button"
                  data-slot="frame"
                  aria-current={current() ? "true" : undefined}
                  class={`${ROW} flex-1`}
                  classList={{ "bg-v2-background-bg-layer-02": current() }}
                  title={frame.file}
                  onClick={() => debug.selectFrame(frame.id)}
                >
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    classList={{ "bg-v2-state-fg-warning": current(), "bg-transparent": !current() }}
                  />
                  <span class="min-w-0 truncate font-mono text-v2-text-text-base">{frame.name}</span>
                  <span class="ml-auto shrink-0 font-mono text-[11px] text-v2-text-text-faint">
                    {frame.file ? `${getFilename(frame.file)}:${frame.line ?? ""}` : ""}
                  </span>
                </button>
                <Show when={inside() && frame.line}>
                  <IconButton
                    icon="square-arrow-top-right"
                    variant="ghost"
                    class="mr-1 h-5 w-5 shrink-0"
                    aria-label={language.t("workbench.problems.open", {
                      file: getFilename(frame.file!),
                      line: frame.line!,
                    })}
                    onClick={() => {
                      debug.selectFrame(frame.id)
                      openAt(frame.file!, frame.line!, false)
                    }}
                  />
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

function Variables() {
  const debug = useDebug()
  const language = useLanguage()
  const stop = () => debug.selected()?.stop
  const top = () => debug.frameID() === stop()?.frames[0]?.id
  return (
    <Show when={stop()} fallback={<div class={NOTE}>{language.t("workbench.debug.variables.empty")}</div>}>
      {(snapshot) => (
        <Show when={top()} fallback={<div class={NOTE}>{language.t("workbench.debug.variables.topOnly")}</div>}>
          <Show
            when={snapshot().locals.length}
            fallback={<div class={NOTE}>{language.t("workbench.debug.variables.none")}</div>}
          >
            <div role="tree" aria-label={language.t("workbench.debug.section.variables")}>
              <For each={snapshot().locals}>
                {(variable) => <VariableNode variable={variable} path={["locals", variable.name]} />}
              </For>
            </div>
          </Show>
        </Show>
      )}
    </Show>
  )
}

function Watches() {
  const debug = useDebug()
  const language = useLanguage()
  const [draft, setDraft] = createStore({ text: "" })
  const session = () => debug.selected()
  const stopped = () => session()?.state === "stopped"
  const add = (event: SubmitEvent) => {
    event.preventDefault()
    debug.addWatch(draft.text)
    setDraft("text", "")
  }
  return (
    <div>
      <For each={debug.prefs.watches}>
        {(expression) => {
          const value = () => debug.state.watch[expression]
          const fresh = () => !!value() && value()!.at === debug.watchAt()
          return (
            <div class="group flex items-start" data-watch={expression}>
              <div class="min-w-0 flex-1" classList={{ "opacity-50": !fresh() }}>
                <Show
                  when={fresh() && !value()!.error && value()!.ref}
                  fallback={
                    <div class={`${ROW} font-mono`} title={value()?.text}>
                      <span class="shrink-0 text-v2-text-text-accent">{expression}</span>
                      <span class="shrink-0 text-v2-text-text-faint">=</span>
                      <span
                        class="min-w-0 truncate"
                        classList={{
                          "text-v2-state-fg-danger": !!value()?.error,
                          "text-v2-text-text-base": !value()?.error,
                        }}
                      >
                        {value()?.text ?? language.t("workbench.debug.watch.pending")}
                      </span>
                    </div>
                  }
                >
                  <VariableNode
                    variable={{ name: expression, value: value()!.text, variablesReference: value()!.ref! }}
                    path={["watch", expression]}
                  />
                </Show>
              </div>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="mr-1 h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={language.t("workbench.debug.watch.remove", { expression })}
                onClick={() => debug.removeWatch(expression)}
              />
            </div>
          )
        }}
      </For>
      <Show when={stopped() && session()?.owner !== "human" && debug.prefs.watches.length}>
        <div class={`${NOTE} flex items-center gap-2`}>
          {language.t("workbench.debug.watch.manual")}
          <ButtonV2 size="small" variant="neutral" onClick={() => void debug.evaluateWatches()}>
            {language.t("workbench.debug.watch.refresh")}
          </ButtonV2>
        </div>
      </Show>
      <form class="px-3 pt-1" onSubmit={add}>
        <TextInputV2
          class="!w-full [&_input]:font-mono"
          aria-label={language.t("workbench.debug.watch.add")}
          placeholder={language.t("workbench.debug.watch.add")}
          spellcheck={false}
          value={draft.text}
          onInput={(event) => setDraft("text", event.currentTarget.value)}
        />
      </form>
    </div>
  )
}

type BreakpointField = "condition" | "hitCondition" | "logMessage"
const FIELDS: { field: BreakpointField; capability: string }[] = [
  { field: "condition", capability: "supportsConditionalBreakpoints" },
  { field: "hitCondition", capability: "supportsHitConditionalBreakpoints" },
  { field: "logMessage", capability: "supportsLogPoints" },
]

function Breakpoints() {
  const debug = useDebug()
  const language = useLanguage()
  const openAt = useFileLineOpener()
  const [edit, setEdit] = createStore({
    key: undefined as string | undefined,
    condition: "",
    hitCondition: "",
    logMessage: "",
  })
  const files = createMemo(() => Object.keys(debug.prefs.breakpoints).toSorted())
  // Capabilities of the selected live session; with none, every field is offered and the server checks at start.
  const live = () => {
    const current = debug.selected()
    return current && isLive(current) ? current : undefined
  }
  const unsupported = (capability: string) => {
    const current = live()
    if (!current || current.capabilities.includes(capability)) return
    return language.t("workbench.debug.breakpoints.unsupported", { adapter: current.adapter })
  }
  const adapter = () => debug.selected()?.adapter ?? "debugpy"
  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("workbench.debug.failed.breakpoints"),
      description: errorText(error),
    })
  const begin = (file: string, item: Breakpoint) =>
    setEdit({
      key: `${file}:${item.line}`,
      condition: item.condition ?? "",
      hitCondition: item.hitCondition ?? "",
      logMessage: item.logMessage ?? "",
    })
  const save = (file: string, line: number) => (event: SubmitEvent) => {
    event.preventDefault()
    void debug
      .editBreakpoint(file, line, {
        condition: edit.condition,
        hitCondition: edit.hitCondition,
        logMessage: edit.logMessage,
      })
      .catch(fail)
    setEdit("key", undefined)
  }

  return (
    <div>
      <Show when={files().length} fallback={<div class={NOTE}>{language.t("workbench.debug.breakpoints.empty")}</div>}>
        <For each={files()}>
          {(file) => (
            <div data-breakpoint-file={file}>
              <div class="flex h-[22px] items-center gap-1.5 px-3 text-[12px]" title={file}>
                <span class="shrink-0 font-[530] text-v2-text-text-base">{getFilename(file)}</span>
                <span class="min-w-0 truncate text-v2-text-text-faint">
                  {file.includes("/") ? getDirectory(file) : ""}
                </span>
              </div>
              <For each={debug.breakpoints(file)}>
                {(item) => {
                  const state = () => debug.verified(file)?.find((entry) => entry.line === item.line)
                  const kind = () =>
                    item.logMessage ? "log" : item.condition || item.hitCondition ? "condition" : "line"
                  return (
                    <div data-breakpoint={`${file}:${item.line}`}>
                      <div class="group flex items-center">
                        <button
                          type="button"
                          class={`${ROW} flex-1 pl-6`}
                          title={state()?.message}
                          onClick={() => openAt(debug.absolute(file), item.line, false)}
                        >
                          <span
                            class="size-2 shrink-0 rounded-full"
                            classList={{
                              "bg-v2-state-fg-danger": kind() === "line" && state()?.verified !== false,
                              "bg-v2-state-fg-warning": kind() !== "line" && state()?.verified !== false,
                              "shadow-[inset_0_0_0_1.5px_var(--v2-state-fg-danger)]": state()?.verified === false,
                            }}
                          />
                          <span class="shrink-0 font-mono tabular-nums text-v2-text-text-base">
                            {language.t("workbench.debug.breakpoints.line", { line: item.line })}
                          </span>
                          <span class="min-w-0 truncate font-mono text-v2-text-text-muted">
                            {[
                              item.condition &&
                                language.t("workbench.debug.breakpoints.when", { value: item.condition }),
                              item.hitCondition &&
                                language.t("workbench.debug.breakpoints.hits", { value: item.hitCondition }),
                              item.logMessage &&
                                language.t("workbench.debug.breakpoints.logs", { value: item.logMessage }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <Show when={state()?.verified === false}>
                            <span class="ml-auto shrink-0 text-[11px] text-v2-text-text-faint">
                              {language.t("workbench.debug.breakpoints.unverified")}
                            </span>
                          </Show>
                        </button>
                        <IconButton
                          icon="pencil-line"
                          variant="ghost"
                          class="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={language.t("workbench.debug.breakpoints.edit", { line: item.line })}
                          onClick={() => begin(file, item)}
                        />
                        <IconButton
                          icon="close-small"
                          variant="ghost"
                          class="mr-1 h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={language.t("workbench.debug.breakpoints.remove", { line: item.line })}
                          onClick={() => void debug.removeBreakpoint(file, item.line).catch(fail)}
                        />
                      </div>
                      <Show when={edit.key === `${file}:${item.line}`}>
                        <form class="flex flex-col gap-1.5 py-1.5 pr-3 pl-6" onSubmit={save(file, item.line)}>
                          <For each={FIELDS}>
                            {(entry) => (
                              <label class="flex flex-col gap-0.5 text-[11px] text-v2-text-text-muted">
                                {language.t(`workbench.debug.breakpoints.${entry.field}`)}
                                <TextInputV2
                                  class="!w-full [&_input]:font-mono"
                                  spellcheck={false}
                                  disabled={!!unsupported(entry.capability)}
                                  placeholder={
                                    unsupported(entry.capability) ??
                                    language.t(`workbench.debug.breakpoints.${entry.field}.placeholder`)
                                  }
                                  value={edit[entry.field]}
                                  onInput={(event) => setEdit(entry.field, event.currentTarget.value)}
                                />
                              </label>
                            )}
                          </For>
                          <div class="flex justify-end gap-1.5 pt-1">
                            <ButtonV2
                              type="button"
                              size="small"
                              variant="neutral"
                              onClick={() => setEdit("key", undefined)}
                            >
                              {language.t("common.cancel")}
                            </ButtonV2>
                            <ButtonV2 type="submit" size="small" variant="contrast">
                              {language.t("common.save")}
                            </ButtonV2>
                          </div>
                        </form>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          )}
        </For>
      </Show>
      <div class="px-3 pt-2 text-[11px] font-[530] text-v2-text-text-muted">
        {language.t("workbench.debug.exceptions", { adapter: adapter() })}
      </div>
      <For each={EXCEPTION_FILTERS[adapter()] ?? []}>
        {(filter) => (
          <label class="flex h-[22px] items-center gap-2 px-3 text-[12px] text-v2-text-text-base">
            <input
              type="checkbox"
              data-exception-filter={filter}
              class="size-3.5 accent-[var(--v2-state-fg-danger)]"
              checked={debug.exceptions(adapter()).includes(filter)}
              onChange={(event) => void debug.setException(adapter(), filter, event.currentTarget.checked).catch(fail)}
            />
            {language.t(`workbench.debug.exception.${filter}`)}
          </label>
        )}
      </For>
    </div>
  )
}
