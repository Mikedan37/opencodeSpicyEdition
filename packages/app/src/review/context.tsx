// Agent changes review (spicy-review): per-workspace state shared by the review panel ("Agent changes" mode) and
// the file view's inline diff. HTTP goes through workbench/client.ts; changesets follow review.changeset.* events.
import { createMemo, createSignal, getOwner, lazy, onCleanup, runWithOwner, Show, Suspense, type JSX } from "solid-js"
import type { Review } from "@opencode-ai/schema/review"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useAgentHQ } from "@/agenthq/context"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import type { ReviewPanelV2Props } from "@/pages/session/v2/review-panel-v2"
import { createWorkbenchClient } from "@/workbench/client"
import { agentFor, createReviewState, entries, sortChangesets, type Entry, type Notice } from "./model"

const ReviewFile = lazy(() => import("./view").then((module) => ({ default: module.ReviewFile })))
const ChangesPanel = lazy(() => import("./view").then((module) => ({ default: module.ReviewChangesPanel })))

// The review panel's "Agent changes" mode (lazy).
export function ReviewChangesPanel(props: ReviewPanelV2Props) {
  return (
    <Suspense>
      <ChangesPanel {...props} />
    </Suspense>
  )
}

export type Focus = { path: string; hunkID?: string }

export const { use: useReview, provider: ReviewProvider } = createSimpleContext({
  name: "Review",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const platform = usePlatform()
    const language = useLanguage()
    const command = useCommand()
    const layout = useLayout()
    const sync = useSync()
    const agenthq = useAgentHQ()
    const { sessionKey } = useSessionKey()
    const owner = getOwner()
    // The session page remounts this provider per workspace, so the directory is fixed for its lifetime.
    const directory = sdk().directory
    const client = createWorkbenchClient({ server: serverSDK().server.http, directory, fetch: platform.fetch })
    const review = createReviewState(client)
    void review.refresh()
    const stop = sdk().event.listen((event) => {
      const details = event.details as { type?: string; properties?: unknown }
      if (details.type?.startsWith("review.changeset.")) review.event(details.type, details.properties)
    })
    onCleanup(stop)

    // Review paths are relative to the worktree; the app's file paths are relative to the open directory.
    const worktree = () => (sync().project?.worktree ?? directory).replace(/\/+$/, "")
    const local = (path: string) => {
      const root = worktree()
      if (root === directory) return path
      const absolute = `${root}/${path}`
      return absolute.startsWith(`${directory}/`) ? absolute.slice(directory.length + 1) : absolute
    }

    const list = createMemo(() => sortChangesets(review.state.changesets))
    const rows = createMemo(() => entries(list()).map((entry) => ({ ...entry, local: local(entry.file.path) })))
    const byLocal = createMemo(() => new Map(rows().map((row) => [row.local, row])))
    const pending = createMemo(() => rows().filter((row) => row.file.hunks.length > 0))
    const [focus, setFocus] = createSignal<Focus>()

    // Every pending hunk in display order, for next / previous across files.
    const stops = createMemo(() =>
      pending().flatMap((row) => row.file.hunks.map((hunk) => ({ path: row.local, hunkID: hunk.id }))),
    )
    const move = (direction: 1 | -1) => {
      const all = stops()
      if (!all.length) return
      const current = focus()
      const index = current ? all.findIndex((item) => item.path === current.path && item.hunkID === current.hunkID) : -1
      if (index >= 0) return setFocus(all[(index + direction + all.length) % all.length])
      // The focused hunk is gone (decided): continue in its file, else from the start or the end.
      setFocus(all.find((item) => item.path === current?.path) ?? (direction === 1 ? all[0] : all[all.length - 1]))
    }

    // The hunk the keyboard acts on; none once its file has nothing pending.
    const focused = () => {
      const current = focus()
      const row = current && byLocal().get(current.path)
      const hunk = row && (row.file.hunks.find((item) => item.id === current.hunkID) ?? row.file.hunks[0])
      if (!row || !hunk) return
      return { row, hunk }
    }

    const agent = (changeset: Review.ChangeSet) => agentFor(changeset, agenthq.state.agents, agenthq.state.sessions)
    const title = (changeset: Review.ChangeSet) =>
      changeset.owner.kind === "opencode-session" ? sync().session.get(changeset.owner.id)?.title : undefined

    const explain = (notice: Notice) => {
      if (notice.reason === "editedSince") return language.t("review.conflict.editedSince")
      if (notice.reason === "agentEditing") return language.t("review.conflict.agentEditing")
      if (notice.reason === "changedWhileReviewing") return language.t("review.conflict.changedWhileReviewing")
      if (notice.reason === "nothingToUndo") return language.t("review.conflict.nothingToUndo")
      if (notice.reason === "changedSinceReject") return language.t("review.conflict.changedSinceReject")
      if (notice.reason === "partial") return language.t("review.conflict.partial", { message: notice.message })
      return language.t("review.error.failed", { message: notice.message })
    }

    const show = () =>
      runWithOwner(owner, () => {
        const view = layout.view(sessionKey())
        view.review.setMode("agent")
        view.reviewPanel.open()
      })

    const current = (run: (input: NonNullable<ReturnType<typeof focused>>) => void) => () => {
      const value = focused()
      if (value) run(value)
    }
    command.register("review", () => {
      const category = language.t("review.command.category")
      return [
        { id: "review.show", title: language.t("review.command.show"), category, onSelect: show },
        {
          id: "review.next",
          title: language.t("review.command.next"),
          category,
          keybind: "alt+f5",
          disabled: !stops().length,
          onSelect: () => move(1),
        },
        {
          id: "review.previous",
          title: language.t("review.command.previous"),
          category,
          keybind: "shift+alt+f5",
          disabled: !stops().length,
          onSelect: () => move(-1),
        },
        {
          id: "review.hunk.accept",
          title: language.t("review.command.acceptHunk"),
          category,
          keybind: "mod+shift+y",
          disabled: !focused(),
          onSelect: current((value) =>
            review.decideHunk(value.row.changeset.id, value.row.file.path, value.hunk.id, "accept"),
          ),
        },
        {
          id: "review.hunk.reject",
          title: language.t("review.command.rejectHunk"),
          category,
          keybind: "mod+shift+k",
          disabled: !focused(),
          onSelect: current((value) =>
            review.decideHunk(value.row.changeset.id, value.row.file.path, value.hunk.id, "reject"),
          ),
        },
        {
          id: "review.file.accept",
          title: language.t("review.command.acceptFile"),
          category,
          disabled: !focused(),
          onSelect: current((value) => review.decideFile(value.row.changeset.id, value.row.file.path, "accept")),
        },
        {
          id: "review.file.reject",
          title: language.t("review.command.rejectFile"),
          category,
          disabled: !focused(),
          onSelect: current((value) => review.decideFile(value.row.changeset.id, value.row.file.path, "reject")),
        },
      ]
    })

    return {
      ...review,
      directory,
      list,
      rows,
      pending,
      // The review panel's file list in "Agent changes" mode (pending lines per file).
      diffs: createMemo(() =>
        rows().map((row) => ({
          file: row.local,
          additions: row.file.additions,
          deletions: row.file.deletions,
          status: row.file.status,
        })),
      ),
      entry: (path: string): (Entry & { local: string }) | undefined => byLocal().get(path),
      focus,
      setFocus,
      agent,
      title,
      explain,
      show,
      // Both sides of a changed file with the hunks of the same read (the review route; /file/content trims text).
      content: (id: string, path: string) => client.content(id, path),
    }
  },
})

// spicy-review seam for the file view: a file with pending agent changes renders as an inline diff with Accept and
// Reject (lazy, so files without changes pay nothing); every other file renders exactly as before.
export function ReviewFileGate(props: { path?: string; contents: string; tab: string; children: JSX.Element }) {
  const review = useReview()
  const pending = createMemo(() => !!props.path && !!review.entry(props.path)?.file.hunks.length)
  return (
    <Show when={pending()} fallback={props.children}>
      <Suspense fallback={props.children}>
        <ReviewFile path={props.path!} contents={props.contents} tab={props.tab} />
      </Suspense>
    </Show>
  )
}
