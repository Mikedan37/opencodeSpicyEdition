import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { getFilename } from "@opencode-ai/core/util/path"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"
import { VirtualList } from "@/workbench/virtual-list"
import { errorText } from "@/workbench/client"
import { PanelState, RequestErrorState, TONE_CLASS } from "@/workbench/ui"
import { AgentAvatar } from "./avatar"
import { AgentDialog, createAgentDraft } from "./agent-dialog"
import { useAgentHQ } from "./context"
import { agentAttention, agentSessions, RUNNING_STATUSES, type FeedItem } from "./store"

type Agent = AgentHQ.AgentIdentity
type MessageItem = Extract<FeedItem, { kind: "message" }>
type ToolItem = Extract<FeedItem, { kind: "tool" }>
type PermissionItem = Extract<FeedItem, { kind: "permission" }>
type NoteItem = Extract<FeedItem, { kind: "note" }>

const STATUS_TONE: Record<AgentHQ.AgentSessionStatus, keyof typeof TONE_CLASS> = {
  starting: "info",
  idle: "neutral",
  thinking: "info",
  working: "info",
  needs_approval: "warning",
  blocked: "warning",
  completed: "success",
  failed: "danger",
  disconnected: "warning",
  interrupted: "warning",
  cancelled: "neutral",
}

const ATTENTION_DOT = {
  needs_approval: "bg-v2-state-fg-warning",
  failed: "bg-v2-state-fg-danger",
  completed: "bg-v2-state-fg-success",
} as const

export default function AgentsPanel() {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const dialog = useDialog()
  const selected = createMemo(() => agenthq.state.agents.find((agent) => agent.id === agenthq.ui.agentID))

  // The draft outlives the dialog: the directory picker replaces the dialog stack and the form is shown again after.
  const openDialog = (agent?: Agent) => {
    const draft = createAgentDraft(agent, agenthq.directory)
    const show = () => dialog.show(() => <AgentDialog agent={agent} draft={draft} reopen={show} />)
    show()
  }

  return (
    <div data-component="agenthq-panel" class="flex min-h-0 flex-1 flex-col">
      <Switch fallback={<Roster onCreate={() => openDialog()} />}>
        <Match when={agenthq.ui.status === "error" && agenthq.state.agents.length === 0}>
          <RequestErrorState error={agenthq.ui.error} onRetry={() => void agenthq.reload()} />
        </Match>
        <Match when={agenthq.ui.status === "loading" && agenthq.state.agents.length === 0}>
          <PanelState icon={<LoaderV2 />} title={language.t("agenthq.loading")} />
        </Match>
        <Match when={selected()} keyed>
          {(agent) => (
            <Show
              when={!agenthq.ui.expanded}
              fallback={
                <PanelState title={language.t("agenthq.expanded", { name: agent.name })}>
                  <ButtonV2 size="small" variant="neutral" onClick={() => agenthq.setExpanded(false)}>
                    {language.t("agenthq.collapse")}
                  </ButtonV2>
                </PanelState>
              }
            >
              <AgentWorkspace agent={agent} onEdit={() => openDialog(agent)} />
            </Show>
          )}
        </Match>
      </Switch>
      <Show when={agenthq.ui.expanded && selected()} keyed>
        {(agent) => <ExpandedWorkspace agent={agent} onEdit={() => openDialog(agent)} />}
      </Show>
    </div>
  )
}

