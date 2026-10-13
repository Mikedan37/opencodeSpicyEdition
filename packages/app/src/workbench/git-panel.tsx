// The Files Changed panel's commit area and the Git palette commands. State: git.ts; routes: /workbench/git. Push and
// pull requests reach the network, so each is confirmed in a dialog first, and push never forces. The area is a one-line
// bar until the human expands it (remembered per workspace), and it stays a bar while the Agent changes review has
// undecided hunks: the review comes first, and the bar never takes the review's room.
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  onCleanup,
  runWithOwner,
  Show,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { WorkbenchGit } from "@opencode-ai/schema/workbench-git"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { formatKeybind, useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionKey } from "@/pages/session/session-layout"
import { useReview } from "@/review/context"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { canCommit, changes, createGitState, STATE_LETTER, type GitState } from "./git"
import { useWorkbench } from "./panel"
import { Glyph } from "./ui"

const BRANCH =
  '<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="7.5" r="2"/><path d="M7 7.5v9M17 9.5c0 4.5-10 3-10 7"/>'
const REFRESH = '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'
const COLLAPSE = '<path d="M7 10l5 5 5-5"/>'
const SECTION = "text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted"
const LINK = "rounded px-1 text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base disabled:opacity-50"
const ALERT =
  "select-text whitespace-pre-wrap break-words rounded-[6px] bg-v2-state-bg-danger px-2 py-1.5 text-[12px] text-v2-state-fg-danger"
const SELECT =
  "h-8 w-full rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[13px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none"

type Git = GitState & { unreviewed: () => number }

