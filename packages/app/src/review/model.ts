// Agent changes review (spicy-review): client state for the server's review changesets plus the pure helpers the
// views share. Contract and routes: packages/schema/src/review.ts, docs/spicy/notes-review.md.
import { Option, Schema } from "effect"
import { createStore, produce, reconcile } from "solid-js/store"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Review } from "@opencode-ai/schema/review"
import { errorText, WorkbenchRequestError, type WorkbenchClient } from "@/workbench/client"

export type ReviewApi = Pick<WorkbenchClient, "changesets" | "decideHunk" | "decideFile" | "decideAll" | "undo">

// Why the server refused a decision (409 bodies in notes-review.md). Unknown reasons show the server's own text.
export type ConflictReason =
  | "editedSince"
  | "agentEditing"
  | "changedWhileReviewing"
  | "nothingToUndo"
  | "changedSinceReject"
  | "partial"

export type Notice = { reason?: ConflictReason; message: string }

// One row per path: the changeset that has it pending, else the one that decided it last.
export type Entry = { changeset: Review.ChangeSet; file: Review.File }

const decode = {
  updated: Schema.decodeUnknownOption(Review.Event.ChangeSetUpdated.data),
  removed: Schema.decodeUnknownOption(Review.Event.ChangeSetRemoved.data),
}

export function createReviewState(api: ReviewApi) {
  const [state, setState] = createStore({
    status: "loading" as "loading" | "ready" | "unavailable" | "failed",
    error: undefined as string | undefined,
    changesets: {} as Record<string, Review.ChangeSet>,
    busy: {} as Record<string, boolean>,
    notices: {} as Record<string, Notice>,
  })

  // Never two list requests at once; one asked for meanwhile runs right after, so no update is missed.
  let loading: Promise<void> | undefined
  let again = false
  const refresh = (): Promise<void> => {
    if (loading) {
      again = true
      return loading
    }
    loading = api
      .changesets()
      .then(
        (list) => {
          setState("changesets", reconcile(Object.fromEntries(list.map((item) => [item.id, item]))))
          setState({ status: "ready", error: undefined })
        },
        (error) =>
          setState({
            status: error instanceof WorkbenchRequestError && error.kind === "unavailable" ? "unavailable" : "failed",
            error: errorText(error),
          }),
      )
      .finally(() => {
        loading = undefined
        if (!again) return
        again = false
        void refresh()
      })
    return loading
  }

  // A reply and the matching event carry the same changeset; an older copy (a late event) never wins.
  const upsert = (changeset: Review.ChangeSet) => {
    const current = state.changesets[changeset.id]
    if (current && current.updatedAt > changeset.updatedAt) return
    setState("changesets", changeset.id, reconcile(changeset))
  }

  const remove = (id: string) =>
    setState(
      "changesets",
      produce((draft) => {
        delete draft[id]
      }),
    )

  const clear = (record: "busy" | "notices", key: string) =>
    setState(
      record,
      produce((draft) => {
        delete draft[key]
      }),
    )

  // One decision per file (or per changeset for "all") at a time. A 409 means the server state moved on (the human
  // edited the lines, the agent is mid-turn, the file changed): explain it and reload what is there now.
  const act = async (key: string, run: () => Promise<Review.ChangeSet>) => {
    if (state.busy[key]) return
    setState("busy", key, true)
    clear("notices", key)
    await run()
      .then(upsert, (error) => {
        const conflict = error instanceof WorkbenchRequestError && error.status === 409
        setState("notices", key, {
          ...(conflict ? { reason: conflictReason(errorText(error)) } : {}),
          message: errorText(error),
        })
        if (conflict) return refresh()
      })
      .finally(() => clear("busy", key))
  }

  return {
    state,
    refresh,
    event(type: string | undefined, properties: unknown) {
      if (type === Review.Event.ChangeSetUpdated.type)
        Option.map(decode.updated(properties), (data) => upsert(data.changeset))
      if (type === Review.Event.ChangeSetRemoved.type) Option.map(decode.removed(properties), (data) => remove(data.id))
    },
    decideHunk: (id: string, path: string, hunkID: string, action: Review.Action) =>
      act(fileKey(id, path), () => api.decideHunk(id, hunkID, action)),
    decideFile: (id: string, path: string, action: Review.Action) =>
      act(fileKey(id, path), () => api.decideFile(id, path, action)),
    decideAll: (id: string, action: Review.Action) => act(allKey(id), () => api.decideAll(id, action)),
    undo: (id: string, path: string) => act(fileKey(id, path), () => api.undo(id, path)),
    busy: (id: string, path?: string) =>
      !!state.busy[allKey(id)] || (path !== undefined && !!state.busy[fileKey(id, path)]),
    notice: (id: string, path?: string) => state.notices[path === undefined ? allKey(id) : fileKey(id, path)],
    dismiss: (id: string, path?: string) => clear("notices", path === undefined ? allKey(id) : fileKey(id, path)),
  }
}

export type ReviewState = ReturnType<typeof createReviewState>

const fileKey = (id: string, path: string) => `${id}\n${path}`
const allKey = (id: string) => `${id}\n*`

export function conflictReason(message: string): ConflictReason | undefined {
  if (message === "agent is still editing") return "agentEditing"
  if (message.startsWith("hunk ") && message.includes("no longer matches")) return "editedSince"
  if (message === "the file changed while it was being reviewed") return "changedWhileReviewing"
  if (message === "nothing to undo") return "nothingToUndo"
  if (message === "the file changed since the reject") return "changedSinceReject"
  if (/could not be (accepted|rejected)/.test(message)) return "partial"
}

export function sortChangesets(changesets: Record<string, Review.ChangeSet>) {
  return Object.values(changesets).toSorted((a, b) => b.updatedAt - a.updatedAt)
}

export function entries(changesets: readonly Review.ChangeSet[]) {
  const byPath = new Map<string, Entry>()
  for (const changeset of changesets)
    for (const file of changeset.files) {
      const current = byPath.get(file.path)
      if (!current || (!current.file.hunks.length && file.hunks.length)) byPath.set(file.path, { changeset, file })
    }
  return [...byPath.values()]
}

// The next (or previous) path with pending hunks after `current`, wrapping around.
export function step(paths: readonly string[], current: string | undefined, direction: 1 | -1) {
  if (!paths.length) return
  const index = current === undefined ? -1 : paths.indexOf(current)
  if (index < 0) return direction === 1 ? paths[0] : paths[paths.length - 1]
  return paths[(index + direction + paths.length) % paths.length]
}

// The Agent HQ identity behind a changeset: its own agentID (external providers), or the Agent HQ session that drives
// the opencode session it belongs to. Plain OpenCode sessions have none.
export function agentFor(
  changeset: Review.ChangeSet,
  agents: readonly AgentHQ.AgentIdentity[],
  sessions: Record<string, AgentHQ.AgentSessionInfo>,
) {
  const id =
    changeset.agentID ??
    Object.values(sessions).find((session) => session.providerSessionID === changeset.owner.id)?.agentID
  return id ? agents.find((agent) => agent.id === id) : undefined
}

// Where a hunk's actions sit in the diff: under its last added line, else under its last removed line.
export function anchor(hunk: Review.Hunk) {
  if (hunk.newLines > 0) return { side: "additions" as const, lineNumber: hunk.newStart + hunk.newLines - 1 }
  return { side: "deletions" as const, lineNumber: Math.max(1, hunk.oldStart + hunk.oldLines - 1) }
}
