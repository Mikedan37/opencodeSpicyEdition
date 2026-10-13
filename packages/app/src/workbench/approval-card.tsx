// The main chat's approval card, in place of upstream's permission dock (session-composer-region.tsx): a short verb
// and the thing ("Run `bun test`"), an edit's diff, and Deny / Always ▾ / Allow. Always covers what the request's
// always-patterns cover, for this session, or (from its menu) for the project, saved in Settings → Permissions.
// Motion (approval.css): the card rises in, a queued request slides in after the one answered, and the card leaves
// quicker than it came, out of the layout, so the composer it gives way to doesn't jump.
import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import createPresence from "solid-presence"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { DockShell, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import {
  approvalDetail,
  approvalQueue,
  approvalRule,
  approvalThings,
  approvalTitle,
  type ApprovalVerb,
} from "./approval"
import { createWorkbenchClient, errorText } from "./client"
import { PatchView } from "./patch-view"
import "./approval.css"

const ICONS: Record<ApprovalVerb, IconProps["name"]> = {
  run: "console",
  edit: "pencil-line",
  read: "eye",
  start: "task",
  access: "folder",
  fetch: "link",
  search: "magnifying-glass",
  debug: "code",
  evaluate: "console",
  repeat: "reset",
  use: "sliders",
}

type Response = "once" | "always" | "reject"

export function ApprovalDock(props: {
  request?: PermissionRequest
  queue: PermissionRequest[]
  responding: boolean
  onDecide: (response: Response) => void
  /** Called before a project save, like onDecide (the composer restores its draft when the card leaves). */
  onRespond: () => void
}) {
  const [element, setElement] = createSignal<HTMLElement>()
  const presence = createPresence({ show: () => !!props.request, element: () => element() ?? null })
  // The answered request stays on the card while it leaves.
  const [shown, setShown] = createSignal(props.request)
  createEffect(() => props.request && setShown(props.request))
  const queue = createMemo(
    (previous: ReturnType<typeof approvalQueue>) =>
      approvalQueue(
        previous.seen,
        props.queue.map((request) => request.id),
      ),
    approvalQueue([], []),
  )

  return (
    <Show when={presence.present() ? shown() : undefined}>
      {(current) => (
        <div
          ref={setElement}
          data-component="approval-card"
          data-state={props.request ? "open" : "closed"}
          class="pb-2"
        >
          <Show when={current()} keyed>
            {(request) => (
              <Card
                request={request}
                next={queue().position > 1}
                position={queue().position}
                total={queue().total}
                responding={props.responding}
                onDecide={props.onDecide}
                onRespond={props.onRespond}
              />
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

function Card(props: {
  request: PermissionRequest
  next: boolean
  position: number
  total: number
  responding: boolean
  onDecide: (response: Response) => void
  onRespond: () => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const client = createWorkbenchClient({
    server: serverSDK().server.http,
    directory: sdk().directory,
    fetch: platform.fetch,
  })
  const title = createMemo(() => approvalTitle(props.request))
  const detail = createMemo(() => approvalDetail(props.request))
  const verb = () => language.t(`workbench.approval.verb.${title().verb}`)
  const coverage = () =>
    props.request.always
      .map((pattern) => {
        const rule = approvalRule({ permission: props.request.permission, pattern })
        if (!rule.everything) return rule.text
        return language.t(rule.kind === "edit" ? "workbench.approval.allEdits" : "workbench.approval.allCommands")
      })
      .join(", ")
  const always = () => language.t("workbench.approval.always", { what: coverage() })
  const queue = () =>
    props.total > 1 ? language.t("workbench.approval.queue", { position: props.position, total: props.total }) : ""
  const [store, setStore] = createStore({ expanded: false, saving: false })
  const busy = () => props.responding || store.saving

  const save = () => {
    if (busy()) return
    props.onRespond()
    setStore("saving", true)
    client
      .saveApproval(props.request.id)
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("workbench.approval.saveFailed"),
          description: errorText(error),
        }),
      )
      .finally(() => setStore("saving", false))
  }

  let shell: HTMLDivElement | undefined
  // The composer this card replaced had the focus: keep it on the card (not on a button, so typing answers nothing).
  onMount(() => {
    if (!document.activeElement || document.activeElement === document.body) shell?.focus({ preventScroll: true })
  })

  return (
    <div data-slot="approval-body" data-next={props.next ? "" : undefined}>
      <DockShell
        ref={shell}
        tabIndex={-1}
        role="group"
        aria-label={[verb(), title().object, queue()].filter(Boolean).join(" ")}
        class="px-3 pt-3 pb-3 outline-none"
      >
        <div class="flex min-w-0 items-center gap-2 text-[14px] leading-6">
          <Icon name={ICONS[title().verb]} size="normal" class="shrink-0 text-v2-icon-icon-muted" />
          <span data-slot="approval-verb" class="shrink-0 font-[530] text-v2-text-text-base">
            {verb()}
          </span>
          <code
            data-slot="approval-object"
            title={title().object}
            class="min-w-0 truncate rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 font-mono text-[13px] text-v2-text-text-base"
          >
            {title().object}
          </code>
          <Show when={title().more}>
            <button
              type="button"
              data-action="approval-more"
              aria-expanded={store.expanded}
              class="shrink-0 rounded-[4px] px-1 text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
              onClick={() => setStore("expanded", (value) => !value)}
            >
              {language.t("workbench.approval.more", { count: title().more })}
            </button>
          </Show>
          <Show when={queue()}>
            <span data-slot="approval-queue" class="ml-auto shrink-0 text-[12px] tabular-nums text-v2-text-text-muted">
              {queue()}
            </span>
          </Show>
        </div>
        <Show when={store.expanded}>
          <ul data-slot="approval-things" class="mt-2 flex flex-col gap-1 pl-7">
            <For each={approvalThings(props.request).slice(1)}>
              {(thing) => <li class="break-all font-mono text-[12px] text-v2-text-text-base">{thing}</li>}
            </For>
          </ul>
        </Show>
        <Show when={detail()}>
          {(value) => (
            <div class="mt-2 pl-7">
              <Switch>
                <Match when={value().kind === "diff"}>
                  <div data-slot="approval-diff" class="max-h-48 overflow-auto rounded-[6px] bg-v2-background-bg-base">
                    <PatchView diff={value().text} root={sdk().directory} names={title().more > 0} />
                  </div>
                </Match>
                <Match when={value().kind === "command"}>
                  <pre
                    data-slot="approval-command"
                    class="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-v2-background-bg-layer-02 px-2 py-1.5 font-mono text-[12px] text-v2-text-text-base"
                  >
                    {value().text}
                  </pre>
                </Match>
                <Match when={value().kind === "note"}>
                  <p data-slot="approval-note" class="text-[13px] text-v2-text-text-muted">
                    {value().text}
                  </p>
                </Match>
              </Switch>
            </div>
          )}
        </Show>
      </DockShell>
      <DockTray class="-mt-6 flex items-center justify-end gap-2 px-2 pt-8 pb-2">
        <ButtonV2
          variant="ghost"
          data-action="approval-deny"
          disabled={busy()}
          onClick={() => props.onDecide("reject")}
        >
          {language.t("workbench.approval.deny")}
        </ButtonV2>
        <Show when={props.request.always.length > 0}>
          <div data-slot="approval-always" class="flex min-w-0">
            <TooltipV2 value={always()} placement="top" class="flex min-w-0">
              <ButtonV2
                variant="outline"
                data-action="approval-always"
                disabled={busy()}
                class="max-w-64 min-w-0 rounded-r-none!"
                onClick={() => props.onDecide("always")}
              >
                <span class="truncate">{always()}</span>
              </ButtonV2>
            </TooltipV2>
            <MenuV2 gutter={4} placement="top-end" modal={false}>
              <MenuV2.Trigger
                as={ButtonV2}
                variant="outline"
                data-action="approval-always-menu"
                aria-label={language.t("workbench.approval.always.menu")}
                disabled={busy()}
                class="-ml-px rounded-l-none! px-1.5!"
              >
                <IconV2 name="chevron-down" size="small" />
              </MenuV2.Trigger>
              <MenuV2.Portal>
                <MenuV2.Content data-approval-menu="">
                  <MenuV2.Item data-choice="session" onSelect={() => props.onDecide("always")}>
                    {language.t("workbench.approval.always.session")}
                  </MenuV2.Item>
                  <MenuV2.Item data-choice="project" class="h-auto! py-1.5!" onSelect={save}>
                    <span class="flex flex-col">
                      <span>{language.t("workbench.approval.always.project")}</span>
                      <span class="text-[12px] text-v2-text-text-muted">
                        {language.t("workbench.approval.always.projectHint")}
                      </span>
                    </span>
                  </MenuV2.Item>
                </MenuV2.Content>
              </MenuV2.Portal>
            </MenuV2>
          </div>
        </Show>
        <ButtonV2
          variant="contrast"
          data-action="approval-allow"
          disabled={busy()}
          onClick={() => props.onDecide("once")}
        >
          {language.t("workbench.approval.allow")}
        </ButtonV2>
      </DockTray>
    </div>
  )
}