export const { use: useGit, provider: GitProvider } = createSimpleContext({
  name: "Git",
  gate: false,
  init: () => {
    const workbench = useWorkbench()
    const review = useReview()
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const command = useCommand()
    const language = useLanguage()
    const dialog = useDialog()
    const layout = useLayout()
    const { sessionKey } = useSessionKey()
    const owner = getOwner()
    const state = createGitState(workbench.client)
    void state.refresh()

    // Status follows the files and the branch (debounced): agents, terminals and editors change both.
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = sdk().event.listen((event) => {
      const type = (event.details as { type?: string }).type
      if (type !== "file.watcher.updated" && type !== "filesystem.changed" && type !== "vcs.branch.updated") return
      clearTimeout(timer)
      timer = setTimeout(() => void state.refresh(), 300)
    })
    onCleanup(() => {
      stop()
      clearTimeout(timer)
    })

    // Hunks the Agent changes review has not decided yet.
    const unreviewed = createMemo(() => review.pending().reduce((sum, row) => sum + row.file.hunks.length, 0))
    const git: Git = { ...state, unreviewed }
    // Collapsed by default, remembered per workspace; forced collapsed while hunks are undecided.
    const [view, setView] = persisted(
      Persist.serverWorkspace(serverSDK().scope, sdk().directory, "git-panel"),
      createStore({ expanded: false }),
    )
    const expanded = () => view.expanded && !unreviewed()

    // A layout view only while a command needs it, in a root disposed right away (as workbench/panel.tsx does).
    const openPanel = () =>
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          const view = layout.view(sessionKey())
          if (!view.reviewPanel.opened()) view.reviewPanel.open()
          dispose()
        }),
      )
    // The message box takes focus when a command asked for it, once it is on screen.
    const [focusTick, setFocusTick] = createSignal(0)
    let focusWanted = false
    const focusMessage = () => {
      openPanel()
      setView("expanded", true)
      focusWanted = true
      setFocusTick((tick) => tick + 1)
    }
    const takeFocus = () => {
      const wanted = focusWanted
      focusWanted = false
      return wanted
    }

    const commit = () => {
      if (!canCommit(state.state.status, state.state.message) || state.state.busy || unreviewed()) return
      void state.commit().then((result) => {
        if (!result) return
        showToast({
          variant: "success",
          title: language.t("workbench.git.committed", { sha: result.sha.slice(0, 7) }),
          description: result.subject,
        })
      })
    }
    const generate = () => {
      focusMessage()
      void state.generate()
    }
    const push = () => {
      state.clearError()
      dialog.show(() => <PushDialog git={git} />)
    }
    const pullRequest = () => {
      state.clearError()
      dialog.show(() => <PullRequestDialog git={git} />)
    }
    const branches = () => {
      state.clearError()
      dialog.show(() => <BranchDialog git={git} />)
    }
    const all = (staged: boolean) => {
      const status = state.state.status
      if (!status) return
      const paths = (staged ? status.staged : changes(status)).flatMap(pathsOf)
      if (paths.length) void (staged ? state.unstage(paths) : state.stage(paths))
    }

    command.register("git", () => {
      const category = language.t("workbench.git.command.category")
      const status = state.state.status
      const busy = !!state.state.busy
      const remote = !!status?.branch && !!status.remotes.length
      // The commit area opens only once the Agent changes review is decided.
      const blocked = !status || !!unreviewed()
      return [
        {
          id: "git.show",
          title: language.t("workbench.git.command.show"),
          category,
          disabled: blocked,
          onSelect: focusMessage,
        },
        {
          id: "git.commit",
          title: language.t("workbench.git.command.commit"),
          category,
          disabled: blocked || !status?.staged.length || busy,
          // Without a message the box takes focus; with one, the commit runs as the button would.
          onSelect: () => (state.state.message.trim() ? commit() : focusMessage()),
        },
        {
          id: "git.generate",
          title: language.t("workbench.git.command.generate"),
          category,
          disabled: blocked || !status?.generate.available || !status.staged.length || busy,
          onSelect: generate,
        },
        {
          id: "git.stageAll",
          title: language.t("workbench.git.command.stageAll"),
          category,
          disabled: !status || !changes(status).length || busy,
          onSelect: () => all(false),
        },
        {
          id: "git.unstageAll",
          title: language.t("workbench.git.command.unstageAll"),
          category,
          disabled: !status?.staged.length || busy,
          onSelect: () => all(true),
        },
        {
          id: "git.push",
          title: language.t("workbench.git.command.push"),
          category,
          disabled: !remote || busy,
          onSelect: push,
        },
        {
          id: "git.pr",
          title: language.t("workbench.git.command.pr"),
          category,
          disabled: !remote || busy,
          onSelect: pullRequest,
        },
        {
          id: "git.branch",
          title: language.t("workbench.git.command.branch"),
          category,
          disabled: !status || busy,
          onSelect: branches,
        },
      ]
    })

    return {
      git,
      expanded,
      setExpanded: (value: boolean) => setView("expanded", value),
      focusMessage,
      focusTick,
      takeFocus,
      commit,
      generate,
      push,
      pullRequest,
      branches,
      all,
      showReview: review.show,
    }
  },
})

// A rename or copy is staged and unstaged together with its old path.
const pathsOf = (file: WorkbenchGit.File) => (file.from ? [file.path, file.from] : [file.path])

