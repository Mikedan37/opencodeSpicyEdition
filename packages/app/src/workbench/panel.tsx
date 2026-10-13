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
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { createResizeObserver } from "@solid-primitives/resize-observer"
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
import { DebugProvider } from "./debug-context"
import { EditorProvider } from "./editor-context"
import { createHandoff, type HandoffPayload } from "./handoff"
import { createProblemsState, type ProblemFilter } from "./problems"
import { createInvestigationsState } from "./investigations"
import { createRunsState, isFinished } from "./runs"
import { createToolsState } from "./tools"
import { latestRun, PROBLEM_CONTEXT, problemSnapshot, problemSummary, shortPath } from "./snapshot"
import {
  AGENT_VIEWS,
  fitTabs,
  legacyTab,
  migratePanel,
  PLACES,
  SURFACES,
  TRIGGER_ID,
  type AgentView,
  type DebugView,
  type PlaceID,
  type Surface,
} from "./tabs"
import { PanelState, TAB_FOCUS, TONE_CLASS } from "./ui"

const AgentsPanel = lazy(() => import("@/agenthq/agents-panel"))
const ProblemsPanel = lazy(() => import("./problems-panel"))
const OutputPanel = lazy(() => import("./output-panel"))
const DebugConsolePanel = lazy(() => import("./debug-console"))
const DebugRunPanel = lazy(() => import("./debug-run"))

const runEvents = {
  updated: Schema.decodeUnknownOption(Workbench.Event.RunUpdated.data),
  output: Schema.decodeUnknownOption(Workbench.Event.RunOutput.data),
  investigation: Schema.decodeUnknownOption(Workbench.Event.InvestigationUpdated.data),
  tool: Schema.decodeUnknownOption(Workbench.Event.ToolUpdated.data),
  toolRemoved: Schema.decodeUnknownOption(Workbench.Event.ToolRemoved.data),
}

