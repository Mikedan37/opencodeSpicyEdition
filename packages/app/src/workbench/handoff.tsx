import { createSignal, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
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

// What a target receives: a one-line summary, and the structured snapshot (workbench/snapshot.ts) under its name.
export type HandoffPayload = { summary: string; context: string; name: string }
type Build = () => HandoffPayload | Promise<HandoffPayload>

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
  const dialog = useDialog()
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
  async function deliver(target: HandoffTarget, payload: HandoffPayload) {
    if ("agent" in target) {
      const message = await agenthq.tasks.send({ to: target.agent.id, text: payload.context })
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
    // UX #10: the summary is the message; the snapshot rides along as a text attachment, which the server hands the
    // model whole and the timeline shows as a collapsible chip named after it.
    const url = URL.createObjectURL(new Blob([payload.context], { type: "text/plain" }))
    // The composer's own path (queued follow-ups use it too): the message shows at once in the timeline.
    await sendFollowupDraft({
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft: {
        sessionID: target.sessionID,
        sessionDirectory: sdk().directory,
        prompt: [
          { type: "text", content: payload.summary, start: 0, end: payload.summary.length },
          {
            type: "image",
            id: "workbench-context",
            filename: payload.name,
            mime: "text/plain",
            blob: { id: url, url },
          },
        ],
        context: [],
        agent: agent.name,
        model: { providerID: model.provider.id, modelID: model.id },
        variant: local.model.variant.current(),
      },
      optimisticBusy: true,
    }).finally(() => URL.revokeObjectURL(url))
  }

  async function send(target: HandoffTarget, build: Build) {
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

  // The same picker as a dialog, for actions without a button to hang a menu on (the editor's lint tooltip, the
  // palette).
  const choose = (title: string, build: Build) =>
    dialog.show(() => (
      <DialogV2 fit>
        <DialogHeader>
          <DialogTitleGroup title={title} description={language.t("workbench.handoff.to")} />
        </DialogHeader>
        <DialogBody>
          <div data-handoff-dialog="" class="flex flex-col gap-1 pb-2">
            <For each={targets()} fallback={<p class="text-[13px]">{language.t("workbench.handoff.none")}</p>}>
              {(target) => (
                <ButtonV2
                  variant="ghost"
                  data-target={target.key}
                  class="justify-start"
                  onClick={() => {
                    dialog.close()
                    void send(target, build)
                  }}
                >
                  <TargetLabel target={target} last={target.key === prefs.last} />
                </ButtonV2>
              )}
            </For>
          </div>
        </DialogBody>
      </DialogV2>
    ))

  return { targets, last: () => prefs.last, name, send, choose }
}

export type Handoff = ReturnType<typeof createHandoff>

function TargetLabel(props: { target: HandoffTarget; last: boolean }) {
  const language = useLanguage()
  const agent = () => ("agent" in props.target ? props.target.agent : undefined)
  return (
    <span class="flex min-w-0 items-center gap-1.5">
      <Show when={agent()} fallback={language.t("workbench.handoff.session")}>
        {(value) => (
          <>
            <AgentAvatar avatar={value().avatar} name={value().name} size={14} />
            {value().name}
          </>
        )}
      </Show>
      <Show when={props.last}>
        <span class="text-[11px] text-v2-text-text-muted">{language.t("workbench.handoff.last")}</span>
      </Show>
    </span>
  )
}

// The picker behind the actions: this session or an Agent HQ identity, the last used first. `build` makes the
// snapshot when a target is picked, so it describes the state at that moment. `row`: a small text button that a
// list row shows on hover and focus (Problems); otherwise a toolbar button.
export function HandoffMenu(props: {
  label: string
  title?: string
  // Without it the menu has no targets, only `children` (the Debug tab's Ask an agent while not stopped).
  build?: Build
  row?: boolean
  class?: string
  // The targets' heading; "Send to" by default.
  heading?: string
  // More items after the targets, e.g. Hand to the agent.
  children?: JSX.Element
  action?: string
}) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const pick = (target: HandoffTarget, build: Build) => {
    setBusy(true)
    void workbench.handoff.send(target, build).finally(() => setBusy(false))
  }
  return (
    <MenuV2 gutter={4} modal={false} placement="bottom-end">
      <MenuV2.Trigger
        as={ButtonV2}
        size="small"
        variant={props.row ? "ghost" : "neutral"}
        data-action={props.action ?? "handoff"}
        class={props.class}
        aria-label={props.title}
        title={props.title}
        disabled={busy()}
      >
        {props.label}
        <Show when={!props.row}>
          <Icon name="chevron-down" size="small" />
        </Show>
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content data-handoff-menu="">
          <Show when={props.build}>
            {(build) => (
              <MenuV2.Group>
                <MenuV2.GroupLabel>{props.heading ?? language.t("workbench.handoff.to")}</MenuV2.GroupLabel>
                <For
                  each={workbench.handoff.targets()}
                  fallback={<MenuV2.Item disabled>{language.t("workbench.handoff.none")}</MenuV2.Item>}
                >
                  {(target) => (
                    <MenuV2.Item
                      data-target={target.key}
                      badge={target.key === workbench.handoff.last() ? language.t("workbench.handoff.last") : undefined}
                      onSelect={() => pick(target, build())}
                    >
                      {(<TargetLabel target={target} last={false} />) as JSX.Element}
                    </MenuV2.Item>
                  )}
                </For>
              </MenuV2.Group>
            )}
          </Show>
          <Show when={props.build && props.children}>
            <MenuV2.Separator />
          </Show>
          {props.children}
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
