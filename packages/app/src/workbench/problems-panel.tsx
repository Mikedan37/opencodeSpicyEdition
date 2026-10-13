import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useRelativeTime } from "./clock"
import { errorText } from "./client"
import { useEditor } from "./editor-context"
import { HandoffMenu } from "./handoff"
import { useWorkbench } from "./panel"
import {
  crashReason,
  filterProblems,
  groupProblems,
  lastChecked,
  problemRows,
  SEVERITIES,
  SOURCE_KINDS,
  sourceLabel,
  sourcesOf,
  type ProblemRow,
  withLsp,
} from "./problems"
import { latestRun, problemSnapshot, shortPath } from "./snapshot"
import { PanelState, RequestErrorState } from "./ui"
import { VirtualList } from "./virtual-list"
import { useFileLineOpener } from "./open-file"

const SEVERITY_DOT = {
  error: "bg-v2-state-fg-danger",
  warning: "bg-v2-state-fg-warning",
  info: "bg-v2-state-fg-info",
  hint: "bg-v2-text-text-faint",
} as const

export default function ProblemsPanel() {
  const workbench = useWorkbench()
  const language = useLanguage()
  const openAt = useFileLineOpener()
  const problems = workbench.problems
  const filter = workbench.problemFilter

  const groups = createMemo(() => groupProblems(filterProblems(problems.state.snapshot?.problems ?? [], filter.state)))
  const rows = createMemo(() => problemRows(groups(), filter.state.collapsed))
  const busy = createMemo(
    () => problems.state.snapshot?.producers.filter((producer) => producer.state !== "idle") ?? [],
  )

  const open = (problem: Workbench.Problem) => {
    if (problem.file) openAt(problem.file, (problem.range?.start.line ?? 0) + 1)
  }
  const crashed = (problem: Workbench.Problem) => crashReason(problem, problems.state.snapshot?.producers ?? [])
  // UI-07: what "Fix with agent" sends, made when a target is picked: the problems, the lines around them and the
  // latest verification run.
  const snapshotOf = async (list: readonly Workbench.Problem[], file: string | undefined) => {
    const [source] = await Promise.all([
      file
        ? workbench.client.readFile(shortPath(workbench.directory, file)).then(
            (result) => ({ text: result.content }),
            (error: unknown) => ({ error: errorText(error) }),
          )
        : undefined,
      workbench.runs.load(),
    ])
    const runs = workbench.runs.state.runs.map((entry) => entry.info)
    return problemSnapshot({ root: workbench.directory, file, problems: list, source, run: latestRun(list, runs) })
  }
  const fix = (problem: Workbench.Problem) => snapshotOf([problem], problem.file)
  const fixFile = (file: string | undefined) =>
    snapshotOf(groups().find((group) => group.file === file)?.problems ?? [], file)
  const lspOff = () => problems.state.snapshot?.lsp === "off"
  // Nothing has reported yet: no checker run and no language server, so an empty list proves nothing.
  const unchecked = () => !problems.state.snapshot?.producers.length
  const relative = useRelativeTime()
  const checked = createMemo(() => lastChecked(problems.state.snapshot?.producers ?? []))
  const editor = useEditor()
  const serverSDK = useServerSDK()
  // DIAG-12: "lsp": true in the project's opencode config (opencode.jsonc, else opencode.json, else a new
  // opencode.json), after the user agrees; then the server reloads the project with it.
  const enableLsp = async () => {
    const read = (path: string) =>
      workbench.client.readFile(path).then(
        (result) => ({ path, ...result }),
        () => undefined,
      )
    const file = (await read("opencode.jsonc")) ?? (await read("opencode.json"))
    const path = file?.path ?? "opencode.json"
    const choice = await editor.ask({
      title: language.t("workbench.problems.lsp.confirm.title"),
      description: language.t("workbench.problems.lsp.confirm.description", { file: path }),
      choices: [
        { id: "cancel", label: language.t("common.cancel"), variant: "ghost" },
        { id: "enable", label: language.t("workbench.problems.lsp.enable"), variant: "neutral" },
      ],
    })
    if (choice !== "enable") return
    await workbench.client
      .writeFile({
        path,
        content: file ? withLsp(file.content) : NEW_CONFIG,
        baseHash: file?.hash ?? null,
      })
      .then(() => serverSDK().client.instance.dispose({ directory: workbench.directory }))
      .then(() => problems.refresh())
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("workbench.problems.lsp.failed"),
          description: errorText(error),
        }),
      )
  }
  const runChecks = () => (
    <ButtonV2
      size="small"
      variant="neutral"
      data-action="problems-check"
      class="shrink-0 whitespace-nowrap"
      disabled={workbench.runs.state.checking}
      onClick={() => void workbench.runChecks()}
    >
      <Show when={workbench.runs.state.checking}>
        <LoaderV2 width={12} height={12} />
      </Show>
      {language.t("workbench.output.run")}
    </ButtonV2>
  )
  const turnOnLsp = () => (
    <ButtonV2
      size="small"
      variant="neutral"
      data-action="problems-lsp"
      class="shrink-0 whitespace-nowrap"
      onClick={() => void enableLsp()}
    >
      {language.t("workbench.problems.lsp.enable")}
    </ButtonV2>
  )

  return (
    <div data-component="workbench-problems" class="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label={language.t("workbench.problems.filters")}
        class="flex min-h-10 shrink-0 flex-wrap items-center gap-2 px-3 py-1.5"
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
        <Show when={checked()}>
          {(value) => (
            <span data-slot="problems-checked" class="shrink-0 whitespace-nowrap text-[11px] text-v2-text-text-muted">
              {language.t("workbench.problems.lastChecked", {
                time: relative(value().at),
                tools: value().tools.join(", "),
              })}
            </span>
          )}
        </Show>
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
        {runChecks()}
        <IconButton
          icon="reset"
          variant="ghost"
          aria-label={language.t("workbench.problems.refresh")}
          onClick={() => void problems.refresh()}
        />
      </div>
      {/* DIAG-12: the project's config leaves language servers off. */}
      <Show when={lspOff() && !!problems.state.snapshot?.problems.length}>
        <div
          data-slot="problems-lsp-off"
          class="mx-3 mb-1 flex shrink-0 items-center gap-1.5 rounded-[6px] bg-v2-background-bg-layer-02 px-2 py-1 text-[12px] text-v2-text-text-muted"
        >
          <Icon name="warning" size="small" />
          <span class="min-w-0 flex-1">{language.t("workbench.problems.lspOff")}</span>
          {turnOnLsp()}
        </div>
      </Show>
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
              <Row
                row={row}
                crashed={crashed}
                onOpen={open}
                onToggle={(key) => filter.set("collapsed", key, (value) => !value)}
                onFix={fix}
                onFixFile={fixFile}
              />
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
          <PanelState
            title={language.t(unchecked() ? "workbench.problems.unchecked" : "workbench.problems.empty")}
            description={
              lspOff()
                ? language.t("workbench.problems.lspOff")
                : unchecked()
                  ? language.t("workbench.problems.unchecked.description")
                  : undefined
            }
          >
            {runChecks()}
            <Show when={lspOff()}>{turnOnLsp()}</Show>
          </PanelState>
        </Match>
        <Match when={rows().length === 0}>
          <PanelState title={language.t("workbench.problems.empty.filtered")} />
        </Match>
      </Switch>
    </div>
  )
}

