import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { createCommandPaletteFileOpener } from "@/components/command-palette"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useWorkbench } from "./panel"
import { filterProblems, groupProblems, problemRows, SEVERITIES, SOURCE_KINDS, type ProblemRow } from "./problems"
import { PanelState, RequestErrorState } from "./ui"
import { VirtualList } from "./virtual-list"

const SEVERITY_DOT = {
  error: "bg-v2-state-fg-danger",
  warning: "bg-v2-state-fg-warning",
  info: "bg-v2-state-fg-info",
  hint: "bg-v2-text-text-faint",
} as const

export default function ProblemsPanel() {
  const workbench = useWorkbench()
  const language = useLanguage()
  const file = useFile()
  const openFile = createCommandPaletteFileOpener()
  const problems = workbench.problems
  const filter = workbench.problemFilter

  const groups = createMemo(() => groupProblems(filterProblems(problems.state.snapshot?.problems ?? [], filter.state)))
  const rows = createMemo(() => problemRows(groups(), filter.state.collapsed))
  const busy = createMemo(
    () => problems.state.snapshot?.producers.filter((producer) => producer.state !== "idle") ?? [],
  )

  // Line navigation: select the line (the viewer highlights it), open the tab, then scroll the rendered line into view
  // once the viewer has drawn it. The viewer exposes 1-based [data-line] rows inside its shadow root.
  const open = (problem: Workbench.Problem) => {
    const path = problem.file
    if (!path) return
    const line = (problem.range?.start.line ?? 0) + 1
    file.setSelectedLines(path, { start: line, end: line })
    openFile(path)
    revealLine(line)
  }

  return (
    <div data-component="workbench-problems" class="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label={language.t("workbench.problems.filters")}
        class="flex h-10 shrink-0 items-center gap-2 overflow-x-auto px-3"
      >
        <TextInputV2
          class="!w-56 shrink-0 !self-center"
          aria-label={language.t("workbench.problems.search")}
          placeholder={language.t("workbench.problems.search")}
          value={filter.state.query}
          onInput={(event) => filter.set("query", event.currentTarget.value)}
        />
        <For each={SEVERITIES}>
          {(severity) => (
            <button
              type="button"
              data-severity={severity}
              aria-pressed={filter.state.severities[severity]}
              class="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] aria-pressed:bg-v2-background-bg-layer-02 aria-pressed:text-v2-text-text-base"
              onClick={() => filter.set("severities", severity, (value) => !value)}
            >
              <span class={`size-2 rounded-full ${SEVERITY_DOT[severity]}`} />
              {language.t("workbench.problems.severity.count", {
                label: language.t(`workbench.problems.severity.${severity}`),
                count: problems.state.snapshot?.counts[severity] ?? 0,
              })}
            </button>
          )}
        </For>
        <select
          aria-label={language.t("workbench.problems.source")}
          class="h-7 shrink-0 rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[12px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
          value={filter.state.kind}
          onChange={(event) => filter.set("kind", event.currentTarget.value as typeof filter.state.kind)}
        >
          <option value="all">{language.t("workbench.problems.source.all")}</option>
          <For each={SOURCE_KINDS}>
            {(kind) => <option value={kind}>{language.t(`workbench.problems.source.${kind}`)}</option>}
          </For>
        </select>
        <span class="flex-1" />
        <For each={busy()}>
          {(producer) => (
            <span
              data-producer={producer.producer}
              title={producer.reason}
              class="flex shrink-0 items-center gap-1 text-[11px] text-v2-text-text-muted"
            >
              <Show when={producer.state === "running"} fallback={<Icon name="warning" size="small" />}>
                <LoaderV2 width={12} height={12} />
              </Show>
              {language.t(`workbench.problems.producer.${producer.state as "running" | "unavailable" | "failed"}`, {
                tool: producer.tool,
              })}
            </span>
          )}
        </For>
        <IconButton
          icon="reset"
          variant="ghost"
          aria-label={language.t("workbench.problems.refresh")}
          onClick={() => void problems.refresh()}
        />
      </div>
      <Switch
        fallback={
          <VirtualList
            items={rows()}
            itemKey={(row) => row.key}
            estimate={26}
            label={language.t("workbench.tab.problems")}
            class="flex-1 pb-2"
          >
            {(row) => (
              <Row row={row} onOpen={open} onToggle={(key) => filter.set("collapsed", key, (value) => !value)} />
            )}
          </VirtualList>
        }
      >
        <Match when={!problems.state.snapshot && problems.state.status === "error"}>
          <RequestErrorState error={problems.state.error} onRetry={() => void problems.refresh()} />
        </Match>
        <Match when={!problems.state.snapshot}>
          <PanelState icon={<LoaderV2 />} title={language.t("workbench.problems.loading")} />
        </Match>
        <Match when={problems.state.snapshot?.problems.length === 0}>
          <PanelState title={language.t("workbench.problems.empty")} />
        </Match>
        <Match when={rows().length === 0}>
          <PanelState title={language.t("workbench.problems.empty.filtered")} />
        </Match>
      </Switch>
    </div>
  )
}