// Tab values share the terminal tab bar with PTY ids, so they carry a prefix no PTY id has.
const PREFIX = "workbench:"
// Palette and View menu entries, by their ids from before the regroup, and where each lands (UX #7).
const PALETTE = [
  ["problems", "problems"],
  ["output", "checks"],
  ["debug", "console"],
  ["run", "program"],
  ["agents", "agentList"],
  ["tasks", "tasks"],
  ["activity", "activity"],
  ["tools", "tools"],
] as const satisfies readonly (readonly [string, PlaceID])[]

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
    // The open surface ("" for a terminal) and the last view of Debug and Agents, per workspace.
    const [panel, setPanel] = persisted(
      { ...Persist.serverWorkspace(serverSDK().scope, directory, "workbench-panel"), migrate: migratePanel },
      createStore({ tab: "", debug: "console" as DebugView, agents: "agents" as AgentView }),
    )
    const tab = () => SURFACES.find((item) => item === panel.tab)

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
    // appears later (recovery, a new PTY) does not pull the bar back. Opening an Agents view leaves an agent's
    // workspace; opening the surface alone keeps it (an agent's session opened from elsewhere).
    const open = (id: PlaceID) => {
      const place: { surface: Surface; view?: DebugView | AgentView } = PLACES[id]
      terminal.cancelFocus()
      setPanel("tab", place.surface)
      if (place.surface === "debug" && place.view) setPanel("debug", place.view as DebugView)
      if (place.surface !== "agents" || !place.view) return
      agenthq.selectAgent(undefined)
      setPanel("agents", place.view as AgentView)
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
    const show = (id: PlaceID) => {
      open(id)
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
    // What needs the user in each Agents view: agents with an ask, a failure or a result not seen yet; tasks waiting
    // for review; investigations waiting for a human; drafted tools waiting for approval.
    const attention = {
      agents: createMemo(
        () =>
          agenthq.state.agents.filter((agent) =>
            agentAttention(agentSessions(agenthq.state.sessions, agent.id), agenthq.seen),
          ).length,
      ),
      tasks: createMemo(() => agenthq.tasks.state.tasks.filter((task) => task.status === "review").length),
      activity: () => investigations.waiting(),
      tools: () => tools.waiting(),
    } satisfies Record<AgentView, () => number>
    // All of it, on the Agents tab and the status strip.
    const needsYou = createMemo(() => AGENT_VIEWS.reduce((sum, view) => sum + attention[view](), 0))
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
            show("tasks")
            agenthq.selectTask(saved.id)
          }}
        />
      ))
    }
    command.register("workbench", () => {
      const view = language.t("command.category.view")
      const ide = language.t("workbench.command.category")
      return [
        ...PALETTE.map(([id, place]) => ({
          id: `workbench.${id}`,
          title: language.t(`workbench.command.${id}`),
          category: view,
          onSelect: () => show(place),
        })),
        {
          id: "workbench.check",
          title: language.t("workbench.command.check"),
          category: ide,
          disabled: runs.state.checking,
          onSelect: () => {
            show("checks")
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
      debugView: () => panel.debug,
      agentsView: () => panel.agents,
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
      attention,
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

// Tab triggers rendered inside the terminal panel's tab list, pinned to its trailing edge: Problems, Checks, Debug,
// Agents. The ones that do not fit go to a "»" menu (UX #7), leaving room for the terminals' first tabs.
const GAP = 4
const PADDING = 20
const TERMINAL_ROOM = 160
const MORE = 32
export function WorkbenchTabTriggers() {
  const workbench = useWorkbench()
  const terminal = useTerminal()
  const language = useLanguage()
  const problemCounts = createMemo(() => workbench.problems.state.snapshot?.counts)
  const running = createMemo(() => workbench.runs.state.runs.filter((entry) => !isFinished(entry.info.status)).length)
  const badge = (surface: Surface) => {
    if (surface === "agents") {
      const count = workbench.needsYou()
      return count ? { count, tone: TONE_CLASS.warning } : undefined
    }
    if (surface === "checks") return running() ? { count: running(), tone: TONE_CLASS.info } : undefined
    if (surface !== "problems") return
    const counts = problemCounts()
    if (!counts || counts.error + counts.warning === 0) return
    return { count: counts.error + counts.warning, tone: counts.error ? TONE_CLASS.danger : TONE_CLASS.warning }
  }

  // Which surfaces show in the bar (indexes into SURFACES), from each trigger's last measured width.
  const [shown, setShown] = createSignal<number[]>(SURFACES.map((_, index) => index))
  const widths = SURFACES.map(() => 76)
  let group: HTMLDivElement | undefined
  let frame: number | undefined
  const measure = () => {
    frame = undefined
    const list = group?.parentElement
    if (!group || !list) return
    for (const node of group.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger-wrapper"]')) {
      const at = SURFACES.indexOf(node.dataset.value?.slice(PREFIX.length) as Surface)
      if (at >= 0) widths[at] = node.offsetWidth + GAP
    }
    let terminals = 0
    for (const node of list.children) if (node !== group) terminals += (node as HTMLElement).offsetWidth
    const more = (group.querySelector<HTMLElement>('[data-action="workbench-tabs-more"]')?.offsetWidth ?? MORE) + GAP
    const room = list.clientWidth - Math.min(terminals, TERMINAL_ROOM) - PADDING
    const next = fitTabs(widths, room, more, SURFACES.indexOf(workbench.tab()!))
    if (next.join() !== shown().join()) setShown(next)
  }
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(measure)
  }
  onCleanup(() => frame !== undefined && cancelAnimationFrame(frame))
  createResizeObserver(() => [group, group?.parentElement].filter((node) => !!node) as HTMLElement[], schedule)
  createEffect(on(() => [workbench.tab(), terminal.all().length], schedule))
  const hidden = () => SURFACES.filter((_, index) => !shown().includes(index))

  const label = (surface: Surface) => language.t(`workbench.tab.${surface}`)
  return (
    <div
      ref={group}
      data-component="workbench-tabs"
      class="sticky right-0 z-10 ml-auto flex h-full shrink-0 items-center gap-1 pl-2 pr-3"
    >
      <For each={SURFACES}>
        {(surface, index) => (
          <Show when={shown().includes(index())}>
            <Tabs.Trigger
              value={PREFIX + surface}
              data-workbench-tab={TRIGGER_ID[surface]}
              data-surface={surface}
              class={TAB_FOCUS}
              // Mouse selects on press like the terminal tabs; click covers keyboard and touch activation.
              onPointerDown={(event) => event.pointerType === "mouse" && event.button === 0 && workbench.open(surface)}
              onClick={() => workbench.open(surface)}
            >
              <span class="flex items-center gap-1.5">
                {label(surface)}
                <Show when={badge(surface)}>
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
          </Show>
        )}
      </For>
      <Show when={hidden().length}>
        <MenuV2 gutter={4} modal={false} placement="bottom-end">
          <MenuV2.Trigger
            as={ButtonV2}
            size="small"
            variant="ghost"
            data-action="workbench-tabs-more"
            aria-label={language.t("workbench.tabs.more")}
            title={language.t("workbench.tabs.more")}
          >
            »
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content data-tabs-menu="">
              <For each={hidden()}>
                {(surface) => (
                  <MenuV2.Item
                    data-surface={surface}
                    badge={badge(surface) ? String(badge(surface)!.count) : undefined}
                    onSelect={() => workbench.open(surface)}
                  >
                    {label(surface)}
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </Show>
    </div>
  )
}

export function WorkbenchTabContent(props: { tab: Surface }) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const view = () =>
    props.tab === "debug" ? workbench.debugView() : props.tab === "agents" ? workbench.agentsView() : undefined
  return (
    <div
      data-component="workbench-panel"
      data-surface={props.tab}
      data-tab={legacyTab(props.tab, view())}
      class="absolute inset-0 flex flex-col overflow-hidden"
    >
      <Suspense fallback={<PanelState icon={<LoaderV2 />} title={language.t("common.loading")} />}>
        <Switch>
          <Match when={props.tab === "problems"}>
            <ProblemsPanel />
          </Match>
          <Match when={props.tab === "checks"}>
            <OutputPanel />
          </Match>
          <Match when={props.tab === "debug" && view() === "program"}>
            <DebugRunPanel />
          </Match>
          <Match when={props.tab === "debug"}>
            <DebugConsolePanel />
          </Match>
          <Match when={props.tab === "agents"}>
            <AgentsPanel />
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}
