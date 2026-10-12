import {
  createEffect,
  createMemo,
  For,
  getOwner,
  lazy,
  Match,
  on,
  onCleanup,
  runWithOwner,
  Show,
  Suspense,
  Switch,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Tabs } from "@opencode-ai/ui/tabs"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { AgentHQProvider, useAgentHQ } from "@/agenthq/context"
import { agentAttention, agentSessions } from "@/agenthq/store"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useTerminal } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { useSessionKey } from "@/pages/session/session-layout"
import { Persist, persisted } from "@/utils/persist"
import { createWorkbenchClient } from "./client"
import { createProblemsState, type ProblemFilter } from "./problems"
import { PanelState, TONE_CLASS } from "./ui"

const AgentsPanel = lazy(() => import("@/agenthq/agents-panel"))
const ProblemsPanel = lazy(() => import("./problems-panel"))

export const WORKBENCH_TABS = ["agents", "problems", "output", "debug", "run"] as const
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number]
// Tab values share the terminal tab bar with PTY ids, so they carry a prefix no PTY id has.
const PREFIX = "workbench:"

export const { use: useWorkbench, provider: WorkbenchProvider } = createSimpleContext({
  name: "Workbench",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const platform = usePlatform()
    const terminal = useTerminal()
    const command = useCommand()
    const language = useLanguage()
    const layout = useLayout()
    const { sessionKey } = useSessionKey()
    const owner = getOwner()
    // The session page remounts this provider per workspace, so the directory is fixed for its lifetime.
    const directory = sdk().directory
    const [panel, setPanel] = persisted(
      Persist.serverWorkspace(serverSDK().scope, directory, "workbench-panel"),
      createStore({ tab: "" }),
    )
    const tab = () => WORKBENCH_TABS.find((item) => item === panel.tab)

    const client = createWorkbenchClient({ server: serverSDK().server.http, directory, fetch: platform.fetch })
    const problems = createProblemsState(client.problems)
    onCleanup(problems.dispose)
    void problems.refresh()
    const stop = sdk().event.listen((event) => {
      if ((event.details as { type?: string }).type === "workbench.problems.updated") problems.invalidate()
    })
    onCleanup(stop)
    const [problemFilter, setProblemFilter] = createStore({
      severities: { error: true, warning: true, info: true, hint: true } as ProblemFilter["severities"],
      kind: "all" as ProblemFilter["kind"],
      query: "",
      collapsed: {} as Record<string, boolean>,
    })

    // Any terminal focus request (tab click, new terminal, ctrl+`) hands the tab bar back to the terminals. `on` keeps
    // the persisted store's setter (which reads the store) from becoming a dependency of this effect.
    createEffect(
      on(
        () => {
          const id = terminal.active()
          return !!id && terminal.focusRequested(id)
        },
        (requested) => {
          if (requested) setPanel("tab", "")
        },
      ),
    )

    const show = (next: WorkbenchTab) => {
      setPanel("tab", next)
      // The panel's opened flag is global; build a layout view only when a command needs it, so this provider adds no
      // per-session-switch memos (useSessionLayout would).
      runWithOwner(owner, () => layout.view(sessionKey()).terminal.open())
    }
    command.register("workbench", () => [
      {
        id: "workbench.agents",
        title: language.t("workbench.command.agents"),
        category: language.t("command.category.view"),
        onSelect: () => show("agents"),
      },
      {
        id: "workbench.problems",
        title: language.t("workbench.command.problems"),
        category: language.t("command.category.view"),
        onSelect: () => show("problems"),
      },
    ])

    return {
      tab,
      value: () => {
        const current = tab()
        return current && PREFIX + current
      },
      // Tabs onChange; returns true when `value` is a Workbench tab. Kobalte also fires onChange by itself to select the
      // first tab whenever its value is missing from the bar (no terminal yet, or one still mounting), so Workbench tabs
      // ignore it and open only on an explicit press of their trigger (`open`).
      select(value: string) {
        if (value.startsWith(PREFIX)) return true
        setPanel("tab", "")
        return false
      },
      open: (next: WorkbenchTab) => setPanel("tab", next),
      show,
      problems,
      problemFilter: { state: problemFilter, set: setProblemFilter },
    }
  },
})

