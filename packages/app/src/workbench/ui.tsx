import { Show, type JSX } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { errorText, WorkbenchRequestError } from "./client"

export const TONE_CLASS = {
  info: "bg-v2-state-bg-info text-v2-state-fg-info",
  success: "bg-v2-state-bg-success text-v2-state-fg-success",
  warning: "bg-v2-state-bg-warning text-v2-state-fg-warning",
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

export function Glyph(props: { path: string }) {
  return (
    <svg
      width="24"
      height="24"
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
