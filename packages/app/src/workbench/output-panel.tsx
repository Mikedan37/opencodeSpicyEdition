import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { useLanguage } from "@/context/language"
import { ansiLines, fileRefs, resolvePath, type AnsiStyle } from "./ansi"
import { useFileLineOpener } from "./open-file"
import { useWorkbench } from "./panel"
import { isFinished, needsDetail, type RunEntry } from "./runs"
import { shortPath } from "./snapshot"
import { Glyph, OUTPUT_GLYPH, PanelState, TONE_CLASS } from "./ui"
import { VirtualList } from "./virtual-list"

const REPORT_COUNTS = ["passed", "failed", "skipped", "unavailable", "timedOut"] as const
const STATUS_TONE: Record<Workbench.RunStatus, keyof typeof TONE_CLASS> = {
  queued: "neutral",
  running: "info",
  passed: "success",
  failed: "danger",
  timed_out: "warning",
  skipped: "neutral",
  unavailable: "warning",
  cancelled: "neutral",
}

// Terminal palette mapped to theme tokens so tool colors stay readable in light and dark themes.
const ANSI_COLORS = {
  "--ansi-black": "var(--v2-text-text-base)",
  "--ansi-red": "var(--v2-state-fg-danger)",
  "--ansi-green": "var(--spicy-fg-success)",
  "--ansi-yellow": "var(--spicy-fg-warning)",
  "--ansi-blue": "var(--v2-state-fg-info)",
  "--ansi-magenta": "var(--v2-avatar-bg-pink)",
  "--ansi-cyan": "var(--v2-avatar-bg-cyan)",
  "--ansi-white": "var(--v2-text-text-muted)",
}

