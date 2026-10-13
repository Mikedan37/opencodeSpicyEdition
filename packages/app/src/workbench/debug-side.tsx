import { createEffect, lazy, on, Show, Suspense, type Accessor } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useLanguage } from "@/context/language"
import { useDebug } from "./debug-context"
import { useWorkbench } from "./panel"
import { PanelState, TAB_FOCUS } from "./ui"
import "./debug-side.css"

const DebugPanel = lazy(() => import("./debug-panel"))
export const DEBUG_SIDE_TAB = "workbench:debug"

// The side panel's Debug tab shows over the tab the panel has selected (session-side-panel.tsx keeps its own tabs
// untouched). Opening another tab, or any file, hides it.
export function useDebugSideTab(active: Accessor<string | undefined>) {
  const workbench = useWorkbench()
  createEffect(on(active, () => workbench.hideSide(), { defer: true }))
  return {
    value: () => (workbench.side() ? DEBUG_SIDE_TAB : undefined),
    // Tabs onChange; true for the Debug tab. Kobalte also selects the first trigger by itself when the bar's value
    // has none, so the Debug tab opens only on an explicit press of its trigger.
    select(value: string) {
      if (value === DEBUG_SIDE_TAB) return true
      workbench.hideSide()
      return false
    },
  }
}

export function DebugSideTrigger() {
  const workbench = useWorkbench()
  const debug = useDebug()
  const language = useLanguage()
  const state = () => debug.selected()?.state
  return (
    <Tabs.Trigger
      value={DEBUG_SIDE_TAB}
      data-workbench-side-tab="debug"
      class={TAB_FOCUS}
      onPointerDown={(event) => event.pointerType === "mouse" && event.button === 0 && workbench.showSide()}
      onClick={() => workbench.showSide()}
    >
      <span class="flex items-center gap-1.5">
        {language.t("workbench.debug.side.tab")}
        <Show when={state() === "running" || state() === "stopped" || state() === "starting"}>
          <span
            class="size-1.5 rounded-full"
            classList={{
              "bg-v2-state-fg-warning": state() === "stopped",
              "bg-v2-state-fg-success": state() !== "stopped",
            }}
            title={language.t(`workbench.debug.state.${state()!}`)}
          />
          {/* The dot's meaning for screen readers: "Debug, Paused" */}
          <span class="sr-only">{language.t(`workbench.debug.state.${state()!}`)}</span>
        </Show>
      </span>
    </Tabs.Trigger>
  )
}

export function DebugSideContent() {
  const workbench = useWorkbench()
  const language = useLanguage()
  return (
    <Show when={workbench.side()}>
      <div
        data-component="workbench-debug-side"
        role="tabpanel"
        class="flex min-h-0 flex-1 flex-col overflow-hidden bg-v2-background-bg-base"
      >
        <Suspense fallback={<PanelState icon={<LoaderV2 />} title={language.t("common.loading")} />}>
          <DebugPanel />
        </Suspense>
      </div>
    </Show>
  )
}
