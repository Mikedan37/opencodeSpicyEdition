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
import { useFile } from "@/context/file"
import { useSessionKey } from "@/pages/session/session-layout"
import { Persist, persisted } from "@/utils/persist"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@/utils/toast"
import { createWorkbenchClient, errorText, WorkbenchRequestError } from "./client"
import { DebugProvider, useDebug } from "./debug-context"
import { EditorProvider } from "./editor-context"
import { createHandoff, type HandoffPayload } from "./handoff"
import { createProblemsState, type ProblemFilter } from "./problems"
import { createInvestigationsState } from "./investigations"
import { createRunsState, isFinished } from "./runs"
import { createToolsState } from "./tools"
import { latestRun, PROBLEM_CONTEXT, problemSnapshot, problemSummary, shortPath } from "./snapshot"
import { PanelState, TONE_CLASS } from "./ui"

const AgentsPanel = lazy(() => import("@/agenthq/agents-panel"))
const ProblemsPanel = lazy(() => import("./problems-panel"))
const OutputPanel = lazy(() => import("./output-panel"))
const DebugConsolePanel = lazy(() => import("./debug-console"))
const DebugRunPanel = lazy(() => import("./debug-run"))
const ActivityPanel = lazy(() => import("./activity-panel"))
const ToolsPanel = lazy(() => import("./tools-panel"))

const runEvents = {
  updated: Schema.decodeUnknownOption(Workbench.Event.RunUpdated.data),
  output: Schema.decodeUnknownOption(Workbench.Event.RunOutput.data),
  investigation: Schema.decodeUnknownOption(Workbench.Event.InvestigationUpdated.data),
  tool: Schema.decodeUnknownOption(Workbench.Event.ToolUpdated.data),
  toolRemoved: Schema.decodeUnknownOption(Workbench.Event.ToolRemoved.data),
}

export const WORKBENCH_TABS = ["agents", "problems", "output", "debug", "run", "activity", "tools"] as const
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
    const dialog = useDialog()
    const agenthq = useAgentHQ()
    const file = useFile()
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
    const investigations = createInvestigationsState(client)
    void investigations.load()
    const tools = createToolsState(client)
    onCleanup(tools.dispose)
    void tools.load()
    const stop = sdk().event.listen((event) => {
      const details = event.details as { type?: string; properties?: unknown }
      if (details.type === "workbench.problems.updated") return problems.invalidate()
      if (details.type === "workbench.run.updated")
        return Option.map(runEvents.updated(details.properties), (data) => runs.update(data.run))
      if (details.type === "workbench.run.output")
        return Option.map(runEvents.output(details.properties), (data) => runs.output(data))
      if (details.type === "workbench.investigation.updated")
        return Option.map(runEvents.investigation(details.properties), (data) =>
          investigations.update(data.investigation),
        )
      if (details.type === "workbench.tool.updated")
        return Option.map(runEvents.tool(details.properties), (data) => tools.update(data.tool))
      if (details.type === "workbench.tool.removed")
        return Option.map(runEvents.toolRemoved(details.properties), (data) => tools.remove(data.name))
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
    const handoff = createHandoff({ directory, showAgents: () => show("agents") })
    // UI-07: what "Fix with agent" sends for these problems, made when a target is picked: a one-line summary, and the
    // snapshot with the lines around them and the latest verification run.
    const problemPayload = async (list: readonly Workbench.Problem[], file?: string): Promise<HandoffPayload> => {
      const [source] = await Promise.all([
        file
          ? client.readFile(shortPath(directory, file)).then(
              (result) => ({ text: result.content }),
              (error: unknown) => ({ error: errorText(error) }),
            )
          : undefined,
        runs.load(),
      ])
      const input = { root: directory, file, problems: list }
      const latest = latestRun(
        list,
        runs.state.runs.map((entry) => entry.info),
      )
      return {
        summary: problemSummary(input),
        context: problemSnapshot({ ...input, source, run: latest }),
        name: PROBLEM_CONTEXT,
      }
    }
    // The picker as a dialog, for the editor's lint tooltip and the palette.
    const fixProblems = (list: readonly Workbench.Problem[], file?: string) =>
      handoff.choose(language.t("workbench.handoff.fix"), () => problemPayload(list, file))
    // The open file tab's problems (the palette's Fix); a throwaway root so no layout memos pile up per call.
    const openFileProblems = () =>
      runWithOwner(owner, () =>
        createRoot((dispose) => {
          const active = layout.tabs(sessionKey()).active()
          dispose()
          const path = active ? file.pathFromTab(active) : undefined
          if (!path) return { problems: [] as Workbench.Problem[] }
          return {
            path,
            problems: (problems.state.snapshot?.problems ?? []).filter(
              (problem) => problem.file && file.normalize(problem.file) === path,
            ),
          }
        }),
      )!
    // The Debug tab of the side panel (workbench/debug-side.tsx) shows over whatever tab the panel has selected.
    const [side, setSide] = createSignal(false)
    const showSide = () => {
      withView((view) => !view.reviewPanel.opened() && view.reviewPanel.open())
      setSide(true)
    }
    // Checks over the whole project as one folder unit (the server checks up to 200 of its source files); the Output
    // tab, Problems, the palette and the status strip all start them here.
    const runChecks = () =>
      runs.check({ unit: directory }).catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("workbench.output.failed"),
          description:
            error instanceof WorkbenchRequestError && error.kind === "unavailable"
              ? language.t("workbench.output.unavailable")
              : errorText(error),
        }),
      )
    // Agents that need the user (an ask, a failure, a result not seen yet) plus tasks waiting for review: the Agents
    // tab's badge and the status strip.
    const needsYou = createMemo(
      () =>
        agenthq.state.agents.filter((agent) =>
          agentAttention(agentSessions(agenthq.state.sessions, agent.id), agenthq.seen),
        ).length + agenthq.tasks.state.tasks.filter((task) => task.status === "review").length,
    )
    // The dialogs live in the Agents tab's lazy chunks; the palette opens them without opening the tab first.
    const newAgent = async () => {
      const { AgentDialog, createAgentDraft } = await import("@/agenthq/agent-dialog")
      const draft = createAgentDraft(undefined, directory)
      const showDialog = () => dialog.show(() => <AgentDialog draft={draft} reopen={showDialog} />)
      showDialog()
    }
    const newTask = async () => {
      const { TaskDialog } = await import("@/agenthq/tasks-panel")
      dialog.show(() => (
        <TaskDialog
          onSaved={(saved) => {
            agenthq.setView("tasks")
            agenthq.selectTask(saved.id)
            show("agents")
          }}
        />
      ))
    }
    command.register("workbench", () => {
      const view = language.t("command.category.view")
      const ide = language.t("workbench.command.category")
      return [
        ...WORKBENCH_TABS.map((tab) => ({
          id: `workbench.${tab}`,
          title: language.t(`workbench.command.${tab}`),
          category: view,
          onSelect: () => show(tab),
        })),
        {
          id: "workbench.check",
          title: language.t("workbench.command.check"),
          category: ide,
          disabled: runs.state.checking,
          onSelect: () => {
            show("output")
            void runChecks()
          },
        },
        {
          id: "workbench.agent.new",
          title: language.t("workbench.command.newAgent"),
          category: ide,
          onSelect: newAgent,
        },
        {
          id: "workbench.task.new",
          title: language.t("workbench.command.newTask"),
          category: ide,
          disabled: agenthq.state.agents.length === 0,
          onSelect: newTask,
        },
        {
          id: "workbench.fix",
          title: language.t("workbench.command.fix"),
          category: ide,
          onSelect: () => {
            const open = openFileProblems()
            if (!open.problems.length) return showToast({ title: language.t("workbench.handoff.noProblems") })
            fixProblems(open.problems, open.problems[0]?.file)
          },
        },
        {
          id: "workbench.tool.new",
          title: language.t("workbench.command.newTool"),
          category: ide,
          onSelect: () => {
            tools.setCreating(true)
            show("tools")
          },
        },
      ]
    })

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
      investigations,
      tools,
      handoff,
      problemPayload,
      fixProblems,
      runChecks,
      needsYou,
      problemFilter: { state: problemFilter, set: setProblemFilter },
    }
  },
})

