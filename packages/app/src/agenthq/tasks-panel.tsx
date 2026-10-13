import { createEffect, createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { errorText } from "@/workbench/client"
import { useRelativeTime } from "@/workbench/clock"
import { PatchView } from "@/workbench/patch-view"
import { useWorkbench } from "@/workbench/panel"
import { AGENT_VIEWS, type AgentView } from "@/workbench/tabs"
import { PanelState, TONE_CLASS } from "@/workbench/ui"
import { AgentAvatar } from "./avatar"
import { useAgentHQ } from "./context"
import { CANCELLABLE, EDITABLE, STARTABLE, threadKey, type MessageFilter } from "./tasks"

type Task = AgentHQ.Task

const TASK_TONE: Record<AgentHQ.TaskStatus, keyof typeof TONE_CLASS> = {
  pending: "neutral",
  ready: "info",
  running: "info",
  review: "warning",
  done: "success",
  failed: "danger",
  blocked: "warning",
  cancelled: "neutral",
}

const ROW =
  "flex w-full min-w-0 items-center gap-2 text-left outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"

export function TaskStatusPill(props: { status: AgentHQ.TaskStatus }) {
  const language = useLanguage()
  return (
    <span
      data-task-status={props.status}
      class={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[TASK_TONE[props.status]]}`}
    >
      <span
        class="size-1.5 rounded-full bg-current motion-reduce:animate-none"
        classList={{ "animate-pulse": props.status === "running" }}
      />
      {language.t(`agenthq.task.status.${props.status}`)}
    </span>
  )
}

// Agents | Tasks | Activity | Tools at the top of the Agents tab (UX #7), each with how many wait for the user.
// Activity and Tools keep their old tab ids as `data-workbench-tab`.
export function ViewSwitch() {
  const agenthq = useAgentHQ()
  const workbench = useWorkbench()
  const language = useLanguage()
  const total = (view: AgentView) =>
    view === "agents" ? agenthq.state.agents.length : view === "tasks" ? agenthq.tasks.state.tasks.length : undefined
  return (
    <div
      role="tablist"
      aria-label={language.t("agenthq.view")}
      class="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      <For each={AGENT_VIEWS}>
        {(view) => (
          <button
            type="button"
            role="tab"
            data-agenthq-view={view}
            data-workbench-tab={view === "activity" || view === "tools" ? view : undefined}
            aria-selected={workbench.agentsView() === view}
            class="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[13px] font-[530] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] aria-selected:bg-v2-background-bg-layer-02 aria-selected:text-v2-text-text-base"
            onClick={() => workbench.open(view === "agents" ? "agentList" : view)}
          >
            {language.t(`agenthq.view.${view}`)}
            <Show when={total(view) !== undefined}>
              <span class="text-[12px] font-normal tabular-nums text-v2-text-text-muted">{total(view)}</span>
            </Show>
            <Show when={workbench.attention[view]()}>
              {(count) => (
                <span
                  title={
                    view === "tasks"
                      ? language.plural("agenthq.task.waitingReview", count())
                      : language.plural("workbench.status.needsYou", count())
                  }
                  class={`min-w-4 rounded-full px-1 text-center text-[10px] leading-4 tabular-nums ${TONE_CLASS.warning}`}
                >
                  {count()}
                </span>
              )}
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

// The Agents tab's top row: its views, what the open view adds (New agent, New task), and Expand / Collapse for
// the whole tab.
export function SurfaceHeader(props: { children?: JSX.Element }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  return (
    <div class="flex h-10 shrink-0 items-center gap-2 px-3">
      <ViewSwitch />
      <span class="flex-1" />
      {props.children}
      <IconButton
        icon={agenthq.ui.expanded ? "collapse" : "expand"}
        variant="ghost"
        data-action="agenthq-expand"
        aria-label={agenthq.ui.expanded ? language.t("agenthq.collapse") : language.t("agenthq.expand")}
        onClick={() => agenthq.setExpanded(!agenthq.ui.expanded)}
      />
    </div>
  )
}

// The Agents tab's Tasks view: tasks in dependency order with their status and why, one task's detail, the review
// gate and its messages.
export function TasksView() {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const dialog = useDialog()
  const tasks = agenthq.tasks
  const current = createMemo(() => tasks.find(agenthq.ui.taskID) ?? tasks.state.tasks[0])
  const openDialog = (task?: Task) =>
    dialog.show(() => <TaskDialog task={task} onSaved={(saved) => agenthq.selectTask(saved.id)} />)

  return (
    <div data-component="agenthq-tasks" class="flex min-h-0 flex-1 flex-col">
      <Switch
        fallback={
          <div class="flex min-h-0 flex-1">
            <ul
              aria-label={language.t("agenthq.tasks")}
              class="w-[min(380px,45%)] shrink-0 overflow-y-auto border-r border-v2-border-border-muted py-1"
            >
              <For each={tasks.tree()}>
                {(item) => (
                  <li>
                    <TaskRow
                      task={item.task}
                      depth={item.depth}
                      selected={item.task.id === current()?.id}
                      onSelect={() => agenthq.selectTask(item.task.id)}
                    />
                  </li>
                )}
              </For>
            </ul>
            <Show when={current()} keyed>
              {(task) => <TaskDetail task={task} onEdit={() => openDialog(task)} onSelect={agenthq.selectTask} />}
            </Show>
          </div>
        }
      >
        <Match when={tasks.state.list === "unavailable"}>
          <PanelState title={language.t("agenthq.task.unavailable")} />
        </Match>
        <Match when={tasks.state.list === "failed" && tasks.state.tasks.length === 0}>
          <PanelState title={language.t("workbench.error.failed", { message: tasks.state.error ?? "" })}>
            <ButtonV2 size="small" variant="neutral" onClick={() => void tasks.load()}>
              {language.t("workbench.retry")}
            </ButtonV2>
          </PanelState>
        </Match>
        <Match when={tasks.state.list === "loading" && tasks.state.tasks.length === 0}>
          <PanelState icon={<LoaderV2 />} title={language.t("agenthq.task.loading")} />
        </Match>
        <Match when={tasks.state.tasks.length === 0}>
          <PanelState
            title={language.t("agenthq.task.empty.title")}
            description={language.t(
              agenthq.state.agents.length ? "agenthq.task.empty.description" : "agenthq.task.needsAgent",
            )}
          />
        </Match>
      </Switch>
    </div>
  )
}

function TaskRow(props: { task: Task; depth: number; selected: boolean; onSelect: () => void }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const assignee = () => agenthq.state.agents.find((agent) => agent.id === props.task.assignee)
  const waitsOn = () => props.task.dependsOn.map((id) => agenthq.tasks.find(id)).filter((task) => !!task)
  return (
    <button
      type="button"
      data-task={props.task.id}
      aria-current={props.selected ? "true" : undefined}
      class={`${ROW} flex-col !items-stretch gap-1 py-1.5 pr-3`}
      classList={{ "bg-v2-background-bg-layer-02": props.selected }}
      style={{ "padding-left": `${12 + props.depth * 16}px` }}
      onClick={props.onSelect}
    >
      <span class="flex min-w-0 items-center gap-2">
        <Show when={props.depth > 0}>
          <span class="shrink-0 text-[11px] text-v2-text-text-muted" aria-hidden="true">
            ↳
          </span>
        </Show>
        <span class="min-w-0 flex-1 truncate text-[12px] font-[530] text-v2-text-text-base">{props.task.title}</span>
        <Show when={assignee()}>
          {(agent) => <AgentAvatar avatar={agent().avatar} name={agent().name} size={16} />}
        </Show>
        <TaskStatusPill status={props.task.status} />
      </span>
      <Show when={waitsOn().length}>
        <span class="flex min-w-0 flex-wrap items-center gap-1">
          <For each={waitsOn()}>
            {(dependency) => (
              <span
                data-dependency={dependency.id}
                class={`max-w-40 truncate rounded-full px-1.5 text-[10px] leading-4 ${TONE_CLASS[TASK_TONE[dependency.status]]}`}
                title={dependency.title}
              >
                {dependency.title}
              </span>
            )}
          </For>
        </span>
      </Show>
      <Show when={props.task.reason}>
        <span class="truncate text-[11px] text-v2-text-text-muted" data-slot="task-reason" title={props.task.reason}>
          {props.task.reason}
        </span>
      </Show>
      <Show when={waitsForApproval(agenthq, props.task)}>
        <span data-slot="task-approval" class="truncate text-[11px] text-[var(--spicy-fg-warning)]">
          {language.t("agenthq.task.needsApproval")}
        </span>
      </Show>
    </button>
  )
}

// A running task whose session asked for a permission: nothing moves until the user answers it in that session.
const waitsForApproval = (agenthq: ReturnType<typeof useAgentHQ>, task: Task) =>
  task.status === "running" &&
  !!task.result?.sessionID &&
  agenthq.state.sessions[task.result.sessionID]?.status === "needs_approval"

function TaskDetail(props: { task: Task; onEdit: () => void; onSelect: (id: string) => void }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const ago = useRelativeTime()
  const tasks = agenthq.tasks
  const [confirm, setConfirm] = createSignal(false)
  const assignee = () => agenthq.state.agents.find((agent) => agent.id === props.task.assignee)
  // UX #12: while an approval finishes merging, nothing else may touch the task.
  const busy = () => !!tasks.state.busy[props.task.id] || !!props.task.merging
  const dependencies = () => props.task.dependsOn.map((id) => ({ id, task: tasks.find(id) }))
  const fail = (title: string) => (error: unknown) =>
    showToast({ variant: "error", title, description: errorText(error) })
  const run = (action: "start" | "cancel") =>
    void tasks[action](props.task.id).catch(fail(language.t(`agenthq.task.failed.${action}`)))
  const remove = () => {
    if (!confirm()) return setConfirm(true)
    void tasks.delete(props.task.id).catch(fail(language.t("agenthq.task.failed.delete")))
  }

  return (
    <div data-component="agenthq-task" data-task={props.task.id} class="min-w-0 flex-1 overflow-y-auto px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="min-w-0 truncate text-[14px] font-[530] text-v2-text-text-base">{props.task.title}</h3>
        <TaskStatusPill status={props.task.status} />
        <Show when={props.task.merging}>
          <span
            role="status"
            data-slot="task-merging"
            class="flex shrink-0 items-center gap-1.5 text-[12px] text-v2-text-text-muted"
          >
            <LoaderV2 width={12} height={12} />
            {language.t("agenthq.task.merging")}
          </span>
        </Show>
        <span class="flex-1" />
        <Show when={STARTABLE.has(props.task.status)}>
          <ButtonV2
            size="small"
            variant="contrast"
            data-action="task-start"
            disabled={busy()}
            onClick={() => run("start")}
          >
            {language.t(props.task.status === "ready" ? "agenthq.task.start" : "agenthq.task.retry")}
          </ButtonV2>
        </Show>
        <Show when={CANCELLABLE.has(props.task.status)}>
          <ButtonV2
            size="small"
            variant="neutral"
            data-action="task-cancel"
            disabled={busy()}
            onClick={() => run("cancel")}
          >
            {language.t("agenthq.task.cancel")}
          </ButtonV2>
        </Show>
        <Show when={props.task.result?.sessionID}>
          {(session) => (
            <ButtonV2
              size="small"
              variant="neutral"
              data-action="task-open-session"
              onClick={() => agenthq.openSession(props.task.assignee, session())}
            >
              {language.t("agenthq.task.openSession")}
            </ButtonV2>
          )}
        </Show>
        <Show when={EDITABLE.has(props.task.status)}>
          <ButtonV2 size="small" variant="ghost" data-action="task-edit" disabled={busy()} onClick={props.onEdit}>
            {language.t("agenthq.task.edit")}
          </ButtonV2>
        </Show>
        <Show when={props.task.status !== "running"}>
          <ButtonV2
            size="small"
            variant="ghost"
            data-action="task-delete"
            disabled={!!props.task.merging}
            onClick={remove}
            onBlur={() => setConfirm(false)}
          >
            {language.t(confirm() ? "agenthq.task.delete.confirm" : "agenthq.task.delete")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={waitsForApproval(agenthq, props.task) && props.task.result?.sessionID}>
        {(session) => (
          <p
            data-slot="task-approval"
            class="mt-2 flex items-center gap-2 rounded-[6px] bg-v2-state-bg-warning px-2 py-1 text-[12px] text-[var(--spicy-fg-warning)]"
          >
            {language.t("agenthq.task.needsApproval.detail")}
            <button
              type="button"
              class="ml-auto shrink-0 whitespace-nowrap font-[530] underline"
              onClick={() => agenthq.openSession(props.task.assignee, session())}
            >
              {language.t("agenthq.task.openSession")}
            </button>
          </p>
        )}
      </Show>
      <Show when={props.task.reason}>
        <p
          data-slot="task-reason"
          class="mt-2 select-text rounded-[6px] px-2 py-1 text-[12px]"
          classList={{
            "bg-v2-state-bg-danger text-v2-state-fg-danger": props.task.status === "failed",
            "bg-v2-state-bg-warning text-[var(--spicy-fg-warning)]": props.task.status === "blocked",
            "bg-v2-background-bg-layer-02 text-v2-text-text-muted":
              props.task.status !== "failed" && props.task.status !== "blocked",
          }}
        >
          {props.task.reason}
        </p>
      </Show>
      <dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        <dt class="text-v2-text-text-muted">{language.t("agenthq.task.assignee")}</dt>
        <dd class="flex min-w-0 items-center gap-1.5 text-v2-text-text-base">
          <Show when={assignee()} fallback={props.task.assignee}>
            {(agent) => (
              <>
                <AgentAvatar avatar={agent().avatar} name={agent().name} size={16} />
                <span class="truncate">{agent().name}</span>
              </>
            )}
          </Show>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("agenthq.task.dependsOn")}</dt>
        <dd class="flex min-w-0 flex-wrap items-center gap-1">
          <Show
            when={dependencies().length}
            fallback={<span class="text-v2-text-text-muted">{language.t("agenthq.task.none")}</span>}
          >
            <For each={dependencies()}>
              {(dependency) => (
                <button
                  type="button"
                  data-dependency={dependency.id}
                  disabled={!dependency.task}
                  class={`max-w-56 truncate rounded-full px-2 text-[11px] leading-5 enabled:hover:underline ${TONE_CLASS[dependency.task ? TASK_TONE[dependency.task.status] : "neutral"]}`}
                  onClick={() => props.onSelect(dependency.id)}
                >
                  {dependency.task
                    ? language.t("agenthq.task.dependency", {
                        title: dependency.task.title,
                        status: language.t(`agenthq.task.status.${dependency.task.status}`),
                      })
                    : dependency.id}
                </button>
              )}
            </For>
          </Show>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("agenthq.task.workspace")}</dt>
        <dd class="min-w-0 text-v2-text-text-base" data-slot="task-workspace">
          <Show
            // Approving merges the branch and removes the worktree; the record may still name them.
            when={props.task.status !== "done" && props.task.worktree}
            fallback={
              props.task.status === "done" && props.task.isolated
                ? props.task.worktree
                  ? language.t("agenthq.task.isolated.merged", { branch: props.task.worktree.branch })
                  : language.t("agenthq.task.isolated.mergedNoBranch")
                : language.t(props.task.isolated ? "agenthq.task.isolated.pending" : "agenthq.task.isolated.no")
            }
          >
            {(worktree) => (
              <span class="flex min-w-0 flex-col">
                <span class="font-mono text-[11px]">{worktree().branch}</span>
                <span class="truncate font-mono text-[11px] text-v2-text-text-muted" title={worktree().path}>
                  {worktree().path}
                </span>
              </span>
            )}
          </Show>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("agenthq.task.updated")}</dt>
        <dd class="text-v2-text-text-muted">{ago(props.task.updatedAt)}</dd>
      </dl>
      <Show when={props.task.description}>
        <div class="mt-3 select-text whitespace-pre-wrap break-words text-[12px] leading-[18px] text-v2-text-text-base">
          {props.task.description}
        </div>
      </Show>
      <Show when={props.task.result?.summary}>
        {(summary) => (
          <section class="mt-4">
            <h4 class="mb-1 text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted">
              {language.t("agenthq.task.summary")}
            </h4>
            <Markdown
              text={summary()}
              cacheKey={`agenthq:task:${props.task.id}:summary`}
              class="select-text text-[12px]"
            />
          </section>
        )}
      </Show>
      <Show when={props.task.status === "review"}>
        <ReviewGate task={props.task} />
      </Show>
      <section class="mt-4" aria-label={language.t("agenthq.messages")}>
        <h4 class="mb-1 text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted">
          {language.t("agenthq.messages")}
        </h4>
        <MessageThread filter={{ taskID: props.task.id }} to={props.task.assignee} />
      </section>
    </div>
  )
}

// Approving merges the task's branch into the user's project, so the dry run comes first and Approve is always an
// explicit click; a refusal (409) is shown as the server words it. UX #4: every file of the dry run (and all of them)
// opens the diff Approve would merge, read at the review's head, and Approve sits under the summary.
function ReviewGate(props: { task: Task }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const tasks = agenthq.tasks
  const state = () => tasks.state.reviews[props.task.id]
  const [refusal, setRefusal] = createSignal<string>()
  const [diff, setDiff] = createStore({
    // the file whose diff is open, or ALL
    open: undefined as string | undefined,
    status: "idle" as "idle" | "loading" | "ready" | "failed",
    text: "",
    truncated: false,
    error: undefined as string | undefined,
  })
  // One dry run per review; a failure waits for "Check again".
  createEffect(() => {
    if (!state()) void tasks.review(props.task.id)
  })
  const merging = () => !!props.task.merging
  const blocked = () => {
    const review = state()?.review
    if (!review) return language.t("agenthq.task.review.loading")
    if (!review.clean || !review.mergeable) return review.reason ?? language.t("agenthq.task.review.notMergeable")
  }
  const approve = () => {
    setRefusal(undefined)
    tasks.approve(props.task.id, state()?.review?.head).catch((error: unknown) => setRefusal(errorText(error)))
  }
  const show = (path?: string) => {
    const key = path ?? ALL
    if (diff.open === key) return setDiff({ open: undefined, status: "idle" })
    setDiff({ open: key, status: "loading", error: undefined })
    tasks.reviewDiff(props.task.id, { path, head: state()?.review?.head }).then(
      (result) => {
        if (diff.open === key) setDiff({ status: "ready", text: result.diff, truncated: !!result.truncated })
      },
      (error: unknown) => {
        if (diff.open === key) setDiff({ status: "failed", error: errorText(error) })
      },
    )
  }
  const checkAgain = () => {
    setDiff({ open: undefined, status: "idle" })
    void tasks.review(props.task.id)
  }
  const totals = () => {
    const files = state()?.review?.files ?? []
    return {
      count: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    }
  }
  return (
    <section
      data-component="agenthq-review"
      class="mt-4 rounded-[8px] p-3 shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
    >
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="whitespace-nowrap text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted">
          {language.t("agenthq.task.review")}
        </h4>
        <span class="flex-1" />
        <ButtonV2
          size="small"
          variant="ghost"
          class="shrink-0 whitespace-nowrap"
          data-action="task-review-refresh"
          disabled={state()?.status === "loading" || merging()}
          onClick={checkAgain}
        >
          {language.t("agenthq.task.review.refresh")}
        </ButtonV2>
      </div>
      <Switch>
        <Match when={state()?.status === "loading"}>
          <div class="mt-2 flex items-center gap-2 text-[12px] text-v2-text-text-muted">
            <LoaderV2 width={12} height={12} />
            {language.t("agenthq.task.review.loading")}
          </div>
        </Match>
        <Match when={state()?.status === "failed"}>
          <p class="mt-2 text-[12px] text-v2-state-fg-danger">{state()?.error}</p>
        </Match>
        <Match when={state()?.review}>
          {(review) => (
            <div class="mt-2 flex flex-col gap-2 text-[12px]">
              <Show
                when={review().branch}
                fallback={<p class="text-v2-text-text-muted">{language.t("agenthq.task.review.inPlace")}</p>}
              >
                <p class="text-v2-text-text-base" data-slot="review-merge">
                  {language.t("agenthq.task.review.merge", { branch: review().branch!, base: review().base ?? "" })}
                </p>
              </Show>
              <Show when={!review().clean || !review().mergeable}>
                <p
                  data-slot="review-refusal"
                  class="select-text rounded-[6px] bg-v2-state-bg-warning px-2 py-1 text-[var(--spicy-fg-warning)]"
                >
                  {review().reason ??
                    language.t(review().clean ? "agenthq.task.review.notMergeable" : "agenthq.task.review.dirty")}
                </p>
              </Show>
              <Show when={review().commits.length}>
                <ul data-slot="review-commits" class="flex flex-col gap-0.5">
                  <For each={review().commits}>
                    {(commit) => (
                      <li class="flex min-w-0 gap-2">
                        <span class="shrink-0 font-mono text-[11px] text-v2-text-text-muted">
                          {commit.sha.slice(0, 7)}
                        </span>
                        <span class="min-w-0 truncate text-v2-text-text-base">{commit.subject}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show
                when={review().files.length}
                fallback={<p class="text-v2-text-text-muted">{language.t("agenthq.task.review.noFiles")}</p>}
              >
                <ul data-slot="review-files" class="flex flex-col gap-0.5">
                  <For each={review().files}>
                    {(file) => (
                      <li>
                        <button
                          type="button"
                          data-review-file={file.path}
                          aria-expanded={diff.open === file.path}
                          class="flex w-full min-w-0 items-center gap-2 rounded-[4px] px-1 py-0.5 text-left font-mono text-[11px] outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
                          classList={{ "bg-v2-background-bg-layer-02": diff.open === file.path }}
                          onClick={() => show(file.path)}
                        >
                          <span class="min-w-0 flex-1 truncate text-v2-text-text-base">{file.path}</span>
                          <span class="shrink-0 text-[var(--spicy-fg-success)]">+{file.additions}</span>
                          <span class="shrink-0 text-v2-state-fg-danger">−{file.deletions}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <div>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    data-action="task-review-all"
                    aria-expanded={diff.open === ALL}
                    onClick={() => show()}
                  >
                    {language.t("agenthq.task.review.all")}
                  </ButtonV2>
                </div>
              </Show>
              <Show when={diff.open}>
                <div data-slot="review-diff" class="max-h-[480px] overflow-auto rounded-[6px]">
                  <Switch>
                    <Match when={diff.status === "loading"}>
                      <div class="flex items-center gap-2 px-2 py-1 text-v2-text-text-muted">
                        <LoaderV2 width={12} height={12} />
                        {language.t("agenthq.task.review.diffLoading")}
                      </div>
                    </Match>
                    <Match when={diff.status === "failed"}>
                      <div
                        role="alert"
                        data-slot="review-diff-error"
                        class="flex flex-wrap items-center gap-2 rounded-[6px] bg-v2-state-bg-danger px-2 py-1 text-v2-state-fg-danger"
                      >
                        <span class="min-w-0 flex-1 select-text">{diff.error}</span>
                        <ButtonV2 size="small" variant="neutral" onClick={checkAgain}>
                          {language.t("agenthq.task.review.refresh")}
                        </ButtonV2>
                      </div>
                    </Match>
                    <Match when={diff.status === "ready"}>
                      <Show
                        when={diff.text.trim()}
                        fallback={<p class="text-v2-text-text-muted">{language.t("agenthq.task.review.noFiles")}</p>}
                      >
                        <PatchView diff={diff.text} />
                      </Show>
                      <Show when={diff.truncated}>
                        <p class="pt-1 text-[11px] text-v2-text-text-muted">
                          {language.t("agenthq.task.review.diffTruncated")}
                        </p>
                      </Show>
                    </Match>
                  </Switch>
                </div>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
      {/* Approve under what it merges, with its size */}
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-v2-border-border-muted pt-2">
        <Show when={state()?.review}>
          <span data-slot="review-totals" class="text-[12px] text-v2-text-text-muted">
            {language.plural("agenthq.task.review.totals", totals().count, {
              additions: totals().additions,
              deletions: totals().deletions,
            })}
          </span>
        </Show>
        <span class="flex-1" />
        <Show when={merging()}>
          <span role="status" class="flex items-center gap-1.5 text-[12px] text-v2-text-text-muted">
            <LoaderV2 width={12} height={12} />
            {language.t("agenthq.task.merging")}
          </span>
        </Show>
        <ButtonV2
          size="small"
          variant="contrast"
          class="shrink-0 whitespace-nowrap"
          data-action="task-approve"
          disabled={!!blocked() || !!tasks.state.busy[props.task.id] || merging()}
          title={blocked()}
          onClick={approve}
        >
          {language.t("agenthq.task.approve")}
        </ButtonV2>
      </div>
      <Show when={refusal()}>
        <p
          role="alert"
          data-slot="approve-refusal"
          class="mt-2 select-text whitespace-pre-wrap rounded-[6px] bg-v2-state-bg-danger px-2 py-1 text-[12px] text-v2-state-fg-danger"
        >
          {refusal()}
        </p>
      </Show>
    </section>
  )
}

const ALL = "*"

const USER = "user"

// Messages between the user and agents, or between agents, for one task or one agent; sending as an agent with relay
// lets two agents hold an exchange (the server stops it at its limits and says why).
export function MessageThread(props: { filter: MessageFilter; to?: string }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const ago = useRelativeTime()
  const tasks = agenthq.tasks
  const [draft, setDraft] = createStore({ from: USER, to: props.to ?? "", text: "", relay: false, sending: false })
  const messages = createMemo(() => tasks.thread(props.filter))
  const name = (id: string) =>
    id === USER
      ? language.t("agenthq.role.user")
      : id === "system"
        ? language.t("agenthq.role.system")
        : (agenthq.state.agents.find((agent) => agent.id === id)?.name ?? id)
  createEffect(() => void tasks.loadThread(props.filter))

  const send = (event: SubmitEvent) => {
    event.preventDefault()
    const text = draft.text.trim()
    if (!text || !draft.to || draft.sending) return
    setDraft("sending", true)
    tasks
      .send({
        to: draft.to,
        text,
        ...(draft.from !== USER ? { from: draft.from, relay: draft.relay } : {}),
        ...("taskID" in props.filter ? { taskID: props.filter.taskID } : {}),
      })
      .then(
        () => setDraft("text", ""),
        (error: unknown) =>
          showToast({ variant: "error", title: language.t("agenthq.message.failed"), description: errorText(error) }),
      )
      .finally(() => setDraft("sending", false))
  }
  const select =
    "h-7 min-w-0 rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[12px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"

  return (
    <div data-component="agenthq-messages" class="flex flex-col gap-2">
      <Show
        when={messages().length}
        fallback={
          <p class="text-[12px] text-v2-text-text-muted">
            {tasks.state.threads[threadKey(props.filter)] === "loading"
              ? language.t("common.loading")
              : language.t("agenthq.message.empty")}
          </p>
        }
      >
        <ul class="flex flex-col gap-1.5">
          <For each={messages()}>
            {(message) => (
              <li data-message={message.id} data-delivery={message.delivery} class="text-[12px]">
                <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-v2-text-text-muted">
                  <span class="font-[530] text-v2-text-text-base">{name(message.from)}</span>
                  <span aria-hidden="true">→</span>
                  <span class="font-[530] text-v2-text-text-base">{name(message.to)}</span>
                  <Show when={message.relay}>
                    <span class={`rounded-full px-1.5 text-[10px] ${TONE_CLASS.info}`}>
                      {language.t("agenthq.message.relay")}
                    </span>
                  </Show>
                  <Show when={message.hops > 0}>
                    <span class="text-v2-text-text-muted">
                      {language.t("agenthq.message.hops", { count: message.hops })}
                    </span>
                  </Show>
                  <span class="flex-1" />
                  <Show when={message.sessionID}>
                    {(session) => (
                      <button
                        type="button"
                        class="shrink-0 text-v2-text-text-accent hover:underline"
                        onClick={() => agenthq.openSession(message.to, session())}
                      >
                        {language.t("agenthq.task.openSession")}
                      </button>
                    )}
                  </Show>
                  <span class="shrink-0 text-v2-text-text-muted">{ago(message.at)}</span>
                </div>
                <div class="select-text whitespace-pre-wrap break-words text-v2-text-text-base">{message.text}</div>
                <Show when={message.delivery === "failed" || message.reason}>
                  <div data-slot="message-reason" class="text-[11px] text-v2-state-fg-danger">
                    {message.reason ?? language.t("agenthq.message.notDelivered")}
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form class="flex flex-col gap-1.5" onSubmit={send}>
        <div class="flex flex-wrap items-center gap-1.5 text-[12px] text-v2-text-text-muted">
          <label class="flex items-center gap-1">
            {language.t("agenthq.message.from")}
            <select
              name="from"
              class={select}
              value={draft.from}
              onChange={(event) => setDraft("from", event.currentTarget.value)}
            >
              <option value={USER}>{language.t("agenthq.role.user")}</option>
              <For each={agenthq.state.agents}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
            </select>
          </label>
          <label class="flex items-center gap-1">
            {language.t("agenthq.message.to")}
            <select
              name="to"
              class={select}
              value={draft.to}
              onChange={(event) => setDraft("to", event.currentTarget.value)}
            >
              <option value="" disabled>
                {language.t("agenthq.message.pick")}
              </option>
              <For each={agenthq.state.agents}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
            </select>
          </label>
          <Show when={draft.from !== USER}>
            <label class="flex items-center gap-1" title={language.t("agenthq.message.relay.description")}>
              <input
                type="checkbox"
                name="relay"
                checked={draft.relay}
                onChange={(event) => setDraft("relay", event.currentTarget.checked)}
              />
              {language.t("agenthq.message.relay")}
            </label>
          </Show>
        </div>
        <div class="flex items-end gap-2">
          <TextareaV2
            aria-label={language.t("agenthq.message.text")}
            rows={2}
            class="min-w-0 !w-auto !flex-1 !min-h-12"
            placeholder={language.t("agenthq.message.placeholder")}
            value={draft.text}
            onInput={(event) => setDraft("text", event.currentTarget.value)}
          />
          <ButtonV2
            type="submit"
            size="small"
            variant="contrast"
            data-action="message-send"
            disabled={!draft.text.trim() || !draft.to || draft.sending}
          >
            {language.t("agenthq.composer.send")}
          </ButtonV2>
        </div>
      </form>
    </div>
  )
}

// Create or edit a task. Edits are accepted while it has not started (or after it failed or was cancelled); the
// server checks dependencies and cycles and its message is shown as is.
export function TaskDialog(props: { task?: Task; onSaved?: (task: Task) => void }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const dialog = useDialog()
  const [draft, setDraft] = createStore({
    title: props.task?.title ?? "",
    description: props.task?.description ?? "",
    assignee: (props.task?.assignee ?? agenthq.state.agents[0]?.id ?? "") as string,
    dependsOn: [...(props.task?.dependsOn ?? [])] as string[],
    isolated: props.task?.isolated ?? true,
    saving: false,
    error: "",
  })
  const others = () => agenthq.tasks.state.tasks.filter((task) => task.id !== props.task?.id)
  const valid = () => !!draft.title.trim() && !!draft.assignee

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid() || draft.saving) return
    const description = draft.description.trim()
    const body = {
      title: draft.title.trim(),
      assignee: draft.assignee,
      dependsOn: [...draft.dependsOn],
      isolated: draft.isolated,
      ...(description ? { description } : props.task?.description ? { description: null } : {}),
    }
    setDraft({ saving: true, error: "" })
    const request = props.task ? agenthq.tasks.update(props.task.id, body) : agenthq.tasks.create(body)
    request.then(
      (task) => {
        dialog.close()
        if (task) props.onSaved?.(task)
      },
      (error: unknown) => setDraft({ saving: false, error: errorText(error) }),
    )
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents" data-component="task-dialog">
        <DialogHeader>
          <DialogTitle>
            {language.t(props.task ? "agenthq.task.dialog.edit" : "agenthq.task.dialog.create")}
          </DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex max-h-[min(640px,calc(100vh-160px))] w-[min(520px,calc(100vw-48px))] flex-col gap-4 overflow-y-auto px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{language.t("agenthq.task.dialog.title")}</Field.Label>
            <TextInputV2
              autofocus
              class="!w-full"
              name="title"
              value={draft.title}
              onInput={(event) => setDraft("title", event.currentTarget.value)}
            />
          </Field>
          <Field>
            <Field.Label>{language.t("agenthq.task.dialog.description")}</Field.Label>
            <TextareaV2
              name="description"
              rows={3}
              class="!w-full"
              placeholder={language.t("agenthq.task.dialog.description.placeholder")}
              value={draft.description}
              onInput={(event) => setDraft("description", event.currentTarget.value)}
            />
          </Field>
          <Field>
            <Field.Label>{language.t("agenthq.task.assignee")}</Field.Label>
            <select
              name="assignee"
              class="h-8 w-full rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[13px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
              value={draft.assignee}
              onChange={(event) => setDraft("assignee", event.currentTarget.value)}
            >
              <For each={agenthq.state.agents}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
            </select>
          </Field>
          <fieldset class="flex flex-col gap-1">
            <legend class="mb-1 text-[13px] font-[530] text-v2-text-text-base">
              {language.t("agenthq.task.dependsOn")}
            </legend>
            <Show
              when={others().length}
              fallback={<p class="text-[12px] text-v2-text-text-muted">{language.t("agenthq.task.dialog.noOthers")}</p>}
            >
              <For each={others()}>
                {(task) => (
                  <label class="flex items-center gap-2 text-[12px] text-v2-text-text-base">
                    <input
                      type="checkbox"
                      data-depends-on={task.id}
                      checked={draft.dependsOn.includes(task.id)}
                      onChange={(event) =>
                        setDraft("dependsOn", (list) =>
                          event.currentTarget.checked ? [...list, task.id] : list.filter((id) => id !== task.id),
                        )
                      }
                    />
                    <span class="min-w-0 truncate">{task.title}</span>
                    <TaskStatusPill status={task.status} />
                  </label>
                )}
              </For>
            </Show>
          </fieldset>
          <label class="flex items-start gap-2 text-[12px] text-v2-text-text-base">
            <input
              type="checkbox"
              name="isolated"
              class="mt-0.5"
              checked={draft.isolated}
              onChange={(event) => setDraft("isolated", event.currentTarget.checked)}
            />
            <span class="flex flex-col">
              {language.t("agenthq.task.dialog.isolated")}
              <span class="text-[11px] text-v2-text-text-muted">
                {language.t("agenthq.task.dialog.isolated.description")}
              </span>
            </span>
          </label>
          <Show when={draft.error}>
            <div
              role="alert"
              data-slot="task-dialog-error"
              class="select-text whitespace-pre-wrap rounded-[6px] bg-v2-state-bg-danger px-3 py-2 text-[12px] text-v2-state-fg-danger"
            >
              {draft.error}
            </div>
          </Show>
        </DialogBody>
        <DialogFooter>
          <span class="flex-1" />
          <ButtonV2 type="button" variant="neutral" disabled={draft.saving} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={!valid() || draft.saving}>
            {language.t(props.task ? "common.save" : "agenthq.task.dialog.submit")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
