import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { getFilename } from "@opencode-ai/core/util/path"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { AgentAvatar } from "@/agenthq/avatar"
import { useAgentHQ } from "@/agenthq/context"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { useDebug } from "./debug-context"
import { ENDED, RESUMABLE } from "./investigations"
import { useWorkbench } from "./panel"
import { PanelState, RequestErrorState, TONE_CLASS } from "./ui"

type Status = Workbench.InvestigationStatus
type Evidence = Workbench.Evidence

const STATUS_TONE: Record<Status, keyof typeof TONE_CLASS> = {
  created: "neutral",
  reproducing: "info",
  debugging: "info",
  diagnosing: "info",
  patching: "info",
  verifying: "info",
  resolved: "success",
  blocked: "warning",
  failed: "danger",
  interrupted: "warning",
  cancelled: "neutral",
  needs_human: "warning",
}
const SECTION = "mb-1 mt-4 text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted"
const LINK = "text-v2-text-text-accent hover:underline disabled:text-v2-text-text-faint disabled:no-underline"

function InvestigationStatusPill(props: { status: Status }) {
  const language = useLanguage()
  return (
    <span
      data-investigation-status={props.status}
      class={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[STATUS_TONE[props.status]]}`}
    >
      {language.t(`workbench.activity.status.${props.status}`)}
    </span>
  )
}

const time = (at: number, t: Parameters<typeof getRelativeTime>[1]) => getRelativeTime(new Date(at).toISOString(), t)

// Bottom panel Activity tab: the project's investigations (P7), each with its status timeline and its evidence, which
// links to the verification run in Output, the debug session in the Debug tab, or the agent's session.
export default function ActivityPanel() {
  const workbench = useWorkbench()
  const language = useLanguage()
  const investigations = workbench.investigations
  const [selected, setSelected] = createSignal<string>()
  const current = createMemo(() => investigations.find(selected()) ?? investigations.state.list[0])

  return (
    <div data-component="workbench-activity" class="flex min-h-0 flex-1 flex-col">
      <Switch
        fallback={
          <div class="flex min-h-0 flex-1">
            <ul
              aria-label={language.t("workbench.activity.list")}
              class="w-[min(360px,40%)] shrink-0 overflow-y-auto border-r border-v2-border-border-muted py-1"
            >
              <For each={investigations.state.list}>
                {(item) => (
                  <li>
                    <ListRow
                      summary={item}
                      selected={item.id === current()?.id}
                      onSelect={() => setSelected(item.id)}
                    />
                  </li>
                )}
              </For>
            </ul>
            <Show when={current()} keyed>
              {(summary) => <Detail summary={summary} />}
            </Show>
          </div>
        }
      >
        <Match when={investigations.state.status === "unavailable"}>
          <PanelState title={language.t("workbench.activity.unavailable")} />
        </Match>
        <Match when={investigations.state.status === "failed" && investigations.state.list.length === 0}>
          <RequestErrorState error={new Error(investigations.state.error)} onRetry={() => void investigations.load()} />
        </Match>
        <Match when={investigations.state.status === "loading" && investigations.state.list.length === 0}>
          <PanelState icon={<LoaderV2 />} title={language.t("workbench.activity.loading")} />
        </Match>
        <Match when={investigations.state.list.length === 0}>
          <PanelState
            title={language.t("workbench.activity.empty.title")}
            description={language.t("workbench.activity.empty.description")}
          />
        </Match>
      </Switch>
    </div>
  )
}

function AgentName(props: { agentID?: string }) {
  const agenthq = useAgentHQ()
  const agent = () => agenthq.state.agents.find((item) => item.id === props.agentID)
  return (
    <Show when={agent()}>
      {(value) => (
        <span class="flex min-w-0 items-center gap-1">
          <AgentAvatar avatar={value().avatar} name={value().name} size={14} />
          <span class="truncate">{value().name}</span>
        </span>
      )}
    </Show>
  )
}

function ListRow(props: { summary: Workbench.InvestigationSummary; selected: boolean; onSelect: () => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      data-investigation={props.summary.id}
      aria-current={props.selected ? "true" : undefined}
      class="flex w-full min-w-0 flex-col gap-1 px-3 py-1.5 text-left outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
      classList={{ "bg-v2-background-bg-layer-02": props.selected }}
      onClick={props.onSelect}
    >
      <span class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[12px] font-[530] text-v2-text-text-base">{props.summary.title}</span>
        <InvestigationStatusPill status={props.summary.status} />
      </span>
      <span class="flex min-w-0 items-center gap-2 text-[11px] text-v2-text-text-faint">
        <AgentName agentID={props.summary.agentID} />
        <span class="shrink-0">
          {language.t("workbench.activity.evidenceCount", { count: props.summary.evidenceCount })}
        </span>
        <span class="ml-auto shrink-0">{time(props.summary.updatedAt, language.t)}</span>
      </span>
      <Show when={props.summary.reason}>
        <span class="truncate text-[11px] text-v2-text-text-muted" title={props.summary.reason}>
          {props.summary.reason}
        </span>
      </Show>
    </button>
  )
}

function Detail(props: { summary: Workbench.InvestigationSummary }) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const investigations = workbench.investigations
  const state = () => investigations.state.details[props.summary.id]
  const record = () => state()?.detail?.investigation
  const busy = () => !!investigations.state.busy[props.summary.id]
  let evidenceList: HTMLUListElement | undefined
  // Loads on show and again when a newer summary marks the record stale; a failure waits for Retry.
  createEffect(() => {
    if (!state() || state()?.stale) void investigations.detail(props.summary.id)
  })
  const run = (action: "resume" | "cancel") =>
    void investigations[action](props.summary.id).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t(`workbench.activity.failed.${action}`),
        description: errorText(error),
      }),
    )
  const reveal = (id: string) =>
    evidenceList?.querySelector(`[data-evidence="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" })

  return (
    <div
      data-component="workbench-investigation"
      data-investigation={props.summary.id}
      class="min-w-0 flex-1 overflow-y-auto px-4 py-3"
    >
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="min-w-0 truncate text-[14px] font-[530] text-v2-text-text-base">{props.summary.title}</h3>
        <InvestigationStatusPill status={props.summary.status} />
        <span class="flex-1" />
        <Show when={RESUMABLE.has(props.summary.status)}>
          <ButtonV2
            size="small"
            variant="contrast"
            class="shrink-0"
            data-action="investigation-resume"
            disabled={busy()}
            onClick={() => run("resume")}
          >
            {language.t("workbench.activity.resume")}
          </ButtonV2>
        </Show>
        <Show when={!ENDED.has(props.summary.status)}>
          <ButtonV2
            size="small"
            variant="neutral"
            class="shrink-0"
            data-action="investigation-cancel"
            disabled={busy()}
            onClick={() => run("cancel")}
          >
            {language.t("workbench.activity.cancel")}
          </ButtonV2>
        </Show>
        <IconButton
          icon="reset"
          variant="ghost"
          aria-label={language.t("workbench.activity.reload")}
          onClick={() => void investigations.detail(props.summary.id)}
        />
      </div>
      <Show when={props.summary.reason}>
        <p
          data-slot="investigation-reason"
          class="mt-2 select-text rounded-[6px] bg-v2-background-bg-layer-02 px-2 py-1 text-[12px] text-v2-text-text-muted"
        >
          {props.summary.reason}
        </p>
      </Show>
      <Switch>
        <Match when={state()?.status === "failed" && !record()}>
          <p class="mt-3 text-[12px] text-v2-state-fg-danger">
            {state()?.error}{" "}
            <button type="button" class={LINK} onClick={() => void investigations.detail(props.summary.id)}>
              {language.t("workbench.retry")}
            </button>
          </p>
        </Match>
        <Match when={!record()}>
          <div class="mt-3 flex items-center gap-2 text-[12px] text-v2-text-text-muted">
            <LoaderV2 width={12} height={12} />
            {language.t("workbench.activity.loadingRecord")}
          </div>
        </Match>
        <Match when={record()}>
          {(investigation) => (
            <>
              <Meta investigation={investigation()} summary={props.summary} />
              <h4 class={SECTION}>{language.t("workbench.activity.timeline")}</h4>
              <ol
                data-slot="investigation-timeline"
                class="flex flex-col gap-1 border-l border-v2-border-border-muted pl-3"
              >
                <For each={investigation().checkpoints}>
                  {(checkpoint) => (
                    <li
                      data-checkpoint={checkpoint.status}
                      class="flex min-w-0 flex-wrap items-center gap-2 text-[12px]"
                    >
                      <InvestigationStatusPill status={checkpoint.status} />
                      <span class="shrink-0 text-[11px] text-v2-text-text-faint">
                        {time(checkpoint.at, language.t)}
                      </span>
                      <Show when={checkpoint.reason}>
                        <span class="min-w-0 select-text text-v2-text-text-base">{checkpoint.reason}</span>
                      </Show>
                      <Show when={checkpoint.evidenceID}>
                        {(id) => (
                          <button type="button" class={`${LINK} font-mono text-[11px]`} onClick={() => reveal(id())}>
                            {id()}
                          </button>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
              <h4 class={SECTION}>
                {language.t("workbench.activity.evidence", { count: state()?.detail?.evidence.length ?? 0 })}
              </h4>
              <ul ref={evidenceList} data-slot="investigation-evidence" class="flex flex-col gap-2">
                <For each={state()?.detail?.evidence ?? []}>{(item) => <EvidenceRow evidence={item} />}</For>
              </ul>
              <Show when={investigation().attempts.length}>
                <h4 class={SECTION}>{language.t("workbench.activity.attempts")}</h4>
                <ul class="flex flex-col gap-1 text-[12px]">
                  <For each={investigation().attempts}>
                    {(attempt) => (
                      <li data-attempt={attempt.n} class="flex min-w-0 flex-wrap items-center gap-2">
                        <span class="shrink-0 font-[530] text-v2-text-text-base">
                          {language.t("workbench.activity.attempt", { n: attempt.n })}
                        </span>
                        <span
                          class={`rounded-full px-1.5 text-[10px] leading-4 ${TONE_CLASS[attempt.passed === undefined ? "neutral" : attempt.passed ? "success" : "danger"]}`}
                        >
                          {language.t(
                            attempt.passed === undefined
                              ? "workbench.activity.attempt.open"
                              : attempt.passed
                                ? "workbench.activity.attempt.passed"
                                : "workbench.activity.attempt.failed",
                          )}
                        </span>
                        <span class="text-v2-text-text-muted">
                          {language.t("workbench.activity.attempt.errors", { count: attempt.errorCount })}
                        </span>
                        <span class="min-w-0 truncate font-mono text-[11px] text-v2-text-text-faint">
                          {attempt.changes.map((change) => getFilename(change.file)).join(", ")}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={investigation().notes.length}>
                <h4 class={SECTION}>{language.t("workbench.activity.notes")}</h4>
                <ul class="flex flex-col gap-1 text-[12px]">
                  <For each={investigation().notes}>
                    {(note) => (
                      <li class="flex min-w-0 gap-2">
                        <span class={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 ${TONE_CLASS.neutral}`}>
                          {language.t(`workbench.activity.note.${note.kind}`)}
                        </span>
                        <span class="min-w-0 select-text text-v2-text-text-base">{note.text}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={investigation().unverified.length}>
                <h4 class={SECTION}>{language.t("workbench.activity.unverified")}</h4>
                <ul class="flex flex-col gap-0.5 font-mono text-[11px] text-v2-state-fg-warning">
                  <For each={investigation().unverified}>
                    {(file) => (
                      <li class="truncate" title={file}>
                        {file}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={state()?.detail?.report}>
                {(report) => (
                  <>
                    <h4 class={SECTION}>{language.t("workbench.activity.report")}</h4>
                    <Markdown
                      text={report()}
                      cacheKey={`investigation:${props.summary.id}:${props.summary.updatedAt}`}
                      class="select-text text-[12px]"
                    />
                  </>
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

function Meta(props: { investigation: Workbench.Investigation; summary: Workbench.InvestigationSummary }) {
  const language = useLanguage()
  const target = () => props.investigation.target
  return (
    <dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      <Show when={props.investigation.agentID}>
        <dt class="text-v2-text-text-muted">{language.t("workbench.activity.agent")}</dt>
        <dd class="flex min-w-0 items-center gap-2 text-v2-text-text-base">
          <AgentName agentID={props.investigation.agentID} />
          <SessionLink sessionID={props.investigation.sessionID} agentID={props.investigation.agentID} />
        </dd>
      </Show>
      <Show when={target()}>
        {(value) => (
          <>
            <dt class="text-v2-text-text-muted">{language.t("workbench.activity.target")}</dt>
            <dd class="min-w-0 truncate font-mono text-[11px] text-v2-text-text-base" title={value().program}>
              {value().configuration ?? (value().program ? getFilename(value().program!) : (value().preset ?? ""))}
            </dd>
          </>
        )}
      </Show>
      <Show when={props.investigation.debugSessions.length}>
        <dt class="text-v2-text-text-muted">{language.t("workbench.activity.debugSessions")}</dt>
        <dd class="flex min-w-0 flex-wrap gap-2">
          <For each={props.investigation.debugSessions}>{(id) => <DebugLink debugSessionID={id} />}</For>
        </dd>
      </Show>
      <dt class="text-v2-text-text-muted">{language.t("workbench.activity.budget")}</dt>
      <dd class="text-v2-text-text-muted">
        {language.t("workbench.activity.budget.value", {
          attempts: props.investigation.attempts.length,
          max: props.investigation.policy.maxRepairAttempts,
          steps: props.investigation.steps,
          maxSteps: props.investigation.policy.maxDebugSteps,
        })}
      </dd>
    </dl>
  )
}

function EvidenceRow(props: { evidence: Evidence }) {
  const language = useLanguage()
  const refs = () => props.evidence.refs
  return (
    <li
      data-evidence={props.evidence.id}
      data-class={props.evidence.class}
      class="rounded-[6px] px-2 py-1.5 text-[12px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <span
          class={`rounded-full px-1.5 text-[10px] font-[530] leading-4 ${TONE_CLASS[props.evidence.class === "verified" ? "success" : "info"]}`}
          title={language.t(`workbench.activity.class.${props.evidence.class}.description`)}
        >
          {language.t(`workbench.activity.class.${props.evidence.class}`)}
        </span>
        <span class="shrink-0 font-[530] text-v2-text-text-base">
          {language.t(`workbench.activity.kind.${props.evidence.kind}`)}
        </span>
        <span class="shrink-0 font-mono text-[10px] text-v2-text-text-faint">{props.evidence.id}</span>
        <span class="ml-auto shrink-0 text-[11px] text-v2-text-text-faint">{time(props.evidence.at, language.t)}</span>
      </div>
      <p class="mt-0.5 select-text text-v2-text-text-base">{props.evidence.summary}</p>
      <div class="mt-0.5 flex flex-wrap items-center gap-3 text-[11px]">
        <Show when={refs()?.runID}>{(id) => <RunLink runID={id()} />}</Show>
        <Show when={refs()?.debugSessionID}>{(id) => <DebugLink debugSessionID={id()} />}</Show>
        <Show when={refs()?.sessionID}>{(id) => <SessionLink sessionID={id()} />}</Show>
      </div>
      <Show when={props.evidence.data !== undefined}>
        <details class="mt-1">
          <summary class="cursor-pointer select-none text-[11px] text-v2-text-text-muted">
            {language.t("workbench.activity.data")}
          </summary>
          <pre class="mt-1 max-h-60 select-text overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-v2-background-bg-layer-01 p-2 font-mono text-[11px] text-v2-text-text-base">
            {JSON.stringify(props.evidence.data, null, 2)}
          </pre>
        </details>
      </Show>
    </li>
  )
}

function RunLink(props: { runID: string }) {
  const workbench = useWorkbench()
  const language = useLanguage()
  return (
    <button
      type="button"
      data-link="run"
      class={LINK}
      onClick={() => {
        workbench.runs.focus(props.runID)
        workbench.open("output")
      }}
    >
      {language.t("workbench.activity.link.run", { id: props.runID })}
    </button>
  )
}

function DebugLink(props: { debugSessionID: string }) {
  const workbench = useWorkbench()
  const debug = useDebug()
  const language = useLanguage()
  // The server keeps the live sessions and the last ten that ended.
  const known = () => !!debug.find(props.debugSessionID)
  return (
    <button
      type="button"
      data-link="debug"
      class={LINK}
      disabled={!known()}
      title={known() ? undefined : language.t("workbench.activity.link.debugGone")}
      onClick={() => {
        debug.select(props.debugSessionID)
        workbench.showSide()
      }}
    >
      {language.t("workbench.activity.link.debug", { id: props.debugSessionID })}
    </button>
  )
}

// An Agent HQ session opens in the Agents tab; any other id (an OpenCode chat session) is shown as is.
function SessionLink(props: { sessionID?: string; agentID?: string }) {
  const workbench = useWorkbench()
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const agent = () =>
    props.sessionID ? (agenthq.state.sessions[props.sessionID]?.agentID ?? props.agentID) : undefined
  return (
    <Show when={props.sessionID}>
      {(id) => (
        <Show when={agent()} fallback={<span class="font-mono text-[11px] text-v2-text-text-faint">{id()}</span>}>
          {(agentID) => (
            <button
              type="button"
              data-link="session"
              class={LINK}
              onClick={() => {
                agenthq.openSession(agentID(), id())
                workbench.open("agents")
              }}
            >
              {language.t("workbench.activity.link.session")}
            </button>
          )}
        </Show>
      )}
    </Show>
  )
}
