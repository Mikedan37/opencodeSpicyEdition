import { Option, Schema } from "effect"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"
import { createAgentHQStore } from "./store"
import { createTasksState } from "./tasks"
import { createWorkbenchClient, errorText, type AgentDraft } from "@/workbench/client"

const events = {
  "agenthq.agent.updated": Schema.decodeUnknownOption(AgentHQ.Event.AgentUpdated.data),
  "agenthq.agent.removed": Schema.decodeUnknownOption(AgentHQ.Event.AgentRemoved.data),
  "agenthq.provider.updated": Schema.decodeUnknownOption(AgentHQ.Event.ProviderUpdated.data),
  "agenthq.session.updated": Schema.decodeUnknownOption(AgentHQ.Event.SessionUpdated.data),
  "agenthq.session.event": Schema.decodeUnknownOption(AgentHQ.Event.SessionEvent.data),
  "agenthq.task.updated": Schema.decodeUnknownOption(AgentHQ.Event.TaskUpdated.data),
  "agenthq.task.removed": Schema.decodeUnknownOption(AgentHQ.Event.TaskRemoved.data),
  "agenthq.message": Schema.decodeUnknownOption(AgentHQ.Event.MessageEvent.data),
}

export const { use: useAgentHQ, provider: AgentHQProvider } = createSimpleContext({
  name: "AgentHQ",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const platform = usePlatform()
    // The session page remounts this provider per workspace, so the directory is fixed for its lifetime.
    const directory = sdk().directory
    const client = createWorkbenchClient({ server: serverSDK().server.http, directory, fetch: platform.fetch })
    // Seen marks outlive the window; agents and sessions are global, so the marks are per server, not per project.
    const [seen, setSeen] = persisted(
      Persist.serverGlobal(serverSDK().scope, "agenthq.seen"),
      createStore<Record<string, number>>({}),
    )
    const store = createAgentHQStore([seen, setSeen])
    // Tasks and agent messages are process-global like agents; their routes may be missing on older servers, so they
    // load on their own and a failure stays inside the Tasks view.
    const tasks = createTasksState(client)
    const [ui, setUi] = createStore({
      view: "agents" as "agents" | "tasks",
      status: "loading" as "loading" | "ready" | "error",
      error: undefined as unknown,
      agentID: undefined as string | undefined,
      sessionID: undefined as string | undefined,
      expanded: false,
    })

    const load = () => {
      setUi({ status: "loading", error: undefined })
      return Promise.all([client.providers(), client.agents()])
        .then(([providers, agents]) =>
          Promise.all(agents.map((agent) => client.sessions(agent.id).catch(() => []))).then((sessions) => {
            store.setProviders(providers)
            store.setAgents(agents)
            store.setSessions(sessions.flat())
            setUi("status", "ready")
          }),
        )
        .catch((error: unknown) => setUi({ status: "error", error }))
    }

    const resync = (sessionID: string): Promise<void> =>
      client.session(sessionID).then(
        (detail) => {
          if (store.loadHistory(detail.session, detail.history) === "gap") return resync(sessionID)
        },
        (error: unknown) => store.failHistory(sessionID, errorText(error)),
      )

    // Every project's events: an agent's events carry its own project directory, which may not be the open one.
    const stop = serverSDK().event.listen((event) => {
      const details = event.details as { type?: string; properties?: unknown }
      if (!details.type?.startsWith("agenthq.")) return
      if (details.type === "agenthq.session.event")
        return Option.map(events[details.type](details.properties), (data) => {
          if (store.receive(data.envelope) === "gap") void resync(data.envelope.sessionID)
        })
      if (details.type === "agenthq.session.updated")
        return Option.map(events[details.type](details.properties), (data) => store.upsertSession(data.session))
      if (details.type === "agenthq.agent.updated")
        return Option.map(events[details.type](details.properties), (data) => store.upsertAgent(data.agent))
      if (details.type === "agenthq.agent.removed")
        return Option.map(events[details.type](details.properties), (data) => store.removeAgent(data.id))
      if (details.type === "agenthq.provider.updated")
        return Option.map(events[details.type](details.properties), (data) => store.upsertProvider(data.provider))
      if (details.type === "agenthq.task.updated")
        return Option.map(events[details.type](details.properties), (data) => tasks.upsert(data.task))
      if (details.type === "agenthq.task.removed")
        return Option.map(events[details.type](details.properties), (data) => tasks.remove(data.id))
      if (details.type === "agenthq.message")
        return Option.map(events[details.type](details.properties), (data) => tasks.upsertMessage(data.message))
    })
    onCleanup(stop)
    onCleanup(store.flush)

    void load()
    void tasks.load()

    return {
      directory,
      state: store.state,
      seen: store.seen,
      ui,
      tasks,
      reload: () => {
        void tasks.load()
        return load()
      },
      setView: (view: "agents" | "tasks") => setUi({ view, agentID: undefined, sessionID: undefined }),
      // Opens an agent's workspace on one of its sessions (a task's session, a message's delivery).
      openSession: (agentID: string, sessionID?: string) => setUi({ agentID, sessionID }),
      refreshProviders: () => client.providers().then(store.setProviders),
      selectAgent: (agentID?: string) => setUi({ agentID, sessionID: undefined }),
      selectSession: (sessionID?: string) => setUi("sessionID", sessionID),
      setExpanded: (expanded: boolean) => setUi("expanded", expanded),
      // One history load per session no matter how many views show it; views call this inside a reactive scope.
      watch(sessionID: string) {
        if (store.watch(sessionID)) void resync(sessionID)
        onCleanup(() => store.unwatch(sessionID))
      },
      retry(sessionID: string) {
        if (store.retry(sessionID)) void resync(sessionID)
      },
      createAgent: (draft: AgentDraft) =>
        client.createAgent(draft).then((agent) => {
          store.upsertAgent(agent)
          return agent
        }),
      updateAgent: (agentID: string, draft: Partial<AgentDraft>) =>
        client.updateAgent(agentID, draft).then(store.upsertAgent),
      removeAgent: (agentID: string) =>
        client.removeAgent(agentID).then(() => {
          store.removeAgent(agentID)
          if (ui.agentID === agentID) setUi({ agentID: undefined, sessionID: undefined, expanded: false })
        }),
      startSession: (agentID: string) =>
        client.startSession(agentID).then((session) => {
          store.upsertSession(session)
          setUi({ agentID, sessionID: session.id })
        }),
      send: (sessionID: string, text: string) => client.send(sessionID, text),
      cancel: (sessionID: string) =>
        client.cancel(sessionID).then((session) => {
          if (session) store.upsertSession(session)
        }),
      // Answers exactly the option the user picked; the item resolves only when the server reports it.
      respond(sessionID: string, requestID: string, optionID: string) {
        store.setResponding(sessionID, requestID, optionID)
        return client
          .respond(sessionID, requestID, optionID)
          .catch((error: unknown) => store.setResponding(sessionID, requestID, undefined, errorText(error)))
      },
    }
  },
})