export function GitCommitArea() {
  const panel = useGit()
  const language = useLanguage()
  const git = panel.git
  let input: HTMLTextAreaElement | undefined
  createEffect(() => {
    panel.focusTick()
    if (input && panel.takeFocus()) input.focus()
  })
  const busy = () => !!git.state.busy

  return (
    <Show when={git.state.status}>
      {(status) => (
        <Show
          when={panel.expanded()}
          fallback={
            // One line: the review above keeps the panel.
            <div
              data-component="git-commit-area"
              data-state="collapsed"
              aria-label={language.t("workbench.git.title")}
              class="flex h-9 shrink-0 items-center gap-2 border-t border-v2-border-border-muted px-3 text-[12px] text-v2-text-text-base"
            >
              <BranchButton status={status()} disabled={busy()} onClick={panel.branches} />
              <span data-slot="git-change-count" class="shrink-0 text-v2-text-text-muted">
                {language.plural(
                  "workbench.git.changeCount",
                  // a file partly staged is one change
                  new Set([...status().staged, ...status().unstaged, ...status().untracked].map((file) => file.path))
                    .size,
                )}
              </span>
              <Show when={git.unreviewed()}>
                <button
                  type="button"
                  data-slot="git-unreviewed"
                  class="min-w-0 truncate text-v2-state-fg-warning hover:underline"
                  title={language.plural("workbench.git.unreviewed", git.unreviewed())}
                  onClick={panel.showReview}
                >
                  {language.t("workbench.git.reviewFirst")}
                </button>
              </Show>
              <span class="flex-1" />
              <ButtonV2
                type="button"
                size="small"
                variant="neutral"
                data-action="git-expand"
                class="shrink-0"
                disabled={!!git.unreviewed()}
                onClick={panel.focusMessage}
              >
                {language.t("workbench.git.expand")}
              </ButtonV2>
            </div>
          }
        >
          {/* At most 40% of the panel, scrolling inside itself: the review keeps the rest. */}
          <section
            data-component="git-commit-area"
            data-state="expanded"
            aria-label={language.t("workbench.git.title")}
            class="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto border-t border-v2-border-border-muted px-3 py-2 text-[12px] text-v2-text-text-base"
          >
            <div class="flex min-w-0 items-center gap-1.5">
              <BranchButton status={status()} disabled={busy()} onClick={panel.branches} />
              <Show when={status().upstream}>
                {(upstream) => <span class="min-w-0 truncate text-v2-text-text-faint">{upstream()}</span>}
              </Show>
              <Show when={status().ahead}>
                <span data-slot="git-ahead" class="text-v2-text-text-muted">
                  {language.t("workbench.git.ahead", { count: status().ahead })}
                </span>
              </Show>
              <Show when={status().behind}>
                <span class="text-v2-text-text-muted">
                  {language.t("workbench.git.behind", { count: status().behind })}
                </span>
              </Show>
              <span class="flex-1" />
              <Show when={busy()}>
                <LoaderV2 width={12} height={12} />
              </Show>
              <IconButtonV2
                size="small"
                variant="ghost"
                data-action="git-refresh"
                aria-label={language.t("workbench.git.refresh")}
                onClick={() => void git.refresh()}
              >
                <Glyph path={REFRESH} size={14} />
              </IconButtonV2>
              <IconButtonV2
                size="small"
                variant="ghost"
                data-action="git-collapse"
                aria-label={language.t("workbench.git.collapse")}
                onClick={() => panel.setExpanded(false)}
              >
                <Glyph path={COLLAPSE} size={14} />
              </IconButtonV2>
            </div>
            <FileGroup kind="staged" files={status().staged} git={git} onAll={() => panel.all(true)} />
            <FileGroup kind="changes" files={changes(status())} git={git} onAll={() => panel.all(false)} />
            <TextareaV2
              ref={(element: HTMLTextAreaElement) => {
                input = element
                // Opened by "Commit…" or a command: the message box takes focus once it is in the page.
                if (panel.takeFocus()) queueMicrotask(() => element.focus())
              }}
              name="commit-message"
              rows={3}
              class="!w-full"
              aria-label={language.t("workbench.git.message")}
              placeholder={language.t("workbench.git.message.placeholder", {
                keys: formatKeybind("mod+enter", language.t),
              })}
              value={git.state.message}
              onInput={(event) => git.setMessage(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
                event.preventDefault()
                panel.commit()
              }}
            />
            <Show when={git.state.error}>
              {(error) => (
                <div role="alert" data-slot="git-error" class={ALERT}>
                  {error()}
                </div>
              )}
            </Show>
            <div class="flex flex-wrap items-center gap-2">
              <span
                title={
                  status().generate.available
                    ? language.t("workbench.git.generate.title", { model: status().generate.model ?? "" })
                    : status().generate.reason
                }
              >
                <ButtonV2
                  type="button"
                  size="small"
                  variant="neutral"
                  data-action="git-generate"
                  disabled={!status().generate.available || !status().staged.length || busy()}
                  onClick={panel.generate}
                >
                  {language.t("workbench.git.generate")}
                </ButtonV2>
              </span>
              <span class="flex-1" />
              <ButtonV2
                type="button"
                size="small"
                variant="ghost"
                data-action="git-push"
                disabled={!status().branch || !status().remotes.length || busy()}
                onClick={panel.push}
              >
                {language.t(status().upstream ? "workbench.git.push" : "workbench.git.publish")}
              </ButtonV2>
              <ButtonV2
                type="button"
                size="small"
                variant="ghost"
                data-action="git-pr"
                disabled={!status().branch || !status().remotes.length || busy()}
                onClick={panel.pullRequest}
              >
                {language.t("workbench.git.pr")}
              </ButtonV2>
              <ButtonV2
                type="button"
                size="small"
                variant="contrast"
                data-action="git-commit"
                disabled={!canCommit(status(), git.state.message) || busy()}
                onClick={panel.commit}
              >
                {language.t("workbench.git.commit")}
              </ButtonV2>
            </div>
          </section>
        </Show>
      )}
    </Show>
  )
}