export default function OutputPanel() {
  const workbench = useWorkbench()
  const language = useLanguage()
  const runs = workbench.runs
  const [ui, setUi] = createStore({ open: {} as Record<string, boolean> })
  const [now, setNow] = createSignal(Date.now())
  const running = createMemo(() => runs.state.runs.some((entry) => !isFinished(entry.info.status)))
  // "Last check: 2 passed, 1 failed": the counts that are not zero (UX #15).
  const summaryText = (summary: Workbench.VerificationReport["summary"]) => {
    const counts = REPORT_COUNTS.filter((key) => summary[key]).map((key) =>
      language.t(`workbench.output.report.${key}`, { count: summary[key] }),
    )
    return counts.length
      ? language.t("workbench.output.report", { counts: counts.join(", ") })
      : language.t("workbench.output.report.empty")
  }

  onMount(() => void runs.load())
  createEffect(() => {
    if (!running()) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const runChecks = () => (
    <ButtonV2 size="small" variant="neutral" disabled={runs.state.checking} onClick={() => void workbench.runChecks()}>
      <Show when={runs.state.checking}>
        <LoaderV2 width={12} height={12} />
      </Show>
      {language.t("workbench.output.run")}
    </ButtonV2>
  )

  return (
    <div data-component="workbench-output" class="flex min-h-0 flex-1 flex-col" style={ANSI_COLORS}>
      <Show
        when={runs.state.runs.length > 0}
        fallback={
          <PanelState
            icon={<Glyph path={OUTPUT_GLYPH} />}
            title={language.t("workbench.output.title")}
            description={language.t("workbench.output.description")}
          >
            {runChecks()}
          </PanelState>
        }
      >
        <div class="flex h-10 shrink-0 items-center gap-3 px-3">
          {runChecks()}
          <Show when={runs.state.report}>
            {(report) => (
              <span role="status" class="truncate text-[12px] text-v2-text-text-muted" data-slot="report">
                {summaryText(report().summary)}
              </span>
            )}
          </Show>
          <span class="flex-1" />
          <Show when={runs.state.history === "unavailable"}>
            <span class="shrink-0 text-[11px] text-v2-text-text-muted">
              {language.t("workbench.output.historyUnavailable")}
            </span>
          </Show>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto pb-2">
          <For each={runs.state.runs}>
            {(entry, index) => (
              <RunSection
                entry={entry}
                now={now()}
                open={
                  ui.open[entry.info.id] ??
                  (index() === 0 || entry.info.status === "running" || entry.info.id === runs.state.focus)
                }
                onToggle={(open) => setUi("open", entry.info.id, open)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function RunSection(props: { entry: RunEntry; now: number; open: boolean; onToggle: (open: boolean) => void }) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const info = () => props.entry.info
  const directory = workbench.directory
  const seconds = (ms: number) =>
    new Intl.NumberFormat(language.intl(), {
      style: "unit",
      unit: ms < 60_000 ? "second" : "minute",
      unitDisplay: "narrow",
      maximumFractionDigits: 1,
    }).format(ms < 60_000 ? ms / 1000 : ms / 60_000)
  const duration = () => {
    const start = info().startedAt
    if (start === undefined) return
    return seconds((info().finishedAt ?? props.now) - start)
  }
  // Project-relative; the project itself goes by its folder's name (UX #15).
  const unit = () => (info().unit === directory ? getFilename(directory) : shortPath(directory, info().unit))
  let section!: HTMLElement
  // A run another view pointed at (an investigation's evidence) scrolls into view.
  createEffect(() => {
    if (workbench.runs.state.focus === info().id) section.scrollIntoView({ block: "nearest" })
  })

  // Output the stream could not provide is fetched once the section is open.
  createEffect(() => {
    if (props.open && needsDetail(props.entry) && props.entry.detail === "none") void workbench.runs.detail(info().id)
  })

  return (
    <section
      ref={section}
      data-run={info().id}
      data-status={info().status}
      class="border-b border-v2-border-border-muted"
      classList={{ "bg-v2-background-bg-layer-01": workbench.runs.state.focus === info().id }}
    >
      <button
        type="button"
        aria-expanded={props.open}
        class="flex h-8 w-full items-center gap-2 px-3 text-left text-[12px] outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
        onClick={() => props.onToggle(!props.open)}
      >
        <Icon name={props.open ? "chevron-down" : "chevron-right"} size="small" />
        <span
          class={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[STATUS_TONE[info().status]]}`}
        >
          <Show when={info().status === "running"}>
            <LoaderV2 width={10} height={10} />
          </Show>
          {language.t(`workbench.run.status.${info().status}`)}
        </span>
        <span class="shrink-0 font-[530] text-v2-text-text-base">{info().checker}</span>
        <span class="min-w-0 truncate text-v2-text-text-muted" title={info().unit}>
          {unit()}
        </span>
        <span class="flex-1" />
        <Show when={info().counts}>
          {(counts) => (
            <span class="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-v2-text-text-muted">
              <span title={language.t("workbench.problems.severity.error")} class="flex items-center gap-1">
                <span aria-hidden="true" class="size-2 rounded-full bg-v2-state-fg-danger" />
                <span class="sr-only">{language.t("workbench.problems.severity.error")}</span>
                {counts().error}
              </span>
              <span title={language.t("workbench.problems.severity.warning")} class="flex items-center gap-1">
                <span aria-hidden="true" class="size-2 rounded-full bg-v2-state-fg-warning" />
                <span class="sr-only">{language.t("workbench.problems.severity.warning")}</span>
                {counts().warning}
              </span>
            </span>
          )}
        </Show>
        <Show when={duration()}>
          <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-muted">{duration()}</span>
        </Show>
        <Show when={info().exitCode !== undefined}>
          <span class="shrink-0 font-mono text-[11px] text-v2-text-text-muted">
            {language.t("workbench.output.exit", { code: info().exitCode ?? 0 })}
          </span>
        </Show>
      </button>
      <Show when={props.open}>
        <div class="pb-2">
          <div
            class="select-text truncate px-3 pb-1 font-mono text-[11px] text-v2-text-text-muted"
            title={info().command.join(" ")}
          >
            {info().command.join(" ")}
          </div>
          <Show when={info().reason}>
            <div class="px-3 pb-1 text-[12px] text-[var(--spicy-fg-warning)]">{info().reason}</div>
          </Show>
          <Switch fallback={<RunOutput entry={props.entry} />}>
            <Match when={needsDetail(props.entry) && props.entry.detail === "loading"}>
              <div class="flex items-center gap-2 px-3 py-1 text-[12px] text-v2-text-text-muted">
                <LoaderV2 width={12} height={12} />
                {language.t("workbench.output.loading")}
              </div>
            </Match>
            <Match when={!props.entry.output}>
              <div class="px-3 py-1 text-[12px] text-v2-text-text-muted">
                {needsDetail(props.entry) && props.entry.detail === "failed"
                  ? language.t("workbench.output.loadFailed")
                  : language.t("workbench.output.noOutput")}
              </div>
            </Match>
          </Switch>
          <Show when={props.entry.truncated}>
            <div class="px-3 pt-1 text-[11px] text-v2-text-text-muted">{language.t("workbench.output.truncated")}</div>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function RunOutput(props: { entry: RunEntry }) {
  const language = useLanguage()
  // Tools print paths relative to where they ran: the unit's folder, or the folder holding its config file.
  const base = () => {
    const unit = props.entry.info.unit
    return /\.[A-Za-z][\w]*$/.test(getFilename(unit)) ? getDirectory(unit) : unit
  }
  return (
    <OutputText
      text={props.entry.output}
      base={base()}
      label={language.t("workbench.output.label", { checker: props.entry.info.checker })}
      class="mx-3 max-h-80 rounded-[6px] bg-v2-background-bg-layer-01 py-1 shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
    />
  )
}

// Terminal output as lines with its ANSI styles and `file:line` links (relative paths resolve against `base`), the
// newest line kept in view.
export function OutputText(props: { text: string; base: string; label: string; class: string }) {
  const openAt = useFileLineOpener()
  const language = useLanguage()
  const lines = createMemo(() => {
    const result = ansiLines(props.text)
    return result.at(-1)?.length === 0 ? result.slice(0, -1) : result
  })
  return (
    <VirtualList items={lines()} estimate={16} follow label={props.label} class={props.class}>
      {(segments) => (
        <div class="select-text whitespace-pre-wrap break-all px-2 font-mono text-[11px] leading-4 text-v2-text-text-base">
          <For each={segments}>
            {(segment) => (
              <span style={css(segment.style)}>
                <For each={fileRefs(segment.text)}>
                  {(part) =>
                    "file" in part ? (
                      <button
                        type="button"
                        class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-v2-text-text-accent"
                        title={language.t("workbench.problems.open", { file: getFilename(part.file), line: part.line })}
                        onClick={() => openAt(resolvePath(props.base, part.file), part.line)}
                      >
                        {part.text}
                      </button>
                    ) : (
                      part.text
                    )
                  }
                </For>
              </span>
            )}
          </For>
        </div>
      )}
    </VirtualList>
  )
}

function css(style?: AnsiStyle) {
  if (!style) return undefined
  return {
    color: style.fg,
    "background-color": style.bg && `color-mix(in srgb, ${style.bg} 30%, transparent)`,
    "font-weight": style.bold ? "600" : undefined,
    opacity: style.dim ? "0.7" : undefined,
    "font-style": style.italic ? "italic" : undefined,
    "text-decoration": style.underline ? "underline" : undefined,
  }
}
