import { For, Show, type JSX } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { errorText, WorkbenchRequestError } from "./client"
import "./tokens.css"

// A keyboard focus ring for the fork's tab triggers (upstream's tab bar clears focus styles on the trigger button).
export const TAB_FOCUS = "has-[:focus-visible]:shadow-[inset_0_0_0_2px_var(--v2-border-border-focus)]!"

export const TONE_CLASS = {
  info: "bg-v2-state-bg-info text-v2-state-fg-info",
  success: "bg-v2-state-bg-success text-[var(--spicy-fg-success)]",
  warning: "bg-v2-state-bg-warning text-[var(--spicy-fg-warning)]",
  danger: "bg-v2-state-bg-danger text-v2-state-fg-danger",
  neutral: "bg-v2-background-bg-layer-02 text-v2-text-text-muted",
} as const

// Centered message used for empty, loading and error states across the Workbench tabs.
export function PanelState(props: { icon?: JSX.Element; title: string; description?: string; children?: JSX.Element }) {
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <Show when={props.icon}>
        <div class="mb-1 text-v2-icon-icon-muted">{props.icon}</div>
      </Show>
      <div class="text-[13px] font-[530] leading-[18px] text-v2-text-text-base">{props.title}</div>
      <Show when={props.description}>
        <div class="max-w-sm text-[12px] leading-[18px] text-v2-text-text-muted">{props.description}</div>
      </Show>
      <Show when={props.children}>
        <div class="mt-2 flex items-center gap-2">{props.children}</div>
      </Show>
    </div>
  )
}

export function RequestErrorState(props: { error: unknown; onRetry: () => void }) {
  const language = useLanguage()
  return (
    <PanelState
      title={
        props.error instanceof WorkbenchRequestError && props.error.kind === "unavailable"
          ? language.t("workbench.error.unavailable")
          : language.t("workbench.error.failed", { message: errorText(props.error) })
      }
    >
      <ButtonV2 size="small" variant="neutral" onClick={props.onRetry}>
        {language.t("workbench.retry")}
      </ButtonV2>
    </PanelState>
  )
}

// Fork icons the shared icon sets lack (static markup).
export const OUTPUT_GLYPH = '<path d="M4 6h16M4 10h11M4 14h16M4 18h8"/>'
export const BUG_GLYPH =
  '<path d="M9 7.5a3 3 0 0 1 6 0"/><rect x="7" y="7.5" width="10" height="12" rx="5"/><path d="M12 11v8.5M3 13.5h4M17 13.5h4M4 8.5l3 2M20 8.5l-3 2M4 19l3-2M20 19l-3-2"/>'
export const PLAY_GLYPH = '<path d="M8 5.5v13l10.5-6.5z"/>'
export const DEBUG_GLYPHS = {
  start: PLAY_GLYPH,
  continue: '<path d="M6 5.5v13"/><path d="M10 5.5v13l9-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  next: '<path d="M4.5 14a7.5 7.5 0 0 1 14.2-3.4"/><path d="M19.5 5.5v5h-5"/><circle cx="12" cy="18.5" r="1.5"/>',
  stepIn: '<path d="M12 3.5v10"/><path d="M8 9.5l4 4 4-4"/><circle cx="12" cy="19" r="1.5"/>',
  stepOut: '<path d="M12 13.5v-10"/><path d="M8 7.5l4-4 4 4"/><circle cx="12" cy="19" r="1.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
} as const

export function Glyph(props: { path: string; size?: number }) {
  return (
    <svg
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={props.path}
    />
  )
}

// Text with `code` spans, the way provider reasons name their commands ("run `codex login`"). Unpaired backticks stay
// text.
export function InlineCode(props: { text: string }) {
  const parts = () => {
    const split = props.text.split("`")
    return split.length % 2 ? split : [props.text]
  }
  return (
    <For each={parts()}>
      {(part, index) =>
        index() % 2 ? (
          <code class="rounded-[3px] bg-v2-background-bg-layer-02 px-1 font-mono text-[0.95em]">{part}</code>
        ) : (
          part
        )
      }
    </For>
  )
}