const NEW_CONFIG = `{\n  "$schema": "https://opencode.ai/config.json",\n  "lsp": true\n}\n`

// The row's "with agent" action shows on hover and focus, and stays while its picker is open.
const ACTION =
  "mr-2 h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[expanded]:opacity-100"

function Row(props: {
  row: ProblemRow
  crashed: (problem: Workbench.Problem) => string | undefined
  onOpen: (problem: Workbench.Problem) => void
  onToggle: (key: string) => void
  onFix: (problem: Workbench.Problem) => Promise<string>
  onFixFile: (file: string | undefined) => Promise<string>
}) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.row.type === "file" ? props.row : undefined}>
        {(row) => (
          <div class="group flex h-[26px] items-center hover:bg-v2-overlay-simple-overlay-hover">
            <button
              type="button"
              data-row="file"
              aria-expanded={!row().collapsed}
              class="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 text-left text-[12px] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
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
            <HandoffMenu
              label={language.t("workbench.handoff.fixFile")}
              class={ACTION}
              build={() => props.onFixFile(row().file)}
            />
          </div>
        )}
      </Match>
      <Match when={props.row.type === "problem" ? props.row.problem : undefined}>
        {(problem) => {
          const line = () => (problem().range?.start.line ?? 0) + 1
          const column = () => (problem().range?.start.character ?? 0) + 1
          return (
            <div class="group flex h-[26px] items-center hover:bg-v2-overlay-simple-overlay-hover">
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
                class="flex h-full min-w-0 flex-1 items-center gap-2 pl-8 pr-1 text-left text-[12px] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
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
                <span
                  data-slot="problem-sources"
                  class="shrink-0 text-[11px] text-v2-text-text-faint"
                  title={sourcesOf(problem())
                    .map((source) => `${source.tool}: ${source.kind}${source.channel ? ` (${source.channel})` : ""}`)
                    .join("\n")}
                >
                  {sourceLabel(problem())}
                </span>
                <Show when={problem().stale}>
                  <Tag
                    class="shrink-0"
                    data-slot="problem-stale"
                    title={
                      props.crashed(problem()) === undefined
                        ? language.t("workbench.problems.stale.description")
                        : language.t("workbench.problems.stale.crashed", { reason: props.crashed(problem())! })
                    }
                  >
                    {language.t("workbench.problems.stale")}
                  </Tag>
                </Show>
                <Show when={problem().range}>
                  <span class="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-v2-text-text-muted">
                    {line()}:{column()}
                  </span>
                </Show>
              </button>
              <HandoffMenu
                label={language.t("workbench.handoff.fix")}
                class={ACTION}
                build={() => props.onFix(problem())}
              />
            </div>
          )
        }}
      </Match>
    </Switch>
  )
}
