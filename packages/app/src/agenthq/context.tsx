import { Option, Schema } from "effect"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { createAgentHQStore } from "./store"
import { createWorkbenchClient, errorText, type AgentDraft } from "@/workbench/client"

const events = {
  "agenthq.agent.updated": Schema.decodeUnknownOption(AgentHQ.Event.AgentUpdated.data),
  "agenthq.agent.removed": Schema.decodeUnknownOption(AgentHQ.Event.AgentRemoved.data),
  "agenthq.provider.updated": Schema.decodeUnknownOption(AgentHQ.Event.ProviderUpdated.data),
  "agenthq.session.updated": Schema.decodeUnknownOption(AgentHQ.Event.SessionUpdated.data),
  "agenthq.session.event": Schema.decodeUnknownOption(AgentHQ.Event.SessionEvent.data),
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
    const store = createAgentHQStore()
    const [ui, setUi] = createStore({
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
          if (store.loadHistory(detail.info, detail.history) === "gap") return resync(sessionID)
        },
        (error: unknown) => store.failHistory(sessionID, errorText(error)),
      )

    const stop = sdk().event.listen((event) => {
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
    })
    onCleanup(stop)
    onCleanup(store.flush)

    void load()

    return {
      directory,
      state: store.state,
      ui,
      reload: load,
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
