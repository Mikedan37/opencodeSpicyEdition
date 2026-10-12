import { batch, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { errorText, WorkbenchRequestError, type WorkbenchClient } from "./client"

type Summary = Workbench.InvestigationSummary

// Where the routes accept Resume, and the statuses an investigation ends in (Cancel is offered before that).
export const RESUMABLE: ReadonlySet<Workbench.InvestigationStatus> = new Set(["interrupted", "needs_human", "blocked"])
export const ENDED: ReadonlySet<Workbench.InvestigationStatus> = new Set(["resolved", "failed", "cancelled"])
// Statuses that wait for the user; the Activity tab counts them.
export const WAITING: ReadonlySet<Workbench.InvestigationStatus> = new Set(["needs_human", "blocked", "interrupted"])

export type DetailState = {
  status: "loading" | "ready" | "failed"
  detail?: Workbench.InvestigationDetail
  error?: string
  // A newer summary arrived; the open view loads the record again.
  stale?: boolean
}

type Client = Pick<WorkbenchClient, "investigations" | "investigation" | "resumeInvestigation" | "cancelInvestigation">

// Investigations of this project from workbench.investigation.updated plus the routes; the full record (evidence,
// checkpoints, report) loads per investigation when it is shown.
export function createInvestigationsState(client: Client) {
  const [state, setState] = createStore({
    list: [] as Summary[],
    status: "idle" as "idle" | "loading" | "ready" | "unavailable" | "failed",
    error: undefined as string | undefined,
    details: {} as Record<string, DetailState>,
    busy: {} as Record<string, string | undefined>,
  })
  const find = (id: string | undefined) => (id ? state.list.find((item) => item.id === id) : undefined)

  function update(summary: Summary) {
    const index = state.list.findIndex((item) => item.id === summary.id)
    batch(() => {
      if (index === -1) setState("list", (list) => [summary, ...list].toSorted((a, b) => b.updatedAt - a.updatedAt))
      else {
        // A route reply can be older than an event that already arrived.
        if (state.list[index]!.updatedAt > summary.updatedAt) return
        setState("list", index, reconcile(summary))
      }
      if (state.details[summary.id]?.status === "ready") setState("details", summary.id, "stale", true)
    })
  }

  function load() {
    if (state.status === "loading") return Promise.resolve()
    setState({ status: "loading", error: undefined })
    return client.investigations().then(
      (list) =>
        batch(() => {
          for (const summary of list) update(summary)
          setState("status", "ready")
        }),
      (error: unknown) =>
        setState({
          status: error instanceof WorkbenchRequestError && error.kind === "unavailable" ? "unavailable" : "failed",
          error: errorText(error),
        }),
    )
  }

  // Loads the full record unless it is loading or current; read untracked so a calling effect does not retry.
  const detail = (id: string) =>
    untrack(() => {
      const current = state.details[id]
      if (current?.status === "loading" || (current?.status === "ready" && !current.stale)) return Promise.resolve()
      setState("details", id, { status: "loading", error: undefined, stale: false, detail: current?.detail })
      return client.investigation(id).then(
        (result) => setState("details", id, { status: "ready", detail: result, stale: false }),
        (error: unknown) => setState("details", id, { status: "failed", error: errorText(error) }),
      )
    })

  function act(id: string, name: "resume" | "cancel", request: () => Promise<Summary>) {
    if (state.busy[id]) return Promise.resolve(undefined)
    setState("busy", id, name)
    return request()
      .then((summary) => {
        update(summary)
        return summary
      })
      .finally(() => setState("busy", id, undefined))
  }

  return {
    state,
    find,
    update,
    load,
    detail,
    // Resume relaunches the stored reproduction (the server asks before running anything that needs approval).
    resume: (id: string) => act(id, "resume", () => client.resumeInvestigation(id)),
    cancel: (id: string) => act(id, "cancel", () => client.cancelInvestigation(id)),
    waiting: () => state.list.filter((item) => WAITING.has(item.status)).length,
  }
}

export type InvestigationsState = ReturnType<typeof createInvestigationsState>
