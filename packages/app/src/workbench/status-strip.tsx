import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { isLive, stopReason } from "./debug"
import { useDebug } from "./debug-context"
import { useWorkbench } from "./panel"
import { isFinished } from "./runs"

const ITEM =
  "flex h-full shrink-0 items-center gap-1.5 rounded-[4px] px-2 whitespace-nowrap outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
const PANEL_KEY = "terminal.toggle"

// Always on the session page, whether the panel is open or not: what the IDE knows at a glance. Each item opens its
// tab, opening the panel when it is closed.
export function WorkbenchStatusStrip() {
  const workbench = useWorkbench()
  const debug = useDebug()
  const language = useLanguage()
  const command = useCommand()
  const snapshot = () => workbench.problems.state.snapshot
  const running = createMemo(() => workbench.runs.state.runs.filter((entry) => !isFinished(entry.info.status)).length)
  const problems = () => {
    const current = snapshot()
    if (!current) return { text: language.t("workbench.status.problems.loading") }
    if (!current.producers.length) return { text: language.t("workbench.status.problems.unchecked") }
    const counts = current.counts
    if (!counts.error && !counts.warning) return { text: language.t("workbench.status.problems.none") }
    const parts = [
      counts.error ? language.plural("workbench.status.errors", counts.error) : undefined,
      counts.warning ? language.plural("workbench.status.warnings", counts.warning) : undefined,
    ]
    return { text: parts.filter(Boolean).join(" · "), tone: counts.error ? "error" : "warning" }
  }
  const session = () => {
    const current = debug.selected()
    return current && isLive(current) ? current : undefined
  }
  const debugText = () => {
    const current = session()
    if (!current) return ""
    if (current.state === "stopped" && current.stop)
      return language.t("workbench.debug.status.stopped", {
        reason: current.stop.exception?.id ?? stopReason(current.stop),
      })
    return language.t(`workbench.debug.state.${current.state}`)
  }
  return (
    <nav
      data-component="workbench-status"
      aria-label={language.t("workbench.status.label")}
      class="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-v2-border-border-muted bg-v2-background-bg-base px-1.5 text-[11px] text-v2-text-text-muted"
    >
      <button type="button" data-status="problems" class={ITEM} onClick={() => workbench.show("problems")}>
        <Show when={problems().tone}>
          {(tone) => (
            <span
              aria-hidden="true"
              class="size-2 shrink-0 rounded-full"
              classList={{
                "bg-v2-state-fg-danger": tone() === "error",
                "bg-v2-state-fg-warning": tone() === "warning",
              }}
            />
          )}
        </Show>
        <span class="font-[530] text-v2-text-text-base">{language.t("workbench.tab.problems")}</span>
        <span>{problems().text}</span>
      </button>
      <button type="button" data-status="agents" class={ITEM} onClick={() => workbench.show("agents")}>
        <span class="font-[530] text-v2-text-text-base">{language.t("workbench.tab.agents")}</span>
        <Show when={workbench.needsYou()}>
          {(count) => (
            <span class="rounded-full bg-v2-state-bg-warning px-1.5 font-[530] text-v2-state-fg-warning">
              {language.plural("workbench.status.needsYou", count())}
            </span>
          )}
        </Show>
      </button>
      <Show when={session()}>
        <button type="button" data-status="debug" class={ITEM} onClick={() => workbench.show("debug")}>
          <span class="font-[530] text-v2-text-text-base">{language.t("workbench.status.debug")}</span>
          <span classList={{ "text-v2-state-fg-warning": session()?.state === "stopped" }}>{debugText()}</span>
        </button>
      </Show>
      <Show when={running()}>
        {(count) => (
          <button type="button" data-status="checks" class={ITEM} onClick={() => workbench.show("output")}>
            <LoaderV2 width={10} height={10} />
            {language.plural("workbench.status.checks", count())}
          </button>
        )}
      </Show>
      <span class="flex-1" />
      <button
        type="button"
        data-status="panel"
        class={ITEM}
        aria-keyshortcuts="Control+`"
        onClick={() => command.trigger(PANEL_KEY)}
      >
        {language.t("workbench.status.panel")}
        <kbd class="font-sans text-v2-text-text-faint">{command.keybind(PANEL_KEY)}</kbd>
      </button>
    </nav>
  )
}

// One-time card in an empty session: where the IDE lives. Dismissed once, for good.
export function WorkbenchIntro(props: { empty: boolean }) {
  const language = useLanguage()
  const command = useCommand()
  const [intro, setIntro] = persisted(Persist.global("workbench.intro"), createStore({ dismissed: false }))
  return (
    <Show when={props.empty && !intro.dismissed}>
      <section
        data-component="workbench-intro"
        aria-labelledby="workbench-intro-title"
        class="mx-auto mb-2 flex w-full max-w-[640px] shrink-0 items-start gap-3 rounded-[8px] bg-v2-background-bg-layer-01 px-4 py-3 shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
      >
        <div class="min-w-0 flex-1">
          <h2 id="workbench-intro-title" class="text-[13px] font-[530] text-v2-text-text-base">
            {language.t("workbench.intro.title")}
          </h2>
          <p class="mt-1 text-[12px] leading-[18px] text-v2-text-text-muted">
            {language.t("workbench.intro.body", { key: command.keybind(PANEL_KEY) })}
          </p>
          <ButtonV2 size="small" variant="neutral" class="mt-2" onClick={() => command.trigger(PANEL_KEY)}>
            {language.t("workbench.intro.open")}
          </ButtonV2>
        </div>
        <IconButton
          icon="close-small"
          variant="ghost"
          aria-label={language.t("workbench.intro.dismiss")}
          onClick={() => setIntro("dismissed", true)}
        />
      </section>
    </Show>
  )
}
