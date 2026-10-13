import { createEffect, createMemo, For, Match, on, Show, Switch, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { useEditor } from "./editor-context"
import { useFileLineOpener } from "./open-file"
import { replacementAt, searchRows, type FileMatches, type SearchMatch } from "./search"
import { useSearch } from "./search-side"
import { PanelState } from "./ui"
import { VirtualList } from "./virtual-list"

// The row actions show over the row's end on hover and focus, so hidden ones take no room.
const ACTION =
  "!absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
const FOCUS = "outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"

export default function SearchPanel() {
  const search = useSearch()
  const editor = useEditor()
  const language = useLanguage()
  const openAt = useFileLineOpener()
  const { state, setState } = search
  let input: HTMLInputElement | undefined

  createEffect(
    on(search.focusRequest, () =>
      queueMicrotask(() => {
        input?.focus()
        input?.select()
      }),
    ),
  )

  const rows = createMemo(() => searchRows(search.entries(), state.collapsed))
  const count = (entries: readonly FileMatches[]) => entries.reduce((sum, entry) => sum + entry.matches.length, 0)
  const matches = (value: number) =>
    language.t(value === 1 ? "workbench.search.matches.one" : "workbench.search.matches.other", { count: value })
  const files = (value: number) =>
    language.t(value === 1 ? "workbench.search.files.one" : "workbench.search.files.other", { count: value })
  const more = () => (state.results ? Math.max(0, state.results.total - state.results.listed) : 0)
  const unsaved = (path: string) => editor.store.dirty(path)
  const writable = (entry: FileMatches) => !!entry.file.hash && !unsaved(entry.file.path)

  const open = (path: string, line: number) => {
    search.hide()
    openAt(path, line)
  }
  const replaceAll = async () => {
    const results = state.results
    const all = search.entries()
    const targets = all.filter(writable)
    if (targets.length === 0) return
    const choice = await editor.ask({
      title: language.t("workbench.search.confirm.title", {
        matches: matches(count(targets)),
        files: files(targets.length),
      }),
      description: language.t("workbench.search.confirm.description"),
      choices: [
        { id: "cancel", label: language.t("common.cancel"), variant: "ghost" },
        { id: "replace", label: language.t("workbench.search.confirm.replace"), variant: "neutral" },
      ],
    })
    // Exactly what was confirmed, unless a newer search came in meanwhile. Files that cannot be written are listed
    // in the report as skipped.
    if (choice === "replace" && state.results === results) await search.replace(all)
  }

  return (
    <div data-component="workbench-search" class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-start gap-1 px-2 pt-2">
        <IconButton
          icon={state.replaceOpen ? "chevron-down" : "chevron-right"}
          variant="ghost"
          class="mt-0.5 shrink-0"
          aria-label={language.t("workbench.search.toggleReplace")}
          aria-expanded={state.replaceOpen}
          data-action="toggle-replace"
          onClick={() => setState("replaceOpen", (value) => !value)}
        />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="flex items-center gap-1">
            <TextInputV2
              ref={input}
              class="min-w-0 !flex-1 !w-auto"
              aria-label={language.t("workbench.search.query")}
              placeholder={language.t("workbench.search.query")}
              value={state.query.pattern}
              invalid={state.status === "failed"}
              onInput={(event) => setState("query", "pattern", event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && search.search()}
            />
            <Toggle
              option="case"
              label={language.t("workbench.search.matchCase")}
              pressed={state.query.caseSensitive}
              onToggle={() => setState("query", "caseSensitive", (value) => !value)}
            >
              Aa
            </Toggle>
            <Toggle
              option="word"
              label={language.t("workbench.search.wholeWord")}
              pressed={state.query.word}
              onToggle={() => setState("query", "word", (value) => !value)}
            >
              <span class="underline underline-offset-2">ab</span>
            </Toggle>
            <Toggle
              option="regex"
              label={language.t("workbench.search.regex")}
              pressed={state.query.regex}
              onToggle={() => setState("query", "regex", (value) => !value)}
            >
              .*
            </Toggle>
          </div>
          <Show when={state.replaceOpen}>
            <div class="flex items-center gap-1">
              <TextInputV2
                class="min-w-0 !flex-1 !w-auto"
                aria-label={language.t("workbench.search.replace")}
                placeholder={language.t("workbench.search.replace")}
                value={state.replace}
                onInput={(event) => setState("replace", event.currentTarget.value)}
              />
              <ButtonV2
                size="small"
                data-action="replace-all"
                disabled={state.replacing || !search.entries().some(writable)}
                onClick={() => void replaceAll()}
              >
                {language.t("workbench.search.replaceAll")}
              </ButtonV2>
            </div>
          </Show>
          <TextInputV2
            class="!w-auto"
            aria-label={language.t("workbench.search.include")}
            placeholder={language.t("workbench.search.include")}
            title={language.t("workbench.search.globs")}
            value={state.query.include}
            onInput={(event) => setState("query", "include", event.currentTarget.value)}
          />
          <TextInputV2
            class="!w-auto"
            aria-label={language.t("workbench.search.exclude")}
            placeholder={language.t("workbench.search.exclude")}
            title={language.t("workbench.search.globs")}
            value={state.query.exclude}
            onInput={(event) => setState("query", "exclude", event.currentTarget.value)}
          />
        </div>
      </div>

      <div class="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px] text-v2-text-text-muted">
        <span data-slot="search-summary" class="min-w-0 truncate" aria-live="polite">
          <Show when={state.status !== "failed" && search.entries().length}>
            {language.t("workbench.search.summary", {
              matches: matches(count(search.entries())),
              files: files(search.entries().length),
            })}
          </Show>
        </span>
        <Show when={state.status === "searching" || state.replacing}>
          <LoaderV2 width={12} height={12} aria-label={language.t("workbench.search.searching")} />
        </Show>
        <span class="flex-1" />
        <IconButton
          icon="reset"
          variant="ghost"
          aria-label={language.t("workbench.search.again")}
          disabled={!state.query.pattern}
          onClick={() => search.search()}
        />
      </div>

      <Show when={state.status === "failed" && state.error}>
        <div
          role="alert"
          data-slot="search-error"
          class="mx-3 mb-2 shrink-0 whitespace-pre-wrap rounded-[6px] bg-v2-state-bg-danger px-2 py-1 font-mono text-[11px] text-v2-state-fg-danger"
        >
          {state.error}
        </div>
      </Show>
      <Show when={more() > 0 && state.status !== "failed"}>
        <div
          data-slot="search-more"
          class="mx-3 mb-2 flex shrink-0 items-center gap-1.5 rounded-[6px] bg-v2-background-bg-layer-02 px-2 py-1 text-[12px] text-v2-text-text-muted"
        >
          <Icon name="warning" size="small" />
          {language.t(more() === 1 ? "workbench.search.more.one" : "workbench.search.more.other", { count: more() })}
        </div>
      </Show>
      <Show when={state.report}>
        {(report) => (
          <div
            data-component="search-report"
            role="status"
            class="mx-3 mb-2 flex shrink-0 flex-col gap-1 rounded-[6px] bg-v2-background-bg-layer-02 px-2 py-1.5 text-[12px] text-v2-text-text-base"
          >
            <div class="flex items-center gap-2">
              <span class="flex-1">
                {report().files
                  ? language.t("workbench.search.report.replaced", {
                      matches: matches(report().matches),
                      files: files(report().files),
                    })
                  : language.t("workbench.search.report.none")}
              </span>
              <IconButton
                icon="close-small"
                variant="ghost"
                aria-label={language.t("workbench.search.dismiss")}
                onClick={() => setState("report", undefined)}
              />
            </div>
            <Show when={report().skipped.length}>
              <div class="text-v2-text-text-muted">{language.t("workbench.search.report.skipped")}</div>
              <For each={report().skipped}>
                {(item) => (
                  <div
                    data-slot="search-skipped"
                    data-path={item.path}
                    data-reason={item.reason}
                    class="flex min-w-0 items-center gap-1.5 text-v2-state-fg-warning"
                  >
                    <Icon name="warning" size="small" />
                    <span class="shrink-0 font-[530]">{item.path}</span>
                    <span class="min-w-0 truncate">
                      {item.reason === "failed" ? item.message : language.t(`workbench.search.skip.${item.reason}`)}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        )}
      </Show>

      <Switch
        fallback={
          <VirtualList
            items={rows()}
            itemKey={(row) => row.key}
            estimate={26}
            label={language.t("workbench.search.tab")}
            class="flex-1 pb-2"
          >
            {(row) =>
              row.type === "file" ? (
                <FileRow
                  entry={row.entry}
                  collapsed={row.collapsed}
                  unsaved={unsaved(row.entry.file.path)}
                  replace={state.replaceOpen && writable(row.entry)}
                  busy={state.replacing}
                  onToggle={() => setState("collapsed", row.entry.file.path, (value) => !value)}
                  onReplace={() => void search.replace([row.entry])}
                />
              ) : (
                <MatchRow
                  path={row.entry.file.path}
                  match={row.match}
                  replacement={
                    state.replaceOpen && search.regex() && state.results
                      ? replacementAt(
                          row.match.line.text,
                          row.match.start,
                          row.match.line.text.slice(row.match.start, row.match.end),
                          search.regex()!,
                          state.replace,
                          state.results.query.regex,
                        )
                      : undefined
                  }
                  replace={state.replaceOpen && writable(row.entry)}
                  busy={state.replacing}
                  onOpen={open}
                  onReplace={() => void search.replace([{ file: row.entry.file, matches: [row.match] }])}
                />
              )
            }
          </VirtualList>
        }
      >
        <Match when={!state.query.pattern && !state.results}>
          <PanelState
            icon={<Icon name="magnifying-glass" />}
            title={language.t("workbench.search.hint")}
            description={language.t("workbench.search.hint.description")}
          />
        </Match>
        <Match when={state.status === "done" && rows().length === 0}>
          <PanelState title={language.t("workbench.search.empty")} />
        </Match>
      </Switch>
    </div>
  )
}

function Toggle(props: {
  option: string
  label: string
  pressed: boolean
  onToggle: () => void
  children: JSX.Element
}) {
  return (
    <button
      type="button"
      data-option={props.option}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      class={`flex h-7 min-w-7 shrink-0 items-center justify-center rounded-[6px] px-1 font-mono text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover aria-pressed:bg-v2-background-bg-layer-02 aria-pressed:text-v2-text-text-base aria-pressed:shadow-[inset_0_0_0_1px_var(--v2-border-border-muted)] ${FOCUS}`}
      onClick={() => props.onToggle()}
    >
      {props.children}
    </button>
  )
}

function FileRow(props: {
  entry: FileMatches
  collapsed: boolean
  unsaved: boolean
  replace: boolean
  busy: boolean
  onToggle: () => void
  onReplace: () => void
}) {
  const language = useLanguage()
  const path = () => props.entry.file.path
  return (
    <div
      data-component="search-file"
      data-path={path()}
      class="group relative flex h-[26px] items-center hover:bg-v2-overlay-simple-overlay-hover"
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        class={`flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 pr-3 text-left text-[12px] ${FOCUS}`}
        title={path()}
        onClick={() => props.onToggle()}
      >
        <Icon name={props.collapsed ? "chevron-right" : "chevron-down"} size="small" />
        <span class="shrink-0 font-[530] text-v2-text-text-base">{getFilename(path())}</span>
        <span class="min-w-0 truncate text-v2-text-text-faint">
          {path().includes("/") ? path().slice(0, path().lastIndexOf("/")) : ""}
        </span>
        <Show when={props.unsaved}>
          <Tag class="shrink-0" data-slot="search-unsaved" title={language.t("workbench.search.skip.unsaved")}>
            {language.t("workbench.search.badge.unsaved")}
          </Tag>
        </Show>
        <Show when={!props.entry.file.hash}>
          <Tag class="shrink-0" data-slot="search-unreadable" title={language.t("workbench.search.skip.unreadable")}>
            {language.t("workbench.search.badge.unreadable")}
          </Tag>
        </Show>
        <span
          data-slot="search-count"
          class="ml-auto shrink-0 rounded-full bg-v2-background-bg-layer-02 px-1.5 text-[11px] tabular-nums text-v2-text-text-muted"
        >
          {props.entry.matches.length}
        </span>
      </button>
      <Show when={props.replace}>
        <ButtonV2
          size="small"
          variant="neutral"
          class={ACTION}
          data-action="replace-file"
          disabled={props.busy}
          onClick={() => props.onReplace()}
        >
          {language.t("workbench.search.replaceFile")}
        </ButtonV2>
      </Show>
    </div>
  )
}

function MatchRow(props: {
  path: string
  match: SearchMatch
  replacement: string | undefined
  replace: boolean
  busy: boolean
  onOpen: (path: string, line: number) => void
  onReplace: () => void
}) {
  const language = useLanguage()
  const text = () => props.match.line.text
  // Leading indentation is left out; a match far into a long line is shown with a little of what comes before it.
  const from = () => {
    const indent = /^\s*/.exec(text())![0].length
    return props.match.start > 40 ? props.match.start - 30 : Math.min(indent, props.match.start)
  }
  const found = () => text().slice(props.match.start, props.match.end)
  return (
    <div
      data-component="search-match"
      data-path={props.path}
      data-line={props.match.line.line}
      class="group relative flex h-[26px] items-center hover:bg-v2-overlay-simple-overlay-hover"
    >
      <button
        type="button"
        class={`flex h-full min-w-0 flex-1 items-center gap-2 pl-7 pr-1 text-left ${FOCUS}`}
        title={language.t("workbench.search.open", { file: getFilename(props.path), line: props.match.line.line })}
        onClick={() => props.onOpen(props.path, props.match.line.line)}
      >
        <span class="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-v2-text-text-faint">
          {props.match.line.line}
        </span>
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-pre font-mono text-[12px] text-v2-text-text-muted">
          <Show when={props.match.start > 40}>…</Show>
          {text().slice(from(), props.match.start)}
          <Show
            when={props.replacement !== undefined}
            fallback={
              <mark data-slot="search-hit" class="rounded-[2px] bg-v2-state-bg-warning text-v2-text-text-base">
                {found()}
              </mark>
            }
          >
            <del data-slot="search-old" class="bg-v2-state-bg-danger text-v2-state-fg-danger">
              {found()}
            </del>
            <ins data-slot="search-new" class="bg-v2-state-bg-success text-v2-state-fg-success no-underline">
              {props.replacement}
            </ins>
          </Show>
          {text().slice(props.match.end)}
        </span>
      </button>
      <Show when={props.replace}>
        <ButtonV2
          size="small"
          variant="neutral"
          class={ACTION}
          data-action="replace-match"
          disabled={props.busy}
          onClick={() => props.onReplace()}
        >
          {language.t("workbench.search.replaceOne")}
        </ButtonV2>
      </Show>
    </div>
  )
}
