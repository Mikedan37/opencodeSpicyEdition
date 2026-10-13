// The Files Changed panel's commit area (git-panel.tsx): status, staging, commit, push, branches and pull requests
// through /workbench/git (client.ts). One action runs at a time, and a refusal keeps the server's words for the UI.
import { createStore } from "solid-js/store"
import type { WorkbenchGit } from "@opencode-ai/schema/workbench-git"
import { errorText, WorkbenchRequestError, type WorkbenchClient } from "./client"

type Client = Pick<
  WorkbenchClient,
  | "gitStatus"
  | "gitStage"
  | "gitUnstage"
  | "gitCommit"
  | "gitPush"
  | "gitBranches"
  | "gitCreateBranch"
  | "gitSwitch"
  | "gitPullRequest"
  | "gitMessage"
>

export type GitAction = "stage" | "commit" | "push" | "branch" | "pr" | "generate"

/** The "Changes" list: tracked changes not staged (and conflicts), then untracked files. */
export const changes = (status: WorkbenchGit.Status) => [...status.unstaged, ...status.untracked]

export const canCommit = (status: WorkbenchGit.Status | undefined, message: string) =>
  !!status && status.staged.length > 0 && !!message.trim()

/** One letter per state, as git's short status shows it. */
export const STATE_LETTER: Record<WorkbenchGit.FileState, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
}

export function createGitState(client: Client) {
  const [state, setState] = createStore({
    status: undefined as WorkbenchGit.Status | undefined,
    // "missing": not a git repository, or a server without the git routes; the commit area stays hidden.
    load: "idle" as "idle" | "ready" | "missing",
    message: "",
    busy: undefined as GitAction | undefined,
    error: undefined as string | undefined,
  })

  // A status that arrives after a newer one (an action's reply, a later refresh) is dropped.
  let latest = 0
  const apply = (status: WorkbenchGit.Status) => {
    latest++
    setState({ status, load: "ready" })
  }
  async function refresh() {
    const ticket = ++latest
    const result = await client.gitStatus().then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    )
    if (ticket !== latest) return
    if ("status" in result) return setState({ status: result.status, load: "ready" })
    const missing =
      result.error instanceof WorkbenchRequestError &&
      (result.error.kind === "unavailable" || result.error.status === 409)
    if (missing) return setState({ status: undefined, load: "missing" })
    setState("error", errorText(result.error))
  }

  // Runs one action; while it runs the others are ignored (their buttons are disabled too). Failures land in `error`.
  async function act<T>(action: GitAction, run: () => Promise<T>): Promise<T | undefined> {
    if (state.busy) return
    setState({ busy: action, error: undefined })
    try {
      return await run()
    } catch (error) {
      setState("error", errorText(error))
      return
    } finally {
      setState("busy", undefined)
    }
  }
  const then = <T>(value: T) => refresh().then(() => value)

  return {
    state,
    refresh,
    setMessage: (message: string) => setState("message", message),
    clearError: () => setState("error", undefined),
    stage: (paths: string[]) => act("stage", () => client.gitStage(paths).then(apply)),
    unstage: (paths: string[]) => act("stage", () => client.gitUnstage(paths).then(apply)),
    commit: () =>
      act("commit", async () => {
        const commit = await client.gitCommit(state.message)
        setState("message", "")
        return then(commit)
      }),
    generate: () =>
      act("generate", async () => {
        const result = await client.gitMessage()
        setState("message", result.message)
        return result
      }),
    push: (input: { setUpstream?: boolean; remote?: string } = {}) =>
      act("push", () => client.gitPush(input).then(then)),
    pullRequest: (input: { title?: string; body?: string } = {}) => act("pr", () => client.gitPullRequest(input)),
    branches: () => client.gitBranches(),
    createBranch: (name: string, switchTo: boolean) =>
      act("branch", () => client.gitCreateBranch(name, switchTo).then(then)),
    switchBranch: (name: string) => act("branch", () => client.gitSwitch(name).then(then)),
  }
}

export type GitState = ReturnType<typeof createGitState>
