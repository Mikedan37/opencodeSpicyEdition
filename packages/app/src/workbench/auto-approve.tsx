// The composer's approval mode for the main chat's session (opencode src/workbench/auto-approve.ts): Ask (edits and
// commands ask), Auto edits (edits apply, commands ask) or Auto (both run; the user's denies still apply). Every new
// session asks. Auto takes a second pick in the menu, inline; the pill's tint and width follow the mode.
import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useParams } from "@solidjs/router"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { APPROVAL_MODES, approvalMode, type ApprovalMode } from "./approval"
import { createWorkbenchClient, errorText } from "./client"
import { TONE_CLASS } from "./ui"

const MODES: ApprovalMode[] = ["ask", "edits", "auto"]

const TINT: Record<ApprovalMode, string> = {
  ask: "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base",
  edits: TONE_CLASS.info,
  auto: TONE_CLASS.warning,
}

function ModeIcon(props: { mode: ApprovalMode }) {
  return (
    <Show
      when={props.mode === "auto"}
      fallback={<Icon name={props.mode === "ask" ? "shield" : "pencil-line"} size="small" class="shrink-0" />}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" class="shrink-0">
        <path d="M11.25 1.875 4.375 11.25H10L8.75 18.125 15.625 8.75H10L11.25 1.875Z" stroke="currentColor" />
      </svg>
    </Show>
  )
}

/** Renders only on a session's page; the new-session composer has no session to set yet. */
export function ApprovalModePill() {
  const params = useParams()
  return (
    <Show when={params.id} keyed>
      {(id) => <Pill sessionID={id} />}
    </Show>
  )
}

function Pill(props: { sessionID: string }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const client = createWorkbenchClient({
    server: serverSDK().server.http,
    directory: sdk().directory,
    fetch: platform.fetch,
  })
  // undefined while loading, and on a server without the switches: the pill stays hidden.
  const [value, { mutate }] = createResource(() => client.getAutoApprove(props.sessionID).catch(() => undefined))
  const mode = () => approvalMode(value() ?? APPROVAL_MODES.ask)
  const name = (item: ApprovalMode) => language.t(`workbench.mode.${item}`)
  // `width` is the label's own width (an invisible copy measures it); the shown width springs to it.
  const [store, setStore] = createStore({ open: false, confirming: false, announce: "", width: 0, measured: false })

  const choose = (next: ApprovalMode) => {
    if (next === "auto" && mode() !== "auto" && !store.confirming) {
      setStore({ confirming: true, announce: language.t("workbench.mode.auto.confirm") })
      return
    }
    setStore({ open: false, confirming: false })
    if (next === mode()) return
    client.setAutoApprove(props.sessionID, APPROVAL_MODES[next]).then(
      (result) => {
        mutate(result)
        setStore("announce", language.t("workbench.mode.changed", { mode: name(approvalMode(result)) }))
      },
      (error: unknown) =>
        showToast({ variant: "error", title: language.t("workbench.mode.failed"), description: errorText(error) }),
    )
  }

  // The first measurement and reduced motion snap; later mode changes spring.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const width = useSpring(
    () => store.width,
    { visualDuration: 0.2, bounce: 0 },
    () => (store.measured && !reduced ? "spring" : store.width),
  )

  return (
    <Show when={value()}>
      <MenuV2
        open={store.open}
        onOpenChange={(open) => setStore(open ? { open } : { open, confirming: false })}
        placement="top-start"
        gutter={6}
        modal={false}
      >
        <MenuV2.Trigger
          as="button"
          type="button"
          data-action="prompt-approval-mode"
          data-mode={mode()}
          aria-label={language.t("workbench.mode.aria", { mode: name(mode()) })}
          class={`relative flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[13px] font-[440] outline-none transition-[background-color,color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus ${TINT[mode()]}`}
        >
          <ModeIcon mode={mode()} />
          <span
            class="inline-block overflow-hidden whitespace-nowrap text-left"
            style={{ width: store.measured ? `${width()}px` : undefined }}
          >
            <Show when={name(mode())} keyed>
              {(label) => <span class="inline-block animate-in fade-in duration-200">{label}</span>}
            </Show>
          </span>
          {/* The label through ::after, so the copy stays out of the button's text. */}
          <span
            ref={(element) =>
              createResizeObserver(element, () => setStore({ width: element.offsetWidth, measured: true }))
            }
            aria-hidden="true"
            data-label={name(mode())}
            class="invisible absolute left-0 top-0 whitespace-nowrap after:content-[attr(data-label)]"
          />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content data-approval-modes="" class="w-[23rem]">
            <MenuV2.RadioGroup value={mode()}>
              <For each={MODES}>
                {(item) => (
                  <MenuV2.RadioItem value={item} data-mode={item} class="h-auto! py-1.5!" onSelect={() => choose(item)}>
                    <ModeIcon mode={item} />
                    <span class="flex min-w-0 flex-col gap-1 leading-4">
                      <DropdownMenu.ItemLabel>{name(item)}</DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemDescription
                        class="whitespace-normal text-[12px] font-[440]"
                        classList={{
                          "text-v2-text-text-muted": !(item === "auto" && store.confirming),
                          "text-[var(--spicy-fg-warning)]": item === "auto" && store.confirming,
                        }}
                      >
                        {item === "auto" && store.confirming
                          ? language.t("workbench.mode.auto.confirm")
                          : language.t(`workbench.mode.${item}.description`)}
                      </DropdownMenu.ItemDescription>
                    </span>
                  </MenuV2.RadioItem>
                )}
              </For>
            </MenuV2.RadioGroup>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <span class="sr-only" aria-live="polite">
        {store.announce}
      </span>
    </Show>
  )
}