export function WorkbenchProviders(props: ParentProps) {
  return (
    <AgentHQProvider>
      <WorkbenchProvider>{props.children}</WorkbenchProvider>
    </AgentHQProvider>
  )
}

// Tab triggers rendered inside the terminal panel's tab list, pinned to its trailing edge.
export function WorkbenchTabTriggers() {
  const workbench = useWorkbench()
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const problemCounts = createMemo(() => workbench.problems.state.snapshot?.counts)
  const attention = createMemo(
    () =>
      agenthq.state.agents.filter((agent) =>
        agentAttention(agentSessions(agenthq.state.sessions, agent.id), agenthq.state.unseen),
      ).length,
  )
  const badge = (tab: WorkbenchTab) => {
    if (tab === "agents") return attention() ? { count: attention(), tone: TONE_CLASS.warning } : undefined
    if (tab !== "problems") return
    const counts = problemCounts()
    if (!counts || counts.error + counts.warning === 0) return
    return { count: counts.error + counts.warning, tone: counts.error ? TONE_CLASS.danger : TONE_CLASS.warning }
  }
  return (
    <div
      data-component="workbench-tabs"
      class="sticky right-0 z-10 ml-auto flex h-full shrink-0 items-center gap-1 pl-2 pr-3"
    >
      <For each={WORKBENCH_TABS}>
        {(tab) => (
          <Tabs.Trigger
            value={PREFIX + tab}
            data-workbench-tab={tab}
            // Mouse selects on press like the terminal tabs; click covers keyboard and touch activation.
            onPointerDown={(event) => event.pointerType === "mouse" && event.button === 0 && workbench.open(tab)}
            onClick={() => workbench.open(tab)}
          >
            <span class="flex items-center gap-1.5">
              {language.t(`workbench.tab.${tab}`)}
              <Show when={badge(tab)}>
                {(value) => (
                  <span
                    class={`min-w-4 rounded-full px-1 text-center text-[10px] font-[530] leading-4 tabular-nums ${value().tone}`}
                  >
                    {value().count}
                  </span>
                )}
              </Show>
            </span>
          </Tabs.Trigger>
        )}
      </For>
    </div>
  )
}

export function WorkbenchTabContent(props: { tab: WorkbenchTab }) {
  const language = useLanguage()
  return (
    <div data-component="workbench-panel" data-tab={props.tab} class="absolute inset-0 flex flex-col overflow-hidden">
      <Suspense fallback={<PanelState icon={<LoaderV2 />} title={language.t("common.loading")} />}>
        <Switch>
          <Match when={props.tab === "agents"}>
            <AgentsPanel />
          </Match>
          <Match when={props.tab === "problems"}>
            <ProblemsPanel />
          </Match>
          <Match when={props.tab === "output"}>
            <PanelState
              icon={<Glyph path={OUTPUT_GLYPH} />}
              title={language.t("workbench.output.title")}
              description={language.t("workbench.output.description")}
            />
          </Match>
          <Match when={props.tab === "debug"}>
            <PanelState
              icon={<Glyph path={BUG_GLYPH} />}
              title={language.t("workbench.debug.title")}
              description={language.t("workbench.debug.description")}
            />
          </Match>
          <Match when={props.tab === "run"}>
            <PanelState
              icon={<Glyph path={PLAY_GLYPH} />}
              title={language.t("workbench.run.title")}
              description={language.t("workbench.run.description")}
            />
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}

// Fork icons the shared icon sets lack (static markup).
const OUTPUT_GLYPH = '<path d="M4 6h16M4 10h11M4 14h16M4 18h8"/>'
const BUG_GLYPH =
  '<path d="M9 7.5a3 3 0 0 1 6 0"/><rect x="7" y="7.5" width="10" height="12" rx="5"/><path d="M12 11v8.5M3 13.5h4M17 13.5h4M4 8.5l3 2M20 8.5l-3 2M4 19l3-2M20 19l-3-2"/>'
const PLAY_GLYPH = '<path d="M8 5.5v13l10.5-6.5z"/>'

function Glyph(props: { path: string }) {
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
