import { describe, expect, test } from "bun:test"
import type { WorkbenchGit } from "@opencode-ai/schema/workbench-git"
import { WorkbenchRequestError } from "./client"
import { canCommit, changes, createGitState } from "./git"

const status = (patch: Partial<WorkbenchGit.Status> = {}): WorkbenchGit.Status => ({
  branch: "main",
  ahead: 0,
  behind: 0,
  remotes: [],
  staged: [],
  unstaged: [],
  untracked: [],
  generate: { available: false, reason: "set small_model" },
  ...patch,
})

function setup(initial = status()) {
  const calls: string[] = []
  const server = { status: initial, fail: undefined as Error | undefined, gate: undefined as Promise<void> | undefined }
  const refuse = () => {
    if (server.fail) throw server.fail
  }
  const client = {
    gitStatus: async () => {
      calls.push("status")
      refuse()
      const value = server.status
      if (server.gate) await server.gate
      return value
    },
    gitStage: async (paths: string[]) => {
      calls.push(`stage ${paths.join(",")}`)
      return status({ staged: paths.map((path) => ({ path, state: "added" as const })) })
    },
    gitUnstage: async (paths: string[]) => {
      calls.push(`unstage ${paths.join(",")}`)
      return status({ untracked: paths.map((path) => ({ path, state: "untracked" as const })) })
    },
    gitCommit: async (message: string) => {
      calls.push(`commit ${message}`)
      refuse()
      return { sha: "abc", subject: message }
    },
    gitPush: async (input: { setUpstream?: boolean } = {}) => {
      calls.push(`push ${input.setUpstream ? "--set-upstream" : ""}`.trim())
      refuse()
      return { branch: "main", upstream: "origin/main", output: "" }
    },
    gitBranches: async () => ({ current: "main", branches: [{ name: "main", current: true }] }),
    gitCreateBranch: async (name: string) => ({ current: name, branches: [] }),
    gitSwitch: async (name: string) => {
      calls.push(`switch ${name}`)
      refuse()
      return { current: name, branches: [] }
    },
    gitPullRequest: async () => ({ url: "https://example.test/pr/1", output: "" }),
    gitMessage: async () => ({ message: "Add a.txt", model: "test/small" }),
  }
  return { git: createGitState(client), calls, server }
}

describe("git panel state", () => {
  test("the Changes list and when Commit is allowed", () => {
    const current = status({
      staged: [{ path: "a.txt", state: "added" }],
      unstaged: [{ path: "b.txt", state: "modified" }],
      untracked: [{ path: "c.txt", state: "untracked" }],
    })
    expect(changes(current).map((file) => file.path)).toEqual(["b.txt", "c.txt"])
    expect(canCommit(current, "Add a")).toBe(true)
    expect(canCommit(current, "  ")).toBe(false)
    expect(canCommit(status(), "Add a")).toBe(false)
    expect(canCommit(undefined, "Add a")).toBe(false)
  })

  test("a project that is not a git repository (409) or a server without the routes hides the area", async () => {
    const { git, server } = setup()
    await git.refresh()
    expect(git.state.load).toBe("ready")
    server.fail = new WorkbenchRequestError("failed", "this project is not a git repository", 409)
    await git.refresh()
    expect(git.state.load).toBe("missing")
    expect(git.state.status).toBeUndefined()
    server.fail = new WorkbenchRequestError("unavailable", "404", 404)
    await git.refresh()
    expect(git.state.load).toBe("missing")
    server.fail = new WorkbenchRequestError("failed", "boom", 500)
    server.status = status()
    await git.refresh()
    expect(git.state.error).toBe("boom")
  })

  test("staging applies the reply; commit clears the message only when it lands", async () => {
    const { git, calls, server } = setup()
    await git.stage(["a.txt"])
    expect(git.state.status?.staged).toEqual([{ path: "a.txt", state: "added" }])
    git.setMessage("Add a.txt")
    server.fail = new WorkbenchRequestError("failed", "nothing is staged", 409)
    expect(await git.commit()).toBeUndefined()
    expect([git.state.message, git.state.error, git.state.busy]).toEqual(["Add a.txt", "nothing is staged", undefined])
    server.fail = undefined
    expect(await git.commit()).toEqual({ sha: "abc", subject: "Add a.txt" })
    expect([git.state.message, git.state.error]).toEqual(["", undefined])
    expect(calls).toEqual(["stage a.txt", "commit Add a.txt", "commit Add a.txt", "status"])
  })

  test("one action at a time; a rejected push keeps git's reason", async () => {
    const { git, calls, server } = setup()
    server.fail = new WorkbenchRequestError("failed", "! [rejected] main -> main (fetch first)", 409)
    const first = git.push()
    expect(git.state.busy).toBe("push")
    expect(await git.switchBranch("feature")).toBeUndefined() // ignored while the push runs
    await first
    expect(git.state.error).toContain("fetch first")
    expect(calls).toEqual(["push"])
    server.fail = undefined
    await git.push({ setUpstream: true })
    expect(calls).toEqual(["push", "push --set-upstream", "status"])
  })

  test("Generate fills the message box", async () => {
    const { git } = setup()
    git.setMessage("draft")
    await git.generate()
    expect(git.state.message).toBe("Add a.txt")
  })

  test("an older status reply never overwrites a newer one", async () => {
    const { git, server } = setup(status({ branch: "old" }))
    let release = () => {}
    server.gate = new Promise((resolve) => (release = resolve))
    const slow = git.refresh()
    server.gate = undefined
    server.status = status({ branch: "new" })
    await git.refresh()
    release()
    await slow
    expect(git.state.status?.branch).toBe("new")
  })
})