function BranchButton(props: { status: WorkbenchGit.Status; disabled: boolean; onClick: () => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      data-action="git-branches"
      class="flex min-w-0 items-center gap-1 rounded-[4px] px-1 py-0.5 hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
      title={language.t("workbench.git.branch.switch")}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Glyph path={BRANCH} size={14} />
      <span data-slot="git-branch" class="truncate font-[530]">
        {props.status.branch ?? language.t("workbench.git.detached")}
      </span>
    </button>
  )
}

function FileGroup(props: {
  kind: "staged" | "changes"
  files: readonly WorkbenchGit.File[]
  git: Git
  onAll: () => void
}) {
  const language = useLanguage()
  const staged = () => props.kind === "staged"
  const toggle = (file: WorkbenchGit.File) =>
    void (staged() ? props.git.unstage(pathsOf(file)) : props.git.stage(pathsOf(file)))
  return (
    <div data-component="git-files" data-kind={props.kind}>
      <div class="flex items-center gap-2">
        <span class={SECTION}>
          {language.t(staged() ? "workbench.git.staged" : "workbench.git.changes")} {props.files.length}
        </span>
        <span class="flex-1" />
        <Show when={props.files.length}>
          <button
            type="button"
            data-action={staged() ? "git-unstage-all" : "git-stage-all"}
            class={LINK}
            disabled={!!props.git.state.busy}
            onClick={props.onAll}
          >
            {language.t(staged() ? "workbench.git.unstageAll" : "workbench.git.stageAll")}
          </button>
        </Show>
      </div>
      <Show
        when={props.files.length}
        fallback={
          <div class="py-0.5 text-v2-text-text-faint">
            {language.t(staged() ? "workbench.git.staged.empty" : "workbench.git.changes.empty")}
          </div>
        }
      >
        <ul class="max-h-40 overflow-y-auto">
          <For each={props.files}>
            {(file) => (
              <li data-path={file.path} data-state={file.state} class="flex min-w-0 items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  checked={staged()}
                  disabled={!!props.git.state.busy}
                  aria-label={language.t(staged() ? "workbench.git.unstage" : "workbench.git.stage", {
                    path: file.path,
                  })}
                  onChange={() => toggle(file)}
                />
                <span
                  class="w-3 shrink-0 font-mono text-v2-text-text-muted"
                  title={language.t(`workbench.git.state.${file.state}`)}
                >
                  {STATE_LETTER[file.state]}
                </span>
                <span class="min-w-0 truncate" title={file.from ? `${file.from} → ${file.path}` : file.path}>
                  {file.path}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

// The dialogs render under the dialog stack's owner, outside GitProvider: they get the state as a prop.
function GitDialog(props: {
  title: string
  name: string
  git: Git
  onSubmit?: () => void
  submit: JSX.Element
  // Nothing left to submit (the pull request exists): Cancel reads Close.
  done?: boolean
  children: JSX.Element
}) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <Dialog fit>
      <form
        class="contents"
        data-component={props.name}
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.git.state.busy && !props.done) props.onSubmit?.()
        }}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex max-h-[min(560px,calc(100vh-160px))] w-[min(480px,calc(100vw-48px))] flex-col gap-3 overflow-y-auto px-4 pt-4 pb-1 text-[13px] text-v2-text-text-base">
          {props.children}
          <Show when={props.git.state.error}>
            {(error) => (
              <div role="alert" data-slot="git-dialog-error" class={ALERT}>
                {error()}
              </div>
            )}
          </Show>
        </DialogBody>
        <DialogFooter>
          <Show when={props.git.state.busy}>
            <LoaderV2 width={12} height={12} />
          </Show>
          <span class="flex-1" />
          <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
            {language.t(props.done ? "common.close" : "common.cancel")}
          </ButtonV2>
          {props.submit}
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function PushDialog(props: { git: Git }) {
  const language = useLanguage()
  const dialog = useDialog()
  const status = () => props.git.state.status
  const branch = () => status()?.branch ?? ""
  const remotes = () => status()?.remotes ?? []
  const [remote, setRemote] = createSignal(remotes().includes("origin") ? "origin" : (remotes()[0] ?? ""))
  const submit = () => {
    const upstream = status()?.upstream
    void props.git.push(upstream ? {} : { setUpstream: true, remote: remote() }).then((result) => {
      if (!result) return
      dialog.close()
      showToast({
        variant: "success",
        title: language.t("workbench.git.pushed", { upstream: result.upstream }),
        description: result.output || undefined,
      })
    })
  }
  return (
    <GitDialog
      name="git-push-dialog"
      title={language.t("workbench.git.push.title", { branch: branch() })}
      git={props.git}
      onSubmit={submit}
      submit={
        <ButtonV2
          type="submit"
          variant="contrast"
          data-action="git-push-confirm"
          disabled={!remotes().length || !!props.git.state.busy}
        >
          {language.t(status()?.upstream ? "workbench.git.push" : "workbench.git.publish")}
        </ButtonV2>
      }
    >
      <Show
        when={remotes().length}
        fallback={<p data-slot="git-push-summary">{language.t("workbench.git.push.noRemote")}</p>}
      >
        <Show
          when={status()?.upstream}
          fallback={
            <>
              <p data-slot="git-push-summary">{language.t("workbench.git.push.publish", { branch: branch() })}</p>
              <Field>
                <Field.Label>{language.t("workbench.git.push.remote")}</Field.Label>
                <select
                  name="remote"
                  class={SELECT}
                  value={remote()}
                  onChange={(event) => setRemote(event.currentTarget.value)}
                >
                  <For each={remotes()}>{(name) => <option value={name}>{name}</option>}</For>
                </select>
              </Field>
            </>
          }
        >
          {(upstream) => (
            <p data-slot="git-push-summary">
              {language.t("workbench.git.push.upstream", { branch: branch(), upstream: upstream() })}
              <Show when={status()?.ahead}> {language.t("workbench.git.ahead", { count: status()?.ahead ?? 0 })}</Show>
            </p>
          )}
        </Show>
      </Show>
      <p class="text-[12px] text-v2-text-text-muted">{language.t("workbench.git.push.never")}</p>
    </GitDialog>
  )
}

function PullRequestDialog(props: { git: Git }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [form, setForm] = createStore({ title: "", body: "", url: undefined as string | undefined })
  const status = () => props.git.state.status
  const branch = () => status()?.branch ?? ""
  const submit = () => {
    const title = form.title.trim()
    void props.git
      .pullRequest(title ? { title, body: form.body } : {})
      .then((result) => result && setForm("url", result.url))
  }
  return (
    <GitDialog
      name="git-pr-dialog"
      title={language.t("workbench.git.pr.title")}
      git={props.git}
      done={!!form.url}
      onSubmit={submit}
      submit={
        <Show when={!form.url}>
          <ButtonV2
            type="submit"
            variant="contrast"
            data-action="git-pr-confirm"
            disabled={!status()?.upstream || !!props.git.state.busy}
          >
            {language.t("workbench.git.pr.submit")}
          </ButtonV2>
        </Show>
      }
    >
      <Show
        when={form.url}
        fallback={
          <Show
            when={status()?.upstream}
            fallback={<p>{language.t("workbench.git.pr.needsPush", { branch: branch() })}</p>}
          >
            <p class="text-v2-text-text-muted">{language.t("workbench.git.pr.description", { branch: branch() })}</p>
            <Field>
              <Field.Label>{language.t("workbench.git.pr.field.title")}</Field.Label>
              <TextInputV2
                autofocus
                class="!w-full"
                name="title"
                value={form.title}
                onInput={(event) => setForm("title", event.currentTarget.value)}
              />
            </Field>
            <Field>
              <Field.Label>{language.t("workbench.git.pr.field.body")}</Field.Label>
              <TextareaV2
                name="body"
                rows={4}
                class="!w-full"
                disabled={!form.title.trim()}
                value={form.body}
                onInput={(event) => setForm("body", event.currentTarget.value)}
              />
            </Field>
          </Show>
        }
      >
        {(link) => (
          <div data-slot="git-pr-created" class="flex flex-col gap-2">
            <p class="font-[530]">{language.t("workbench.git.pr.created")}</p>
            <span class="select-text break-all font-mono text-[12px]">{link()}</span>
            <div>
              <ButtonV2 type="button" size="small" variant="neutral" onClick={() => platform.openExternal(link())}>
                {language.t("workbench.git.pr.open")}
              </ButtonV2>
            </div>
          </div>
        )}
      </Show>
    </GitDialog>
  )
}

function BranchDialog(props: { git: Git }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [form, setForm] = createStore({
    list: undefined as WorkbenchGit.Branches | undefined,
    failed: undefined as string | undefined,
    name: "",
    switchTo: true,
  })
  void props.git.branches().then(
    (list) => setForm("list", list),
    (error: unknown) => setForm("failed", errorText(error)),
  )
  const done = (result: WorkbenchGit.Branches | undefined) => {
    if (result) dialog.close()
  }
  return (
    <GitDialog
      name="git-branch-dialog"
      title={language.t("workbench.git.branches.title")}
      git={props.git}
      onSubmit={() => void props.git.createBranch(form.name.trim(), form.switchTo).then(done)}
      submit={
        <ButtonV2
          type="submit"
          variant="contrast"
          data-action="git-branch-create"
          disabled={!form.name.trim() || !!props.git.state.busy}
        >
          {language.t("workbench.git.branches.create")}
        </ButtonV2>
      }
    >
      <Show when={form.failed}>
        {(error) => (
          <div role="alert" class={ALERT}>
            {error()}
          </div>
        )}
      </Show>
      <Show when={form.list} fallback={<Show when={!form.failed}>{language.t("workbench.git.branches.loading")}</Show>}>
        {(branches) => (
          <ul class="flex max-h-60 flex-col overflow-y-auto">
            <For each={branches().branches}>
              {(branch) => (
                <li>
                  <button
                    type="button"
                    data-branch={branch.name}
                    class="flex w-full min-w-0 items-center gap-2 rounded-[4px] px-2 py-1 text-left hover:bg-v2-background-bg-layer-02 disabled:opacity-60"
                    disabled={branch.current || !!props.git.state.busy}
                    onClick={() => void props.git.switchBranch(branch.name).then(done)}
                  >
                    <Glyph path={BRANCH} size={14} />
                    <span class="min-w-0 truncate">{branch.name}</span>
                    <Show when={branch.current}>
                      <span class="text-[11px] text-v2-text-text-faint">
                        {language.t("workbench.git.branches.current")}
                      </span>
                    </Show>
                    <span class="flex-1" />
                    <Show when={branch.upstream}>
                      <span class="truncate text-[11px] text-v2-text-text-faint">{branch.upstream}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <DividerV2 />
      <Field>
        <Field.Label>{language.t("workbench.git.branches.new")}</Field.Label>
        <TextInputV2
          class="!w-full font-mono"
          name="branch"
          placeholder={language.t("workbench.git.branches.name")}
          value={form.name}
          onInput={(event) => setForm("name", event.currentTarget.value)}
        />
      </Field>
      <label class="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          name="switch"
          checked={form.switchTo}
          onChange={(event) => setForm("switchTo", event.currentTarget.checked)}
        />
        {language.t("workbench.git.branches.switchTo")}
      </label>
    </GitDialog>
  )
}
