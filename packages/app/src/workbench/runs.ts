import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchRequestError, type CheckInput, type WorkbenchClient } from "./client"

export type RunEntry = {
  info: Workbench.RunInfo
  output: string
  // Seen starting in this view, so its streamed chunks are complete from seq 0.
  live: boolean
  next: number
  gap: boolean
  detail: "none" | "loading" | "loaded" | "failed"
  // The server's copy hit its output cap.
  truncated?: boolean
}

const MAX_RUNS = 100
// Matches the server's 1 MB stream cap; the newest output is kept.
const MAX_OUTPUT = 1_000_000

export const isFinished = (status: Workbench.RunStatus) => status !== "queued" && status !== "running"

// Output the stream cannot provide: runs that started before this view, or a live run that missed a chunk.
export const needsDetail = (entry: RunEntry) => !entry.live || (entry.gap && isFinished(entry.info.status))

// Check/test runs from workbench.run.* events, with history and full output from the runs routes when they exist.
export function createRunsState(client: Pick<WorkbenchClient, "runs" | "run" | "check">) {
  const [state, setState] = createStore({
    runs: [] as RunEntry[],
    history: "idle" as "idle" | "loading" | "ready" | "unavailable" | "failed",
    checking: false,
    report: undefined as Workbench.VerificationReport | undefined,
    // A run another view asked to show (an investigation's evidence); the Output tab opens and scrolls to it.
    focus: undefined as string | undefined,
  })
  const find = (id: string) => state.runs.findIndex((entry) => entry.info.id === id)

  function update(run: Workbench.RunInfo) {
    const at = find(run.id)
    if (at === -1) {
      const entry: RunEntry = {
        info: run,
        output: "",
        live: !isFinished(run.status),
        next: 0,
        gap: false,
        detail: "none",
      }
      return setState("runs", (runs) => [entry, ...runs].slice(0, MAX_RUNS))
    }
    const previous = state.runs[at]!
    batch(() => {
      setState("runs", at, "info", reconcile(run))
      // Finishing makes the server's copy final; fetch it again when the stream could not provide everything.
      if (isFinished(run.status) && !isFinished(previous.info.status) && needsDetail(state.runs[at]!))
        setState("runs", at, "detail", "none")
    })
  }

  function output(event: { runID: string; seq: number; chunk: string }) {
    const at = find(event.runID)
    const entry = state.runs[at]
    if (!entry?.live || event.seq < entry.next) return
    setState(
      "runs",
      at,
      produce((draft) => {
        if (event.seq > draft.next) draft.gap = true
        draft.next = event.seq + 1
        draft.output = (draft.output + event.chunk).slice(-MAX_OUTPUT)
      }),
    )
  }

  function load() {
    if (state.history !== "idle" && state.history !== "failed") return Promise.resolve()
    setState("history", "loading")
    return client.runs().then(
      (list) =>
        setState(
          produce((draft) => {
            const known = new Set(draft.runs.map((entry) => entry.info.id))
            const older = list
              .filter((run) => !known.has(run.id))
              .toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
              .map((run): RunEntry => ({ info: run, output: "", live: false, next: 0, gap: false, detail: "none" }))
            draft.runs = [...draft.runs, ...older].slice(0, MAX_RUNS)
            draft.history = "ready"
          }),
        ),
      (error: unknown) => setState("history", unavailable(error) ? "unavailable" : "failed"),
    )
  }

  function detail(id: string) {
    const entry = state.runs[find(id)]
    if (!entry || entry.detail === "loading" || state.history === "unavailable") return Promise.resolve()
    setState("runs", find(id), "detail", "loading")
    return client.run(id).then(
      (result) => {
        const at = find(id)
        if (at !== -1)
          setState("runs", at, {
            info: result.run,
            output: result.output,
            truncated: result.truncated,
            gap: false,
            detail: "loaded",
          })
      },
      (error: unknown) => {
        const at = find(id)
        if (at !== -1) setState("runs", at, "detail", "failed")
        if (unavailable(error)) setState("history", "unavailable")
      },
    )
  }

  // Rejects with the request error so the caller can report it; runs themselves arrive as events.
  function check(input?: CheckInput) {
    if (state.checking) return Promise.resolve()
    setState("checking", true)
    return client
      .check(input)
      .then((report) => setState("report", report))
      .finally(() => setState("checking", false))
  }

  return { state, update, output, load, detail, check, focus: (id: string) => setState("focus", id) }
}

function unavailable(error: unknown) {
  return error instanceof WorkbenchRequestError && error.kind === "unavailable"
}
