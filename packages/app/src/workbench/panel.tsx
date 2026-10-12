import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
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
import { Option, Schema } from "effect"
import { Workbench } from "@opencode-ai/schema/workbench"
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
import { DebugProvider } from "./debug-context"
import { createProblemsState, type ProblemFilter } from "./problems"
import { createRunsState, isFinished } from "./runs"
import { PanelState, TONE_CLASS } from "./ui"

const AgentsPanel = lazy(() => import("@/agenthq/agents-panel"))
const ProblemsPanel = lazy(() => import("./problems-panel"))
const OutputPanel = lazy(() => import("./output-panel"))
const DebugConsolePanel = lazy(() => import("./debug-console"))
const DebugRunPanel = lazy(() => import("./debug-run"))

const runEvents = {
  updated: Schema.decodeUnknownOption(Workbench.Event.RunUpdated.data),
  output: Schema.decodeUnknownOption(Workbench.Event.RunOutput.data),
}

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
    const runs = createRunsState(client)
    const stop = sdk().event.listen((event) => {
      const details = event.details as { type?: string; properties?: unknown }
      if (details.type === "workbench.problems.updated") return problems.invalidate()
      if (details.type === "workbench.run.updated")
        return Option.map(runEvents.updated(details.properties), (data) => runs.update(data.run))
      if (details.type === "workbench.run.output")
        return Option.map(runEvents.output(details.properties), (data) => runs.output(data))
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

    // Choosing a Workbench tab drops a terminal focus request that has not been served yet, so a terminal that
    // appears later (recovery, a new PTY) does not pull the bar back.
    const open = (next: WorkbenchTab) => {
      terminal.cancelFocus()
      setPanel("tab", next)
    }
    // The panels' opened flags live in the layout; build a layout view only when a command needs it, in a root that is
    // disposed right away, so this provider adds no per-session-switch memos (useSessionLayout would) and none pile up.
    const withView = (fn: (view: ReturnType<typeof layout.view>) => void) =>
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          fn(layout.view(sessionKey()))
          dispose()
        }),
      )
    const show = (next: WorkbenchTab) => {
      open(next)
      withView((view) => view.terminal.open())
    }
    // The Debug tab of the side panel (workbench/debug-side.tsx) shows over whatever tab the panel has selected.
    const [side, setSide] = createSignal(false)
    const showSide = () => {
      withView((view) => !view.reviewPanel.opened() && view.reviewPanel.open())
      setSide(true)
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
      open,
      show,
      side,
      showSide,
      hideSide: () => setSide(false),
      directory,
      client,
      problems,
      runs,
      problemFilter: { state: problemFilter, set: setProblemFilter },
    }
  },
})

export function WorkbenchProviders(props: ParentProps) {
  return (
    <AgentHQProvider>
      <WorkbenchProvider>
        <DebugProvider>{props.children}</DebugProvider>
      </WorkbenchProvider>
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
        agentAttention(agentSessions(agenthq.state.sessions, agent.id), agenthq.seen),
      ).length,
  )
  const running = createMemo(() => workbench.runs.state.runs.filter((entry) => !isFinished(entry.info.status)).length)
  const badge = (tab: WorkbenchTab) => {
    if (tab === "agents") return attention() ? { count: attention(), tone: TONE_CLASS.warning } : undefined
    if (tab === "output") return running() ? { count: running(), tone: TONE_CLASS.info } : undefined
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
            <OutputPanel />
          </Match>
          <Match when={props.tab === "debug"}>
            <DebugConsolePanel />
          </Match>
          <Match when={props.tab === "run"}>
            <DebugRunPanel />
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}