function Roster(props: { onCreate: () => void }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-10 shrink-0 items-center gap-2 px-3">
        <h2 class="text-[13px] font-[530] text-v2-text-text-base">{language.t("agenthq.roster")}</h2>
        <span class="text-[12px] tabular-nums text-v2-text-text-faint">{agenthq.state.agents.length}</span>
        <span class="flex-1" />
        <ButtonV2
          size="small"
          variant="neutral"
          icon="plus"
          // spicy: stable selector for scripts/spicy-smoke.ts
          data-action="agenthq-new"
          onClick={props.onCreate}
        >
          {language.t("agenthq.new")}
        </ButtonV2>
      </div>
      <Show
        when={agenthq.state.agents.length > 0}
        fallback={
          <PanelState
            icon={<AgentAvatar avatar={{ kind: "preset", value: "robot", color: "gray" }} name="" size={40} />}
            title={language.t("agenthq.empty.title")}
            description={language.t("agenthq.empty.description")}
          >
            <ButtonV2
              size="small"
              variant="contrast"
              icon="plus"
              // spicy: stable selector for scripts/spicy-smoke.ts
              data-action="agenthq-new"
              onClick={props.onCreate}
            >
              {language.t("agenthq.new")}
            </ButtonV2>
          </PanelState>
        }
      >
        <ul
          class="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto px-3 pb-3"
          style={{ "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))" }}
        >
          <For each={agenthq.state.agents}>
            {(agent) => (
              <li>
                <AgentCard agent={agent} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function AgentCard(props: { agent: Agent }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const sessions = createMemo(() => agentSessions(agenthq.state.sessions, props.agent.id))
  const latest = () => sessions()[0]
  const attention = createMemo(() => agentAttention(sessions(), agenthq.seen))
  return (
    <button
      type="button"
      data-component="agenthq-card"
      data-agent={props.agent.id}
      class="flex w-full flex-col gap-2 rounded-[10px] bg-v2-background-bg-layer-01 p-3 text-left shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1.5px_var(--v2-border-border-focus)]"
      onClick={() => agenthq.selectAgent(props.agent.id)}
    >
      <span class="flex w-full items-center gap-2.5">
        <span class="relative shrink-0">
          <AgentAvatar avatar={props.agent.avatar} name={props.agent.name} size={32} />
          <Show when={attention()}>
            {(kind) => (
              <span
                role="img"
                data-attention={kind()}
                aria-label={language.t(`agenthq.attention.${kind()}`)}
                title={language.t(`agenthq.attention.${kind()}`)}
                class={`absolute -right-1 -top-1 size-3 rounded-full shadow-[0_0_0_2px_var(--v2-background-bg-layer-01)] ${ATTENTION_DOT[kind()]}`}
              />
            )}
          </Show>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="truncate text-[13px] font-[530] text-v2-text-text-base">{props.agent.name}</span>
          <span class="flex min-w-0 items-center gap-1.5">
            <ProviderChip provider={props.agent.provider} />
            <Show when={props.agent.model}>
              <span class="truncate text-[11px] text-v2-text-text-faint">{props.agent.model}</span>
            </Show>
          </span>
        </span>
        <StatusPill status={latest()?.status} />
      </span>
      <span class="w-full truncate text-[12px] text-v2-text-text-muted">
        {latest() ? latest()?.title || language.t("agenthq.session.untitled") : language.t("agenthq.card.noSession")}
      </span>
      <span class="w-full truncate text-[11px] text-v2-text-text-faint" title={props.agent.projectDirectory}>
        {[getFilename(props.agent.projectDirectory), props.agent.specialty].filter(Boolean).join(" · ")}
      </span>
    </button>
  )
}

function ProviderChip(props: { provider: AgentHQ.ProviderID }) {
  const agenthq = useAgentHQ()
  return (
    <Tag class="shrink-0">
      {agenthq.state.providers.find((provider) => provider.id === props.provider)?.name ?? props.provider}
    </Tag>
  )
}

function StatusPill(props: { status?: AgentHQ.AgentSessionStatus }) {
  const language = useLanguage()
  return (
    <span
      data-status={props.status ?? "none"}
      class={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[props.status ? STATUS_TONE[props.status] : "neutral"]}`}
    >
      <span
        class="size-1.5 rounded-full bg-current motion-reduce:animate-none"
        classList={{ "animate-pulse": !!props.status && RUNNING_STATUSES.has(props.status) }}
      />
      {props.status ? language.t(`agenthq.status.${props.status}`) : language.t("agenthq.status.none")}
    </span>
  )
}

function AgentWorkspace(props: { agent: Agent; expanded?: boolean; onEdit: () => void }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const sessions = createMemo(() => agentSessions(agenthq.state.sessions, props.agent.id))
  const sessionID = createMemo(() => agenthq.ui.sessionID ?? sessions()[0]?.id)
  const session = createMemo(() => {
    const id = sessionID()
    return id ? agenthq.state.sessions[id] : undefined
  })
  const [store, setStore] = createStore({ starting: false })

  // Subscribes while this view shows the session; switching sessions or closing the view unsubscribes.
  createEffect(() => {
    const id = sessionID()
    if (id) agenthq.watch(id)
  })

  const start = () => {
    if (store.starting) return
    setStore("starting", true)
    agenthq
      .startSession(props.agent.id)
      .catch((error: unknown) => showToast({ variant: "error", title: errorText(error) }))
      .finally(() => setStore("starting", false))
  }

  return (
    <div data-component="agenthq-workspace" class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-11 shrink-0 items-center gap-2 border-b border-v2-border-border-muted px-2">
        <Show when={!props.expanded}>
          <IconButton
            icon="arrow-left"
            variant="ghost"
            aria-label={language.t("agenthq.back")}
            onClick={() => agenthq.selectAgent(undefined)}
          />
        </Show>
        <AgentAvatar avatar={props.agent.avatar} name={props.agent.name} size={24} />
        <span class="truncate text-[13px] font-[530] text-v2-text-text-base">{props.agent.name}</span>
        <ProviderChip provider={props.agent.provider} />
        <StatusPill status={session()?.status} />
        <span class="flex-1" />
        <ButtonV2
          size="small"
          variant="ghost"
          icon="plus"
          // spicy: stable selector for scripts/spicy-smoke.ts
          data-action="agenthq-start-session"
          disabled={store.starting}
          onClick={start}
        >
          {language.t("agenthq.session.start")}
        </ButtonV2>
        <IconButton icon="edit" variant="ghost" aria-label={language.t("agenthq.edit")} onClick={props.onEdit} />
        <IconButton
          icon={props.expanded ? "collapse" : "expand"}
          variant="ghost"
          aria-label={props.expanded ? language.t("agenthq.collapse") : language.t("agenthq.expand")}
          onClick={() => agenthq.setExpanded(!props.expanded)}
        />
      </div>
      <div class="flex min-h-0 flex-1">
        <Show when={sessions().length > 0}>
          <nav
            aria-label={language.t("agenthq.sessions")}
            class="flex shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-v2-border-border-muted p-1.5"
            classList={{ "w-52": !props.expanded, "w-64": props.expanded }}
          >
            <For each={sessions()}>
              {(item) => (
                <button
                  type="button"
                  data-session={item.id}
                  aria-current={item.id === sessionID() ? "true" : undefined}
                  class="flex w-full flex-col gap-1 rounded-[6px] px-2 py-1.5 text-left outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
                  classList={{ "bg-v2-background-bg-layer-02": item.id === sessionID() }}
                  onClick={() => agenthq.selectSession(item.id)}
                >
                  <span class="truncate text-[12px] text-v2-text-text-base">
                    {item.title || language.t("agenthq.session.untitled")}
                  </span>
                  <span class="flex items-center gap-1.5">
                    <StatusPill status={item.status} />
                    <span class="ml-auto shrink-0 text-[11px] text-v2-text-text-faint">
                      {getRelativeTime(new Date(item.updatedAt).toISOString(), language.t)}
                    </span>
                  </span>
                  <Show when={item.pendingPermissions > 0}>
                    <span class="text-[11px] text-v2-state-fg-warning">
                      {language.t("agenthq.session.pending", { count: item.pendingPermissions })}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <div class="flex min-w-0 flex-1 flex-col">
          <Show
            when={session()}
            keyed
            fallback={
              <PanelState title={language.t("agenthq.session.empty", { name: props.agent.name })}>
                <ButtonV2
                  size="small"
                  variant="contrast"
                  icon="plus"
                  // spicy: stable selector for scripts/spicy-smoke.ts
                  data-action="agenthq-start-session"
                  disabled={store.starting}
                  onClick={start}
                >
                  {language.t("agenthq.session.start")}
                </ButtonV2>
              </PanelState>
            }
          >
            {(current) => (
              <>
                <SessionFeed sessionID={current.id} agentName={props.agent.name} />
                <Composer session={current} agent={props.agent} />
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}

// Large view: the same workspace in a full-window layer, so no route or session-page layout changes are needed.
function ExpandedWorkspace(props: { agent: Agent; onEdit: () => void }) {
  const agenthq = useAgentHQ()
  const dialog = useDialog()
  return (
    <Portal>
      <div
        data-component="agenthq-expanded"
        class="fixed inset-0 z-40 flex bg-v2-overlay-simple-overlay-scrim p-4 md:p-10"
        onClick={(event) => {
          if (event.target === event.currentTarget) agenthq.setExpanded(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || dialog.active) return
          event.stopPropagation()
          agenthq.setExpanded(false)
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={props.agent.name}
          tabIndex={-1}
          ref={(el) => queueMicrotask(() => el.focus())}
          class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-v2-background-bg-base shadow-[var(--v2-elevation-overlay)] outline-none"
        >
          <AgentWorkspace agent={props.agent} expanded onEdit={props.onEdit} />
        </div>
      </div>
    </Portal>
  )
}

function SessionFeed(props: { sessionID: string; agentName: string }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const feed = () => agenthq.state.feeds[props.sessionID]
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show when={feed()?.status === "error"}>
        <div class="flex shrink-0 items-center gap-2 bg-v2-state-bg-danger px-3 py-1.5 text-[12px] text-v2-state-fg-danger">
          <span class="min-w-0 flex-1 truncate">
            {language.t("agenthq.feed.failed", { message: feed()?.error ?? "" })}
          </span>
          <ButtonV2 size="small" variant="neutral" onClick={() => agenthq.retry(props.sessionID)}>
            {language.t("agenthq.feed.retry")}
          </ButtonV2>
        </div>
      </Show>
      <Switch
        fallback={
          <VirtualList
            items={feed()?.items ?? []}
            itemKey={(item) => item.key}
            estimate={44}
            follow
            label={language.t("agenthq.feed")}
            class="flex-1 py-2"
          >
            {(item) => <FeedRow item={item} sessionID={props.sessionID} agentName={props.agentName} />}
          </VirtualList>
        }
      >
        <Match when={!feed() || (feed()?.status === "loading" && feed()?.items.length === 0)}>
          <PanelState icon={<LoaderV2 />} title={language.t("agenthq.feed.loading")} />
        </Match>
        <Match when={feed()?.items.length === 0}>
          <PanelState title={language.t("agenthq.feed.empty")} />
        </Match>
      </Switch>
    </div>
  )
}

function FeedRow(props: { item: FeedItem; sessionID: string; agentName: string }) {
  return (
    <Switch>
      <Match when={props.item.kind === "message" ? props.item : undefined}>
        {(item) => <MessageRow message={item()} sessionID={props.sessionID} agentName={props.agentName} />}
      </Match>
      <Match when={props.item.kind === "tool" ? props.item : undefined}>{(item) => <ToolRow tool={item()} />}</Match>
      <Match when={props.item.kind === "permission" ? props.item : undefined}>
        {(item) => <PermissionCard permission={item()} sessionID={props.sessionID} />}
      </Match>
      <Match when={props.item.kind === "note" ? props.item : undefined}>{(item) => <NoteRow note={item()} />}</Match>
    </Switch>
  )
}

function MessageRow(props: { message: MessageItem; sessionID: string; agentName: string }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const label = () => {
    if (props.message.role === "user") return language.t("agenthq.role.user")
    if (props.message.role === "system") return language.t("agenthq.role.system")
    return props.agentName
  }
  // Streams until the complete message arrives, and only while the turn runs (a cancelled turn never sends it).
  const streaming = () => {
    const status = agenthq.state.sessions[props.sessionID]?.status
    return !props.message.final && !!status && RUNNING_STATUSES.has(status)
  }
  const cacheKey = () => `agenthq:${props.sessionID}:${props.message.key}`
  return (
    <div data-row="message" data-role={props.message.role} class="px-3 py-1.5">
      <div class="mb-0.5 text-[11px] font-[530] text-v2-text-text-muted">{label()}</div>
      <Show when={props.message.reasoning}>
        <details class="mb-1 text-[12px] text-v2-text-text-muted">
          <summary class="cursor-pointer select-none">{language.t("agenthq.reasoning")}</summary>
          <Markdown
            text={props.message.reasoning}
            cacheKey={`${cacheKey()}:reasoning`}
            class="pl-3 pt-1 text-[12px] text-v2-text-text-muted"
          />
        </details>
      </Show>
      <Show when={props.message.text}>
        <Show
          when={props.message.role !== "user"}
          fallback={
            <div class="select-text whitespace-pre-wrap break-words rounded-[8px] bg-v2-background-bg-layer-02 px-2.5 py-1.5 text-[13px] leading-[19px] text-v2-text-text-base">
              {props.message.text}
            </div>
          }
        >
          <Markdown
            text={props.message.text}
            cacheKey={cacheKey()}
            streaming={streaming()}
            class="select-text text-[13px]"
          />
        </Show>
      </Show>
    </div>
  )
}

function ToolRow(props: { tool: ToolItem }) {
  const language = useLanguage()
  const summary = () => (
    <>
      <Switch fallback={<LoaderV2 width={12} height={12} class="shrink-0" />}>
        <Match when={props.tool.state === "completed"}>
          <Icon name="circle-check" size="small" class="text-v2-state-fg-success" />
        </Match>
        <Match when={props.tool.state === "error"}>
          <Icon name="circle-x" size="small" class="text-v2-state-fg-danger" />
        </Match>
      </Switch>
      <span class="shrink-0 font-mono text-[12px] text-v2-text-text-base">{props.tool.tool}</span>
      <span class="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-muted">{props.tool.title}</span>
      <span class="shrink-0 text-[11px] text-v2-text-text-faint">{language.t(`agenthq.tool.${props.tool.state}`)}</span>
    </>
  )
  return (
    <div
      data-row="tool"
      data-state={props.tool.state}
      class="mx-3 my-0.5 rounded-[8px] bg-v2-background-bg-layer-01 shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
    >
      <Show when={props.tool.output} fallback={<div class="flex h-7 items-center gap-2 px-2">{summary()}</div>}>
        <details class="group">
          <summary class="flex h-7 cursor-pointer select-none list-none items-center gap-2 px-2">
            <Icon name="chevron-right" size="small" class="transition-transform group-open:rotate-90" />
            {summary()}
          </summary>
          <pre
            aria-label={language.t("agenthq.tool.output")}
            class="max-h-60 select-text overflow-auto whitespace-pre-wrap break-all border-t border-v2-border-border-muted px-2 py-1.5 font-mono text-[11px] leading-[16px] text-v2-text-text-muted"
          >
            {props.tool.output}
          </pre>
        </details>
      </Show>
    </div>
  )
}

// Every answer is an explicit click on one of the provider's options; nothing here answers on its own.
function PermissionCard(props: { permission: PermissionItem; sessionID: string }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  return (
    <div
      role="group"
      data-row="permission"
      data-request={props.permission.requestID}
      aria-label={language.t("agenthq.permission")}
      class="mx-3 my-1.5 rounded-[10px] p-3"
      classList={{
        "bg-v2-state-bg-warning shadow-[inset_0_0_0_0.5px_var(--v2-state-border-warning)]": !props.permission.outcome,
        "bg-v2-background-bg-layer-01 shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]":
          !!props.permission.outcome,
      }}
    >
      <div class="flex items-center gap-1.5 text-[12px] font-[530] text-v2-state-fg-warning">
        <Icon name="shield" size="small" />
        {language.t("agenthq.permission")}
      </div>
      <div class="mt-1 text-[13px] text-v2-text-text-base">{props.permission.title}</div>
      <Show when={props.permission.tool}>
        <div class="font-mono text-[11px] text-v2-text-text-muted">{props.permission.tool}</div>
      </Show>
      <Show when={props.permission.details}>
        <pre class="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[16px] text-v2-text-text-muted">
          {props.permission.details}
        </pre>
      </Show>
      <Show
        when={!props.permission.outcome}
        fallback={
          <div class="mt-2 text-[12px] font-[530] text-v2-text-text-muted">
            {language.t(`agenthq.permission.${props.permission.outcome}`)}
          </div>
        }
      >
        <div class="mt-2 flex flex-wrap gap-1.5">
          <For each={props.permission.options}>
            {(option) => (
              <ButtonV2
                size="small"
                variant={option.kind.startsWith("allow") ? "contrast" : "neutral"}
                disabled={!!props.permission.responding}
                data-option={option.id}
                onClick={() => void agenthq.respond(props.sessionID, props.permission.requestID, option.id)}
              >
                <Show when={props.permission.responding === option.id}>
                  <LoaderV2 width={12} height={12} />
                </Show>
                {option.label}
              </ButtonV2>
            )}
          </For>
        </div>
        <Show when={props.permission.error}>
          {(error) => (
            <div class="mt-1.5 text-[11px] text-v2-state-fg-danger">
              {language.t("agenthq.permission.failed", { message: error() })}
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function NoteRow(props: { note: NoteItem }) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.note.tone === "file"}>
        <div data-row="file" class="flex items-center gap-1.5 truncate px-3 py-0.5 text-[11px] text-v2-text-text-muted">
          <Icon name="edit-small-2" size="small" />
          <span class="truncate">{language.t("agenthq.note.file", { path: props.note.text })}</span>
        </div>
      </Match>
      <Match when={props.note.tone === "turn"}>
        <div data-row="turn" class="mx-3 my-1 flex items-center gap-2 text-[11px] text-v2-text-text-faint">
          <span class="h-px flex-1 bg-v2-border-border-muted" />
          {props.note.text
            ? language.t("agenthq.note.turnReason", { reason: props.note.text })
            : language.t("agenthq.note.turn")}
          <span class="h-px flex-1 bg-v2-border-border-muted" />
        </div>
      </Match>
      <Match when={props.note.tone === "error"}>
        <div
          data-row="error"
          class={`mx-3 my-1 select-text whitespace-pre-wrap break-words rounded-[8px] px-2.5 py-1.5 text-[12px] ${TONE_CLASS.danger}`}
        >
          {props.note.text}
        </div>
      </Match>
    </Switch>
  )
}

function Composer(props: { session: AgentHQ.AgentSessionInfo; agent: Agent }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const [store, setStore] = createStore({ text: "", sending: false, cancelling: false })
  const canCancel = () =>
    agenthq.state.providers.find((provider) => provider.id === props.session.provider)?.capabilities.cancel !== false

  const send = () => {
    const text = store.text.trim()
    if (!text || store.sending) return
    setStore("sending", true)
    agenthq
      .send(props.session.id, text)
      .then(
        () => setStore("text", ""),
        (error: unknown) =>
          showToast({ variant: "error", title: language.t("agenthq.composer.failed"), description: errorText(error) }),
      )
      .finally(() => setStore("sending", false))
  }

  const cancel = () => {
    setStore("cancelling", true)
    agenthq
      .cancel(props.session.id)
      .catch((error: unknown) => showToast({ variant: "error", title: errorText(error) }))
      .finally(() => setStore("cancelling", false))
  }

  return (
    <form
      // spicy: stable selector for scripts/spicy-smoke.ts
      data-component="agenthq-composer"
      class="flex shrink-0 items-end gap-2 border-t border-v2-border-border-muted p-2"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <TextareaV2
        aria-label={language.t("agenthq.composer.label")}
        rows={2}
        class="min-w-0 !w-auto !flex-1 !min-h-14"
        placeholder={language.t("agenthq.composer.placeholder", { name: props.agent.name })}
        value={store.text}
        onInput={(event) => setStore("text", event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
          event.preventDefault()
          send()
        }}
      />
      <Show when={RUNNING_STATUSES.has(props.session.status)}>
        <ButtonV2
          type="button"
          size="small"
          variant="neutral"
          // spicy: stable selector for scripts/spicy-smoke.ts
          data-action="agenthq-cancel"
          disabled={!canCancel() || store.cancelling}
          title={canCancel() ? undefined : language.t("agenthq.composer.cancelUnsupported")}
          onClick={cancel}
        >
          {language.t("agenthq.composer.cancel")}
        </ButtonV2>
      </Show>
      <ButtonV2
        type="submit"
        size="small"
        variant="contrast"
        // spicy: stable selector for scripts/spicy-smoke.ts
        data-action="agenthq-send"
        disabled={!store.text.trim() || store.sending}
      >
        {language.t("agenthq.composer.send")}
      </ButtonV2>
    </form>
  )
}
