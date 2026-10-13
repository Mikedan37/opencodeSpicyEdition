import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { AgentAvatar } from "@/agenthq/avatar"
import { useAgentHQ } from "@/agenthq/context"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { useWorkbench } from "./panel"

export type HandoffTarget =
  | { key: "session"; sessionID: string }
  | { key: `agent:${string}`; agent: AgentHQ.AgentIdentity }

// UI-07: where "Fix with agent" and "Investigate with agent" send their snapshot: this opencode session, or an Agent HQ
// identity through its messages (its newest session, else a new one). The last target used comes first. Only a
// message is sent: nothing is approved on the agent's behalf, and its tools still ask.
export function createHandoff(input: { directory: string; showAgents: () => void }) {
  const params = useParams<{ id?: string }>()
  const agenthq = useAgentHQ()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const local = useLocal()
  const language = useLanguage()
  const [prefs, setPrefs] = persisted(
    Persist.serverWorkspace(serverSDK().scope, input.directory, "workbench-handoff"),
    createStore({ last: "" }),
  )

  const targets = (): HandoffTarget[] => {
    const list: HandoffTarget[] = [
      ...(params.id ? [{ key: "session" as const, sessionID: params.id }] : []),
      ...agenthq.state.agents.map((agent) => ({ key: `agent:${agent.id}` as const, agent })),
    ]
    const last = list.findIndex((target) => target.key === prefs.last)
    return last <= 0 ? list : [list[last]!, ...list.toSpliced(last, 1)]
  }
  const name = (target: HandoffTarget) =>
    "agent" in target ? target.agent.name : language.t("workbench.handoff.session.name")

  // Resolves to what opens the session that received it (an Agent HQ session; this session is already in view).
  async function deliver(target: HandoffTarget, text: string) {
    if ("agent" in target) {
      const message = await agenthq.tasks.send({ to: target.agent.id, text })
      if (message.delivery === "failed") throw new Error(message.reason ?? language.t("workbench.handoff.notDelivered"))
      const sessionID = message.sessionID
      if (!sessionID) return
      return () => {
        agenthq.openSession(target.agent.id, sessionID)
        input.showAgents()
      }
    }
    const model = local.model.current()
    const agent = local.agent.current()
    if (!model || !agent) throw new Error(language.t("workbench.handoff.noModel"))
    // The composer's own path (queued follow-ups use it too): the message shows at once in the timeline.
    await sendFollowupDraft({
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft: {
        sessionID: target.sessionID,
        sessionDirectory: sdk().directory,
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        context: [],
        agent: agent.name,
        model: { providerID: model.provider.id, modelID: model.id },
        variant: local.model.variant.current(),
      },
      optimisticBusy: true,
    })
  }

  async function send(target: HandoffTarget, build: () => string | Promise<string>) {
    setPrefs("last", target.key)
    try {
      const open = await deliver(target, await build())
      showToast({
        variant: "success",
        title: language.t("workbench.handoff.sent", { name: name(target) }),
        actions: open ? [{ label: language.t("workbench.handoff.open"), onClick: open }] : undefined,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("workbench.handoff.failed", { name: name(target) }),
        description: errorText(error),
      })
    }
  }

  return { targets, last: () => prefs.last, name, send }
}

export type Handoff = ReturnType<typeof createHandoff>

// The picker behind the actions: this session or an Agent HQ identity, the last used first. `build` makes the
// snapshot when a target is picked, so it describes the state at that moment.
export function HandoffMenu(props: {
  label: string
  build: () => string | Promise<string>
  // A text button (the Debug tab header) instead of an icon (Problems rows).
  text?: boolean
  class?: string
}) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const pick = (target: HandoffTarget) => {
    setBusy(true)
    void workbench.handoff.send(target, props.build).finally(() => setBusy(false))
  }
  return (
    <MenuV2 gutter={4} modal={false} placement="bottom-end">
      <Show
        when={props.text}
        fallback={
          <MenuV2.Trigger
            as={IconButton}
            icon="brain"
            variant="ghost"
            data-action="handoff"
            class={props.class}
            aria-label={props.label}
            title={props.label}
            disabled={busy()}
          />
        }
      >
        <MenuV2.Trigger
          as={ButtonV2}
          size="small"
          variant="neutral"
          data-action="handoff"
          class={props.class}
          disabled={busy()}
        >
          {props.label}
        </MenuV2.Trigger>
      </Show>
      <MenuV2.Portal>
        <MenuV2.Content data-handoff-menu="">
          <MenuV2.Group>
            <MenuV2.GroupLabel>{language.t("workbench.handoff.to")}</MenuV2.GroupLabel>
            <For
              each={workbench.handoff.targets()}
              fallback={<MenuV2.Item disabled>{language.t("workbench.handoff.none")}</MenuV2.Item>}
            >
              {(target) => (
                <MenuV2.Item
                  data-target={target.key}
                  badge={target.key === workbench.handoff.last() ? language.t("workbench.handoff.last") : undefined}
                  onSelect={() => pick(target)}
                >
                  <Show when={"agent" in target && target.agent} fallback={language.t("workbench.handoff.session")}>
                    {(agent) => (
                      <span class="flex items-center gap-1.5">
                        <AgentAvatar avatar={agent().avatar} name={agent().name} size={14} />
                        {agent().name}
                      </span>
                    )}
                  </Show>
                </MenuV2.Item>
              )}
            </For>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