function Row(props: {
  row: ProblemRow
  onOpen: (problem: Workbench.Problem) => void
  onToggle: (key: string) => void
}) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.row.type === "file" ? props.row : undefined}>
        {(row) => (
          <button
            type="button"
            data-row="file"
            aria-expanded={!row().collapsed}
            class="flex h-[26px] w-full items-center gap-1.5 px-3 text-left text-[12px] outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
            title={row().file}
            onClick={() => props.onToggle(row().key)}
          >
            <Icon name={row().collapsed ? "chevron-right" : "chevron-down"} size="small" />
            <span class="shrink-0 font-[530] text-v2-text-text-base">
              {row().file ? getFilename(row().file) : language.t("workbench.problems.noFile")}
            </span>
            <span class="min-w-0 truncate text-v2-text-text-faint">{row().file ? getDirectory(row().file) : ""}</span>
            <span class="ml-auto shrink-0 rounded-full bg-v2-background-bg-layer-02 px-1.5 text-[11px] tabular-nums text-v2-text-text-muted">
              {row().count}
            </span>
          </button>
        )}
      </Match>
      <Match when={props.row.type === "problem" ? props.row.problem : undefined}>
        {(problem) => {
          const line = () => (problem().range?.start.line ?? 0) + 1
          const column = () => (problem().range?.start.character ?? 0) + 1
          return (
            <button
              type="button"
              data-row="problem"
              data-problem={problem().id}
              disabled={!problem().file}
              aria-label={
                problem().file
                  ? language.t("workbench.problems.open", { file: getFilename(problem().file), line: line() })
                  : undefined
              }
              class="flex h-[26px] w-full items-center gap-2 pl-8 pr-3 text-left text-[12px] outline-none enabled:hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
              onClick={() => props.onOpen(problem())}
            >
              <span
                class={`size-2 shrink-0 rounded-full ${SEVERITY_DOT[problem().severity]}`}
                title={language.t(`workbench.problems.severity.${problem().severity}`)}
              />
              <span class="min-w-0 truncate text-v2-text-text-base" title={problem().message}>
                {problem().message}
              </span>
              <Show when={problem().code !== undefined}>
                <span class="shrink-0 font-mono text-[11px] text-v2-text-text-faint">{String(problem().code)}</span>
              </Show>
              <span class="shrink-0 text-[11px] text-v2-text-text-faint">{problem().source.tool}</span>
              <Show when={problem().stale}>
                <Tag class="shrink-0" title={language.t("workbench.problems.stale.description")}>
                  {language.t("workbench.problems.stale")}
                </Tag>
              </Show>
              <Show when={problem().range}>
                <span class="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-v2-text-text-muted">
                  {line()}:{column()}
                </span>
              </Show>
            </button>
          )
        }}
      </Match>
    </Switch>
  )
}

function revealLine(line: number, attempt = 0) {
  requestAnimationFrame(() => {
    const target = [...document.querySelectorAll("diffs-container")]
      .map((host) => host.shadowRoot?.querySelector(`[data-file] [data-line="${line}"]`))
      .find((node): node is HTMLElement => node instanceof HTMLElement && node.getClientRects().length > 0)
    if (target) return target.scrollIntoView({ block: "center" })
    // ponytail: polls up to ~1s for the viewer to render; a viewer "scroll to line" API would replace this.
    if (attempt < 60) revealLine(line, attempt + 1)
  })
}
