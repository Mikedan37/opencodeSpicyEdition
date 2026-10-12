import { createEffect, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { isLive, type DebugSession, type Variable } from "./debug"
import { useDebug } from "./debug-context"
import { DEBUG_KEYS } from "./keys"
import { DEBUG_GLYPHS, Glyph, TONE_CLASS } from "./ui"

type Action = keyof typeof DEBUG_GLYPHS
const KEYS: Partial<Record<Action, string>> = {
  start: DEBUG_KEYS.continue,
  continue: DEBUG_KEYS.continue,
  next: DEBUG_KEYS.next,
  stepIn: DEBUG_KEYS.stepIn,
  stepOut: DEBUG_KEYS.stepOut,
  stop: DEBUG_KEYS.stop,
}

export const sessionLabel = (session: DebugSession) =>
  session.program ? getFilename(session.program) : session.adapter

// Start, or run/step/stop the selected session. A disabled button says why in its tooltip.
export function DebugToolbar() {
  const debug = useDebug()
  const language = useLanguage()
  const command = useCommand()
  const session = () => debug.selected()
  const actions = (): Action[] => {
    const current = session()
    if (!current || !isLive(current)) return ["start"]
    return [current.state === "running" ? "pause" : "continue", "next", "stepIn", "stepOut", "stop"]
  }
  const blocked = (action: Action) => {
    const current = session()
    if (action === "start" || !current) return
    if (current.owner === "terminating") return language.t("workbench.debug.why.terminating")
    if (action === "stop") return
    if (current.owner === "agent") return language.t("workbench.debug.why.agent")
    if (current.state === "starting") return language.t("workbench.debug.why.starting")
    if (action === "pause") return
    if (current.state !== "stopped") return language.t("workbench.debug.why.running")
  }
  const title = (action: Action) => {
    const key = KEYS[action] ? command.keybind(KEYS[action]!) : ""
    const name = language.t(`workbench.debug.action.${action}`)
    return [key ? `${name} (${key})` : name, blocked(action)].filter(Boolean).join(" · ")
  }
  const press = (action: Action) => {
    if (action === "start") return debug.openStart()
    if (action === "stop") return void debug.end()
    void debug.run(action)
  }
  return (
    <div role="toolbar" aria-label={language.t("workbench.debug.toolbar")} class="flex shrink-0 items-center gap-0.5">
      <For each={actions()}>
        {(action) => (
          <button
            type="button"
            data-debug-action={action}
            aria-label={title(action)}
            title={title(action)}
            disabled={!!blocked(action)}
            class="flex size-7 items-center justify-center rounded-[6px] text-v2-icon-icon-base outline-none enabled:hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] disabled:opacity-40"
            classList={{
              "text-v2-state-fg-success": action === "start" || action === "continue",
              "text-v2-state-fg-danger": action === "stop",
            }}
            onClick={() => press(action)}
          >
            <Glyph path={DEBUG_GLYPHS[action]} size={16} />
          </button>
        )}
      </For>
    </div>
  )
}

const OWNER_TONE = { human: "success", agent: "warning", idle: "neutral", terminating: "neutral" } as const

// What the human can do with each owner: take over, hand the session to the agent, or release it.
const TAKE_OVER = { id: "take-over", key: "takeOver", to: "human" } as const
const HAND_TO_AGENT = { id: "hand-to-agent", key: "handToAgent", to: "agent" } as const
const RELEASE = { id: "release", key: "release", to: "idle" } as const
const OWNER_ACTIONS = { agent: [TAKE_OVER], idle: [TAKE_OVER, HAND_TO_AGENT], human: [HAND_TO_AGENT, RELEASE] }

// Who drives the session; the human can always take over (the agent cannot take it back).
export function OwnerChip(props: { session: DebugSession }) {
  const debug = useDebug()
  const language = useLanguage()
  const owner = () => props.session.owner
  return (
    <span class="flex shrink-0 items-center gap-1.5" data-slot="debug-owner" data-owner={owner()}>
      <span
        class={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[OWNER_TONE[owner()]]}`}
        title={language.t(`workbench.debug.owner.${owner()}.description`)}
      >
        {language.t(`workbench.debug.owner.${owner()}`)}
      </span>
      <Show when={isLive(props.session) && owner() !== "terminating"}>
        <For each={OWNER_ACTIONS[owner() as Exclude<DebugSession["owner"], "terminating">]}>
          {(action) => (
            <ButtonV2
              size="small"
              variant={action.to === "human" ? "neutral" : "ghost"}
              data-action={`debug-${action.id}`}
              title={language.t(`workbench.debug.${action.key}.description`)}
              onClick={() => void debug.setOwner(action.to, props.session.id)}
            >
              {language.t(`workbench.debug.${action.key}`)}
            </ButtonV2>
          )}
        </For>
      </Show>
    </span>
  )
}

export function SessionPicker() {
  const debug = useDebug()
  const language = useLanguage()
  const label = (session: DebugSession) =>
    language.t("workbench.debug.session", {
      name: sessionLabel(session),
      state: language.t(`workbench.debug.state.${session.state}`),
    })
  return (
    <Show
      when={debug.state.sessions.length > 1}
      fallback={
        <Show when={debug.selected()}>
          {(session) => (
            <span class="min-w-0 truncate text-[12px] font-[530] text-v2-text-text-base" title={session().program}>
              {label(session())}
            </span>
          )}
        </Show>
      }
    >
      <select
        aria-label={language.t("workbench.debug.sessions")}
        class="h-7 min-w-0 max-w-64 shrink rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[12px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
        value={debug.state.selected ?? ""}
        onChange={(event) => debug.select(event.currentTarget.value)}
      >
        <For each={debug.state.sessions}>{(session) => <option value={session.id}>{label(session)}</option>}</For>
      </select>
    </Show>
  )
}

// One variable; children load page by page while it is open. `path` keys its open state across stops.
export function VariableNode(props: { variable: Variable; path: string[]; depth?: number }) {
  const debug = useDebug()
  const language = useLanguage()
  const ref = () => props.variable.variablesReference
  const open = () => ref() > 0 && debug.expanded(props.path)
  const page = () => debug.page(ref())
  const pad = (depth: number) => ({ "padding-left": `${8 + depth * 12}px` })
  // Loads when opened and again after each stop (its pages die with the stop); a failure waits for a retry click.
  createEffect(() => {
    if (open() && !page()) void debug.children(ref())
  })
  return (
    <div role="treeitem" aria-expanded={ref() > 0 ? open() : undefined} data-variable={props.variable.name}>
      <button
        type="button"
        class="flex h-[22px] w-full min-w-0 items-center gap-1 pr-3 text-left font-mono text-[12px] outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
        style={pad(props.depth ?? 0)}
        onClick={() => ref() > 0 && debug.toggle(props.path)}
      >
        <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted">
          <Show when={ref() > 0}>
            <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
          </Show>
        </span>
        {/* An evaluation result has no name. */}
        <Show when={props.variable.name}>
          <span class="shrink-0 text-v2-text-text-accent">{props.variable.name}</span>
          {/* Groups such as debugpy's "special variables" have no value. */}
          <Show when={props.variable.value}>
            <span class="shrink-0 text-v2-text-text-faint">=</span>
          </Show>
        </Show>
        <span class="min-w-0 truncate text-v2-text-text-base" title={props.variable.value}>
          {props.variable.value}
        </span>
        <Show when={props.variable.type}>
          <span class="ml-auto shrink-0 pl-2 font-sans text-[11px] text-v2-text-text-faint">{props.variable.type}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div role="group">
          <For each={page()?.items ?? []}>
            {(child) => (
              <VariableNode variable={child} path={[...props.path, child.name]} depth={(props.depth ?? 0) + 1} />
            )}
          </For>
          <Show when={page()?.loading}>
            <div
              class="flex h-[22px] items-center gap-2 text-[12px] text-v2-text-text-muted"
              style={pad((props.depth ?? 0) + 1)}
            >
              <LoaderV2 width={10} height={10} />
              {language.t("common.loading")}
            </div>
          </Show>
          <Show when={page()?.error}>
            {(error) => (
              <button
                type="button"
                data-slot="variables-error"
                class="w-full py-0.5 pr-3 text-left text-[12px] text-v2-state-fg-danger hover:underline"
                style={pad((props.depth ?? 0) + 1)}
                title={language.t("workbench.retry")}
                onClick={() => void debug.children(ref())}
              >
                {error()}
              </button>
            )}
          </Show>
          <Show when={page() && !page()!.loading && !page()!.done && !page()!.error}>
            <button
              type="button"
              class="h-[22px] text-left text-[12px] text-v2-text-text-accent hover:underline"
              style={pad((props.depth ?? 0) + 1)}
              onClick={() => void debug.children(ref(), true)}
            >
              {language.t("workbench.debug.variables.more")}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