export function WorkbenchProviders(props: ParentProps) {
  return (
    <AgentHQProvider>
      <WorkbenchProvider>
        <DebugProvider>
          <EditorProvider>{props.children}</EditorProvider>
        </DebugProvider>
      </WorkbenchProvider>
    </AgentHQProvider>
  )
}

// Tab triggers rendered inside the terminal panel's tab list, pinned to its trailing edge.
export function WorkbenchTabTriggers() {
  const workbench = useWorkbench()
  const debug = useDebug()
  const language = useLanguage()
  // UX #13: Run is a debugged program's terminal, so its tab shows once a debug session has one (and while it is open).
  const shown = (tab: WorkbenchTab) =>
    tab !== "run" || workbench.tab() === "run" || debug.state.sessions.some((item) => item.ptyID)
  const problemCounts = createMemo(() => workbench.problems.state.snapshot?.counts)
  const attention = workbench.needsYou
  const running = createMemo(() => workbench.runs.state.runs.filter((entry) => !isFinished(entry.info.status)).length)
  const badge = (tab: WorkbenchTab) => {
    if (tab === "agents") return attention() ? { count: attention(), tone: TONE_CLASS.warning } : undefined
    if (tab === "output") return running() ? { count: running(), tone: TONE_CLASS.info } : undefined
    if (tab === "activity") {
      const waiting = workbench.investigations.waiting()
      return waiting ? { count: waiting, tone: TONE_CLASS.warning } : undefined
    }
    if (tab === "tools") {
      const waiting = workbench.tools.waiting()
      return waiting ? { count: waiting, tone: TONE_CLASS.warning } : undefined
    }
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
      <For each={WORKBENCH_TABS.filter(shown)}>
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
          <Match when={props.tab === "activity"}>
            <ActivityPanel />
          </Match>
          <Match when={props.tab === "tools"}>
            <ToolsPanel />
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}
