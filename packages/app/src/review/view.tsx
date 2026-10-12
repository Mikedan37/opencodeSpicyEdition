// Agent changes review (spicy-review), lazily loaded: the inline diff with Accept / Reject per hunk (file view and
// review panel), the file view's review bar, and the review panel's "Agent changes" mode.
import {
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  For,
  getOwner,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js"
import { Dynamic, insert } from "solid-js/web"
import type { Review } from "@opencode-ai/schema/review"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import {
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN,
  SessionReviewV2,
  SessionReviewV2Sidebar,
} from "@opencode-ai/session-ui/v2/session-review-v2"
import "@opencode-ai/session-ui/v2/session-review-v2.css"
import { AgentAvatar } from "@/agenthq/avatar"
import { useCommand } from "@/context/command"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { ReviewPanelV2Props } from "@/pages/session/v2/review-panel-v2"
import { Glyph, PanelState, TONE_CLASS } from "@/workbench/ui"
import { useReview } from "./context"
import { anchor, step } from "./model"

const UP = '<path d="M6 15l6-6 6 6"/>'
const DOWN = '<path d="M6 9l6 6 6-6"/>'
const DECIDED_PREVIEW_LINES = 12

type Row = NonNullable<ReturnType<ReturnType<typeof useReview>["entry"]>>

const STATE_TONE: Record<Review.FileState, string> = {
  pending: TONE_CLASS.info,
  partial: TONE_CLASS.warning,
  accepted: TONE_CLASS.success,
  rejected: TONE_CLASS.neutral,
}

// ---------------------------------------------------------------- file view

// The file view of a file with pending agent changes: a review bar and the whole file as an inline diff.
export function ReviewFile(props: { path: string; contents: string; tab: string }) {
  const review = useReview()
  const file = useFile()
  const { tabs } = useSessionLayout()
  const row = () => review.entry(props.path)

  // Showing a file focuses its first change, so the keyboard shortcuts act on what is on screen.
  createEffect(
    on(
      () => props.path,
      (path) => {
        if (review.focus()?.path === path) return
        review.setFocus({ path, hunkID: review.entry(path)?.file.hunks[0]?.id })
      },
    ),
  )
  // Next / previous change moving to another file opens it, while this file view is the visible tab.
  const open = (path: string) => {
    void file.load(path)
    const tab = file.tab(path)
    void tabs().open(tab)
    tabs().setActive(tab)
  }
  createEffect(
    on(
      () => review.focus()?.path,
      (path) => {
        if (!path || path === props.path || tabs().active() !== props.tab) return
        if (review.entry(path)) open(path)
      },
      { defer: true },
    ),
  )

  return (
    <div data-component="review-file" data-path={props.path}>
      <Show when={row()}>{(entry) => <ReviewBar entry={entry()} path={props.path} onOpen={open} />}</Show>
      <ReviewDiff path={props.path} version={props.contents} diffStyle="unified" expand />
      <DecidedList path={props.path} />
    </div>
  )
}

function ReviewBar(props: { entry: Row; path: string; onOpen: (path: string) => void }) {
  const review = useReview()
  const language = useLanguage()
  const files = createMemo(() => review.pending().map((item) => item.local))
  const go = (direction: 1 | -1) => {
    const next = step(files(), props.path, direction)
    if (!next || next === props.path) return
    review.setFocus({ path: next, hunkID: review.entry(next)?.file.hunks[0]?.id })
    props.onOpen(next)
  }
  return (
    <div
      data-component="review-bar"
      class="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-base px-3 py-1.5 text-[12px]"
    >
      <span class="font-[530] text-v2-text-text-base">{language.t("review.bar.label")}</span>
      <AgentLabel changeset={props.entry.changeset} />
      <span class="text-v2-text-text-muted">
        {language.t("review.count.pending", { count: props.entry.file.hunks.length })}
      </span>
      <Show when={files().length > 1}>
        <span class="flex items-center gap-1 text-v2-text-text-muted">
          <IconButtonV2
            size="small"
            variant="ghost"
            data-action="previous-file"
            aria-label={language.t("review.bar.previousFile")}
            onClick={() => go(-1)}
          >
            <Glyph path={UP} />
          </IconButtonV2>
          {language.t("review.bar.file", { index: files().indexOf(props.path) + 1, total: files().length })}
          <IconButtonV2
            size="small"
            variant="ghost"
            data-action="next-file"
            aria-label={language.t("review.bar.nextFile")}
            onClick={() => go(1)}
          >
            <Glyph path={DOWN} />
          </IconButtonV2>
        </span>
      </Show>
      <span class="ml-auto flex items-center gap-1">
        <FileActions entry={props.entry} />
      </span>
      <NoticeLine changeset={props.entry.changeset.id} path={props.entry.file.path} />
    </div>
  )
}

// ---------------------------------------------------------------- shared pieces

function FileActions(props: { entry: Row }) {
  const review = useReview()
  const language = useLanguage()
  const busy = () => review.busy(props.entry.changeset.id, props.entry.file.path)
  const decide = (action: Review.Action) =>
    void review.decideFile(props.entry.changeset.id, props.entry.file.path, action)
  return (
    <>
      <Show when={props.entry.file.hunks.length > 0}>
        <ButtonV2
          size="small"
          variant="neutral"
          data-action="accept-file"
          disabled={busy()}
          onClick={() => decide("accept")}
        >
          {language.t("review.acceptFile")}
        </ButtonV2>
        <ButtonV2
          size="small"
          variant="ghost"
          data-action="reject-file"
          disabled={busy()}
          onClick={() => decide("reject")}
        >
          {language.t("review.rejectFile")}
        </ButtonV2>
      </Show>
      <Show when={props.entry.file.undoable}>
        <ButtonV2
          size="small"
          variant="ghost"
          data-action="undo"
          disabled={busy()}
          onClick={() => void review.undo(props.entry.changeset.id, props.entry.file.path)}
        >
          {language.t("review.undo")}
        </ButtonV2>
      </Show>
    </>
  )
}

// Why the last decision on this file (or on the whole changeset) was refused, until the next one.
function NoticeLine(props: { changeset: string; path?: string }) {
  const review = useReview()
  const language = useLanguage()
  return (
    <Show when={review.notice(props.changeset, props.path)}>
      {(notice) => (
        <div
          role="status"
          data-component="review-notice"
          data-reason={notice().reason ?? "error"}
          class={`flex w-full items-center gap-2 rounded px-2 py-1 text-[12px] ${
            notice().reason ? TONE_CLASS.warning : TONE_CLASS.danger
          }`}
        >
          <span class="min-w-0 flex-1">{review.explain(notice())}</span>
          <ButtonV2 size="small" variant="ghost" onClick={() => review.dismiss(props.changeset, props.path)}>
            {language.t("review.dismiss")}
          </ButtonV2>
        </div>
      )}
    </Show>
  )
}

function AgentLabel(props: { changeset: Review.ChangeSet }) {
  const review = useReview()
  const language = useLanguage()
  const agent = () => review.agent(props.changeset)
  return (
    <span data-component="review-agent" class="flex min-w-0 items-center gap-1.5">
      <Show when={agent()}>{(value) => <AgentAvatar avatar={value().avatar} name={value().name} size={16} />}</Show>
      <span data-slot="name" class="font-[530] text-v2-text-text-base">
        {agent()?.name ?? language.t("review.agent.opencode")}
      </span>
      <Show when={review.title(props.changeset)}>
        {(title) => <span class="truncate text-v2-text-text-muted">{title()}</span>}
      </Show>
    </span>
  )
}

function StateChip(props: { state: Review.FileState | Review.DecidedHunk["state"] }) {
  const language = useLanguage()
  return (
    <span
      data-component="review-state"
      data-state={props.state}
      class={`shrink-0 rounded px-1.5 text-[11px] leading-4 ${STATE_TONE[props.state]}`}
    >
      {language.t(`review.state.${props.state}`)}
    </span>
  )
}

// ---------------------------------------------------------------- inline diff

// The whole file as a diff, each pending hunk followed by its actions. Both sides and the hunks come from one server
// read, so the bars sit on the lines they act on.
function ReviewDiff(props: { path: string; version?: string; diffStyle: "unified" | "split"; expand: boolean }) {
  const review = useReview()
  const language = useLanguage()
  const fileComponent = useFileComponent()
  const row = () => review.entry(props.path)
  // Refetched when the changeset or its listed hunks change (a decision, an agent step, a reload after a 409) or the
  // open file's text does.
  const source = createMemo(
    () => {
      const entry = row()
      if (!entry || !entry.file.hunks.length) return
      const key = [
        entry.changeset.id,
        entry.file.path,
        entry.changeset.updatedAt,
        props.version ?? "",
        ...entry.file.hunks.map((hunk) => hunk.id),
      ].join("\0")
      return { key, id: entry.changeset.id, path: entry.file.path }
    },
    undefined,
    { equals: (a, b) => a?.key === b?.key },
  )
  const [content] = createResource(source, (input) => review.content(input.id, input.path).catch(() => undefined))
  // `latest` outlives its source: once nothing is pending there is no diff to show.
  const current = () => (source() ? content.latest : undefined)
  const annotations = createHunkAnnotations({
    hunks: () => current()?.hunks ?? [],
    render: (hunk) => <HunkBar hunk={hunk} path={props.path} />,
  })

  return (
    <Switch>
      <Match when={current()?.binary}>
        <div data-slot="review-binary" class="flex flex-col gap-2 px-4 py-3 text-[12px] text-v2-text-text-muted">
          {language.t("review.binary")}
        </div>
      </Match>
      <Match when={current()?.hunks.length ? current() : undefined}>
        {(value) => (
          <Dynamic
            component={fileComponent}
            mode="diff"
            before={{ name: props.path, contents: value().before ?? "" }}
            after={{ name: props.path, contents: value().after ?? "" }}
            diffStyle={props.diffStyle}
            expandUnchanged={props.expand}
            annotations={annotations.annotations()}
            renderAnnotation={annotations.render}
          />
        )}
      </Match>
      <Match when={source() && content.loading && !content.latest}>
        <div class="px-4 py-3 text-[12px] text-v2-text-text-muted">{language.t("review.loading")}</div>
      </Match>
    </Switch>
  )
}

function HunkBar(props: { hunk: Accessor<Review.Hunk>; path: string }) {
  const review = useReview()
  const language = useLanguage()
  const command = useCommand()
  let element: HTMLDivElement | undefined
  const row = () => review.entry(props.path)
  const busy = () => {
    const entry = row()
    return !entry || review.busy(entry.changeset.id, entry.file.path)
  }
  const focused = () => review.focus()?.path === props.path && review.focus()?.hunkID === props.hunk().id
  createEffect(
    on(focused, (value) => {
      if (value) element?.scrollIntoView({ block: "nearest" })
    }),
  )
  const decide = (action: Review.Action) => {
    const entry = row()
    if (!entry) return
    review.setFocus({ path: props.path, hunkID: props.hunk().id })
    void review.decideHunk(entry.changeset.id, entry.file.path, props.hunk().id, action)
  }
  const label = (action: string, id: string) => {
    const shortcut = command.keybind(id)
    return shortcut ? language.t("review.withShortcut", { action, shortcut }) : action
  }
  return (
    <div
      ref={element}
      data-component="review-hunk"
      data-hunk={props.hunk().id}
      data-state="pending"
      data-focused={focused() ? "" : undefined}
      class="my-1 flex items-center gap-2 border-l-2 px-3 py-1 font-sans text-[12px]"
      classList={{
        "border-v2-state-fg-info bg-v2-background-bg-layer-01": focused(),
        "border-transparent": !focused(),
      }}
      onClick={() => review.setFocus({ path: props.path, hunkID: props.hunk().id })}
    >
      <StateChip state="pending" />
      <ButtonV2
        size="small"
        variant="neutral"
        data-action="accept"
        disabled={busy()}
        title={label(language.t("review.accept"), "review.hunk.accept")}
        onClick={(event: MouseEvent) => {
          event.stopPropagation()
          decide("accept")
        }}
      >
        {language.t("review.accept")}
      </ButtonV2>
      <ButtonV2
        size="small"
        variant="ghost"
        data-action="reject"
        disabled={busy()}
        title={label(language.t("review.reject"), "review.hunk.reject")}
        onClick={(event: MouseEvent) => {
          event.stopPropagation()
          decide("reject")
        }}
      >
        {language.t("review.reject")}
      </ButtonV2>
    </div>
  )
}

type HunkMeta = { review: true; key: string }

// Pierre places annotation elements under diff lines; each hunk gets one host, kept while the hunk is pending, rendered
// under this component's owner so the bar can use the app's contexts.
function createHunkAnnotations(input: {
  hunks: Accessor<readonly Review.Hunk[]>
  render: (hunk: Accessor<Review.Hunk>) => JSX.Element
}) {
  const owner = getOwner()
  const nodes = new Map<string, { host: HTMLDivElement; dispose: () => void; set: (hunk: Review.Hunk) => void }>()
  const annotations = createMemo(() =>
    input.hunks().map((hunk) => ({ ...anchor(hunk), metadata: { review: true, key: hunk.id } satisfies HunkMeta })),
  )
  createEffect(() => {
    const live = new Map(input.hunks().map((hunk) => [hunk.id, hunk]))
    for (const [key, node] of nodes) {
      const hunk = live.get(key)
      if (hunk) {
        node.set(hunk)
        continue
      }
      node.dispose()
      nodes.delete(key)
    }
  })
  onCleanup(() => {
    for (const node of nodes.values()) node.dispose()
    nodes.clear()
  })
  const render = (annotation: { metadata?: unknown }) => {
    const meta = annotation.metadata as HunkMeta | undefined
    if (!meta?.review) return
    const existing = nodes.get(meta.key)
    if (existing) return existing.host
    const hunk = input.hunks().find((item) => item.id === meta.key)
    if (!hunk) return
    const host = document.createElement("div")
    const [current, set] = createSignal(hunk)
    const dispose = createRoot((dispose) => {
      insert(host, () => input.render(current))
      return dispose
    }, owner ?? undefined)
    nodes.set(meta.key, { host, dispose, set })
    return host
  }
  return { annotations, render }
}

// Hunks already decided in this file, newest first, with the change they made.
function DecidedList(props: { path: string }) {
  const review = useReview()
  const language = useLanguage()
  const decided = () => [...(review.entry(props.path)?.file.decided ?? [])].reverse()
  return (
    <Show when={decided().length}>
      <div data-component="review-decided" class="flex flex-col gap-2 px-3 py-3">
        <div class="text-[12px] font-[530] text-v2-text-text-base">{language.t("review.decided.title")}</div>
        <For each={decided()}>
          {(item) => {
            const lines = item.patch.split("\n").filter(Boolean)
            return (
              <div
                data-component="review-decided-hunk"
                data-hunk={item.id}
                data-state={item.state}
                class="flex flex-col gap-1 rounded border border-v2-border-border-muted px-2 py-1.5"
              >
                <StateChip state={item.state} />
                <Show when={lines.length} fallback={<span class="text-[12px]">{language.t("review.binary")}</span>}>
                  <pre class="overflow-x-auto whitespace-pre font-mono text-[11px] leading-4 text-v2-text-text-muted">
                    {lines.slice(0, DECIDED_PREVIEW_LINES).join("\n")}
                    {lines.length > DECIDED_PREVIEW_LINES ? "\n…" : ""}
                  </pre>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

// ---------------------------------------------------------------- review panel, "Agent changes" mode

// Same panel shell, mode switcher and settings as the other review modes; the file list groups files by changeset
// (one per agent session) and the preview is the inline diff with Accept / Reject.
export function ReviewChangesPanel(props: ReviewPanelV2Props) {
  const review = useReview()
  const language = useLanguage()
  const files = createMemo(() => {
    const query = props.state.filter().trim().toLowerCase()
    return review
      .rows()
      .map((row) => row.local)
      .filter((path) => !query || path.toLowerCase().includes(query))
  })
  const active = createMemo(() => {
    const selected = props.activeFile
    if (selected && files().includes(selected)) return selected
    return files()[0]
  })
  // The selected file takes the keyboard focus; keyboard navigation selects the focused file.
  createEffect(
    on(active, (path) => {
      if (!path || review.focus()?.path === path) return
      review.setFocus({ path, hunkID: review.entry(path)?.file.hunks[0]?.id })
    }),
  )
  createEffect(
    on(
      () => review.focus()?.path,
      (path) => {
        if (path && path !== active() && files().includes(path)) props.onSelectFile(path)
      },
      { defer: true },
    ),
  )

  const empty = () => (
    <Switch>
      <Match when={review.state.status === "loading"}>
        <PanelState title={language.t("review.loading")} />
      </Match>
      <Match when={review.state.status === "unavailable"}>
        <PanelState title={language.t("review.unavailable")} />
      </Match>
      <Match when={review.state.status === "failed"}>
        <PanelState title={language.t("review.failed", { message: review.state.error ?? "" })}>
          <ButtonV2 size="small" variant="neutral" onClick={() => void review.refresh()}>
            {language.t("workbench.retry")}
          </ButtonV2>
        </PanelState>
      </Match>
      <Match when={true}>
        <PanelState title={language.t("review.empty")} description={language.t("review.empty.description")} />
      </Match>
    </Switch>
  )

  return (
    <SessionReviewV2
      title={props.title}
      stats={<DiffChanges changes={props.diffs()} />}
      empty={empty()}
      sidebarOpen={props.state.sidebarOpened()}
      sidebar={<ChangesSidebar {...props} files={files} active={active} />}
      activeFile={active()}
      files={files()}
      onSelectFile={props.onSelectFile}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      expandMode={props.state.expandMode()}
      onExpandModeChange={props.state.setExpandMode}
      hasDiffs={files().length > 0}
      preview={
        <Show when={active()} keyed>
          {(path) => (
            <ChangesPreview path={path} diffStyle={props.diffStyle} expand={props.state.expandMode() === "expand"} />
          )}
        </Show>
      }
    />
  )
}

function ChangesSidebar(
  props: ReviewPanelV2Props & { files: Accessor<string[]>; active: Accessor<string | undefined> },
) {
  const review = useReview()
  const language = useLanguage()
  const groups = createMemo(() => {
    const visible = new Set(props.files())
    return review.list().flatMap((changeset) => {
      const rows = review.rows().filter((row) => row.changeset.id === changeset.id && visible.has(row.local))
      return rows.length ? [{ changeset, rows }] : []
    })
  })
  return (
    <SessionReviewV2Sidebar
      open={props.state.sidebarOpened()}
      transition={props.state.sidebarTransition()}
      title={props.title}
      stats={<DiffChanges changes={props.diffs()} />}
      filter={props.state.filter()}
      onFilterChange={props.state.setFilter}
      width={props.state.sidebarWidth()}
      onWidthChange={props.state.resizeSidebar}
      minWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN}
      maxWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX}
    >
      <div class="flex flex-col gap-3 py-1">
        <For each={groups()}>
          {(group) => {
            const busy = () => review.busy(group.changeset.id)
            const pending = () => group.changeset.counts.pending > 0
            return (
              <section
                data-component="review-changeset"
                data-changeset={group.changeset.id}
                class="flex flex-col gap-1"
              >
                <div class="flex flex-col gap-1 px-2 text-[12px]">
                  <AgentLabel changeset={group.changeset} />
                  <div class="flex flex-wrap items-center gap-2 text-v2-text-text-muted">
                    <span>{language.t("review.count.pending", { count: group.changeset.counts.pending })}</span>
                    <span>{language.t("review.count.accepted", { count: group.changeset.counts.accepted })}</span>
                    <span>{language.t("review.count.rejected", { count: group.changeset.counts.rejected })}</span>
                  </div>
                  <Show when={pending()}>
                    <div class="flex items-center gap-1">
                      <ButtonV2
                        size="small"
                        variant="neutral"
                        data-action="accept-all"
                        disabled={busy()}
                        onClick={() => void review.decideAll(group.changeset.id, "accept")}
                      >
                        {language.t("review.acceptAll")}
                      </ButtonV2>
                      <ButtonV2
                        size="small"
                        variant="ghost"
                        data-action="reject-all"
                        disabled={busy()}
                        onClick={() => void review.decideAll(group.changeset.id, "reject")}
                      >
                        {language.t("review.rejectAll")}
                      </ButtonV2>
                    </div>
                  </Show>
                  <NoticeLine changeset={group.changeset.id} />
                </div>
                <For each={group.rows}>
                  {(row) => (
                    <button
                      type="button"
                      data-component="review-file-row"
                      data-path={row.local}
                      data-state={row.file.state}
                      aria-current={props.active() === row.local ? "true" : undefined}
                      class="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-v2-background-bg-layer-01"
                      classList={{ "bg-v2-background-bg-layer-02": props.active() === row.local }}
                      onClick={() => props.onSelectFile(row.local)}
                    >
                      <FileIcon node={{ path: row.local, type: "file" }} />
                      <span class="min-w-0 flex-1 truncate text-v2-text-text-base">{getFilename(row.local)}</span>
                      <Show when={row.file.hunks.length}>
                        <span data-slot="pending" class="tabular-nums text-v2-text-text-muted">
                          {language.t("review.count.pending", { count: row.file.hunks.length })}
                        </span>
                      </Show>
                      <StateChip state={row.file.state} />
                    </button>
                  )}
                </For>
              </section>
            )
          }}
        </For>
      </div>
    </SessionReviewV2Sidebar>
  )
}

function ChangesPreview(props: { path: string; diffStyle: "unified" | "split"; expand: boolean }) {
  const review = useReview()
  const language = useLanguage()
  const file = useFile()
  const { tabs } = useSessionLayout()
  // The file view shows the same changes inline, with the whole file around them.
  const open = () => {
    void file.load(props.path)
    const tab = file.tab(props.path)
    void tabs().open(tab)
    tabs().setActive(tab)
  }
  return (
    <Show when={review.entry(props.path)}>
      {(entry) => (
        <>
          <div data-slot="session-review-v2-file-header">
            <div data-slot="session-review-v2-file-title">
              <div data-slot="session-review-v2-file-status" data-type={entry().file.status}>
                {language.t(`review.status.${entry().file.status}`)}
              </div>
              <FileIcon node={{ path: props.path, type: "file" }} />
              <span data-slot="session-review-v2-file-name">{getFilename(props.path)}</span>
              <Show when={props.path.includes("/")}>
                <span data-slot="session-review-v2-file-path">{getDirectory(props.path)}</span>
              </Show>
            </div>
            <div class="flex items-center gap-2">
              <StateChip state={entry().file.state} />
              <DiffChanges changes={entry().file} />
              <Show when={entry().file.status !== "deleted"}>
                <ButtonV2 size="small" variant="ghost" data-action="open-file" onClick={open}>
                  {language.t("review.openFile")}
                </ButtonV2>
              </Show>
              <FileActions entry={entry()} />
            </div>
          </div>
          <div class="px-3">
            <NoticeLine changeset={entry().changeset.id} path={entry().file.path} />
          </div>
          <div data-slot="session-review-v2-diff-scroll">
            <ReviewDiff path={props.path} diffStyle={props.diffStyle} expand={props.expand} />
            <DecidedList path={props.path} />
          </div>
        </>
      )}
    </Show>
  )
}
