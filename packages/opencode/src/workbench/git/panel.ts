// spicy: the git panel's operations (status, stage, commit, push, branches, pull requests, commit messages) on the
// instance's repository. Every command runs in the worktree root and every path the user names must stay inside it.
// Push never forces; a branch without an upstream is published only when the user chose --set-upstream. Pull
// requests use the user's own `gh`, and messages only the config's small_model: nothing is picked for the user.
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { which } from "@opencode-ai/core/util/which"
import { LLMEvent } from "@opencode-ai/llm"
import { WorkbenchGit } from "@opencode-ai/schema/workbench-git"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"

export class GitPanelError extends Schema.TaggedErrorClass<GitPanelError>()("WorkbenchGitError", {
  kind: Schema.Literals(["invalid", "conflict", "not_found"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<WorkbenchGit.Status, GitPanelError>
  readonly stage: (paths: readonly string[]) => Effect.Effect<WorkbenchGit.Status, GitPanelError>
  readonly unstage: (paths: readonly string[]) => Effect.Effect<WorkbenchGit.Status, GitPanelError>
  readonly commit: (message: string) => Effect.Effect<WorkbenchGit.Commit, GitPanelError>
  readonly push: (input: { setUpstream?: boolean; remote?: string }) => Effect.Effect<WorkbenchGit.Push, GitPanelError>
  readonly branches: () => Effect.Effect<WorkbenchGit.Branches, GitPanelError>
  readonly create: (input: { name: string; switch?: boolean }) => Effect.Effect<WorkbenchGit.Branches, GitPanelError>
  readonly switch: (name: string) => Effect.Effect<WorkbenchGit.Branches, GitPanelError>
  readonly pullRequest: (input: {
    title?: string
    body?: string
  }) => Effect.Effect<WorkbenchGit.PullRequest, GitPanelError>
  readonly message: () => Effect.Effect<WorkbenchGit.Message, GitPanelError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchGitPanel") {}

const invalid = (message: string) => new GitPanelError({ kind: "invalid", message })
const conflict = (message: string) => new GitPanelError({ kind: "conflict", message })

// Push and gh talk to the network: never wait on a prompt, give up after two minutes.
const QUIET = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
const NETWORK_TIMEOUT = "120 seconds"
// The staged diff the small model reads, at most.
const MAX_DIFF = 60_000

const MESSAGE_AGENT: Agent.Info = {
  name: "git-commit-message",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const proc = yield* AppProcess.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    const root = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return yield* conflict("this project is not a git repository")
      return ctx.worktree
    })

    const run = (cwd: string, args: string[]) => git.run(args, { cwd, env: QUIET })
    const output = (result: Git.Result) =>
      [result.stderr.toString("utf8"), result.text()]
        .map((text) => text.trim())
        .filter(Boolean)
        .join("\n")
    const ok = (result: Git.Result, what: string) =>
      result.exitCode === 0 ? Effect.succeed(result) : Effect.fail(conflict(output(result) || `${what} failed`))
    // A command that reaches the network, with its own timeout.
    const remote = (cwd: string, command: string, args: string[]) =>
      proc
        .run(ChildProcess.make(command, args, { cwd, env: QUIET, extendEnv: true, stdin: "ignore" }), {
          timeout: NETWORK_TIMEOUT,
        })
        .pipe(
          Effect.map((result) => ({
            exitCode: result.exitCode,
            out: result.stdout.toString("utf8").trim(),
            err: result.stderr.toString("utf8").trim(),
          })),
          Effect.catch((error) =>
            Effect.succeed({ exitCode: 1, out: "", err: error instanceof Error ? error.message : String(error) }),
          ),
        )

    // Paths are the panel's own (repository-relative); anything that leaves the worktree is refused before git runs.
    const confine = (cwd: string, paths: readonly string[]) =>
      Effect.gen(function* () {
        if (!paths.length) return yield* invalid("no paths given")
        for (const item of paths) {
          const resolved = path.resolve(cwd, item)
          if (!item || path.isAbsolute(item) || !resolved.startsWith(cwd + path.sep))
            return yield* invalid(`${item} is outside the repository`)
        }
        return paths.map((item) => path.relative(cwd, path.resolve(cwd, item)))
      })

    // Exactly the configured small_model (getModel, not getSmallModel, which would fall back to a provider pick).
    const smallModel = Effect.gen(function* () {
      const small = (yield* config.get()).small_model
      if (!small) return { name: undefined, model: undefined }
      const parsed = Provider.parseModel(small)
      const model = yield* provider
        .getModel(parsed.providerID, parsed.modelID)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      return { name: small, model }
    })
    const generate = smallModel.pipe(
      Effect.map(({ name, model }) => {
        if (!name)
          return { available: false, reason: "set small_model in your opencode config to generate commit messages" }
        if (!model) return { available: false, model: name, reason: `small_model ${name} is not available` }
        return { available: true, model: name }
      }),
    )

    const read = Effect.fnUntraced(function* (cwd: string) {
      const result = yield* run(cwd, ["status", "--porcelain=v2", "-z", "--branch"])
      if (result.exitCode !== 0) return yield* conflict(output(result) || "git status failed")
      const remotes = (yield* run(cwd, ["remote"]))
        .text()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      return { ...parseStatus(result.text()), remotes }
    })
    const status = Effect.fnUntraced(function* (cwd: string) {
      return { ...(yield* read(cwd)), generate: yield* generate } satisfies WorkbenchGit.Status
    })

    const branches = Effect.fnUntraced(function* (cwd: string) {
      const result = yield* run(cwd, [
        "for-each-ref",
        "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)",
        "refs/heads",
      ])
      const list = result
        .text()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, upstream, head] = line.split("\0")
          return { name: name!, ...(upstream ? { upstream } : {}), current: head === "*" }
        })
      return { current: list.find((item) => item.current)?.name, branches: list } satisfies WorkbenchGit.Branches
    })

    const branchName = Effect.fnUntraced(function* (cwd: string, name: string) {
      const trimmed = name.trim()
      const valid =
        !!trimmed &&
        !trimmed.startsWith("-") &&
        (yield* run(cwd, ["check-ref-format", "--branch", trimmed])).exitCode === 0
      if (!valid) return yield* invalid(`${name} is not a valid branch name`)
      return trimmed
    })

    return Service.of({
      status: () => root.pipe(Effect.flatMap(status)),

      stage: Effect.fn("WorkbenchGitPanel.stage")(function* (paths) {
        const cwd = yield* root
        yield* ok(yield* run(cwd, ["add", "--", ...(yield* confine(cwd, paths))]), "git add")
        return yield* status(cwd)
      }),

      unstage: Effect.fn("WorkbenchGitPanel.unstage")(function* (paths) {
        const cwd = yield* root
        const files = yield* confine(cwd, paths)
        // Before the first commit there is nothing to restore from: take the files out of the index instead.
        const args = (yield* git.hasHead(cwd))
          ? ["restore", "--staged", "--", ...files]
          : ["rm", "--cached", "-r", "-q", "--", ...files]
        yield* ok(yield* run(cwd, args), "unstaging")
        return yield* status(cwd)
      }),

      commit: Effect.fn("WorkbenchGitPanel.commit")(function* (message) {
        const cwd = yield* root
        if (!message.trim()) return yield* invalid("the commit message is empty")
        if (!(yield* read(cwd)).staged.length) return yield* conflict("nothing is staged")
        yield* ok(yield* run(cwd, ["commit", "-q", "-m", message]), "git commit")
        const [sha, subject] = (yield* run(cwd, ["log", "-1", "--format=%H%x00%s"])).text().trim().split("\0")
        return { sha: sha ?? "", subject: subject ?? "" }
      }),

      push: Effect.fn("WorkbenchGitPanel.push")(function* (input) {
        const cwd = yield* root
        const current = yield* read(cwd)
        const branch = current.branch
        if (!branch) return yield* conflict("HEAD is detached; switch to a branch to push")
        if (current.upstream) {
          const remoteName = (yield* run(cwd, ["config", `branch.${branch}.remote`])).text().trim()
          const merge = (yield* run(cwd, ["config", `branch.${branch}.merge`])).text().trim()
          if (!remoteName || !merge) return yield* conflict(`${branch} has no upstream to push to`)
          // A remote is a positional argument: one spelled like an option (--force) is never passed.
          if (remoteName.startsWith("-")) return yield* invalid(`${remoteName} is not a remote git can push to`)
          // The branch to its upstream, never forced: a rejected push is reported as git words it.
          const pushed = yield* remote(cwd, "git", ["push", remoteName, `refs/heads/${branch}:${merge}`])
          if (pushed.exitCode !== 0) return yield* conflict(pushed.err || pushed.out || "git push failed")
          return { branch, upstream: current.upstream, output: [pushed.err, pushed.out].filter(Boolean).join("\n") }
        }
        const target = input.remote ?? (current.remotes.includes("origin") ? "origin" : current.remotes[0])
        if (!target) return yield* conflict("this repository has no remote to push to")
        if (!current.remotes.includes(target) || target.startsWith("-"))
          return yield* invalid(`no remote named ${target}`)
        if (!input.setUpstream)
          return yield* conflict(`${branch} has no upstream branch; publish it to ${target} with --set-upstream`)
        const pushed = yield* remote(cwd, "git", [
          "push",
          "--set-upstream",
          target,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ])
        if (pushed.exitCode !== 0) return yield* conflict(pushed.err || pushed.out || "git push failed")
        return { branch, upstream: `${target}/${branch}`, output: [pushed.err, pushed.out].filter(Boolean).join("\n") }
      }),

      branches: () => root.pipe(Effect.flatMap(branches)),

      create: Effect.fn("WorkbenchGitPanel.create")(function* (input) {
        const cwd = yield* root
        const name = yield* branchName(cwd, input.name)
        if ((yield* branches(cwd)).branches.some((item) => item.name === name))
          return yield* conflict(`a branch named ${name} already exists`)
        // A new branch starts at HEAD, so switching to it leaves the working tree as it is.
        yield* ok(
          yield* run(cwd, input.switch ? ["switch", "-q", "-c", name] : ["branch", name]),
          "creating the branch",
        )
        return yield* branches(cwd)
      }),

      switch: Effect.fn("WorkbenchGitPanel.switch")(function* (name) {
        const cwd = yield* root
        const list = yield* branches(cwd)
        if (!list.branches.some((item) => item.name === name))
          return yield* new GitPanelError({ kind: "not_found", message: `no branch named ${name}` })
        if (list.current === name) return list
        const current = yield* read(cwd)
        const dirty = [...current.staged, ...current.unstaged]
        if (dirty.length) {
          const names = [...new Set(dirty.map((item) => item.path))]
          const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "")
          return yield* conflict(
            `${names.length} file(s) have uncommitted changes (${shown}); commit or stash them before switching to ${name}`,
          )
        }
        yield* ok(yield* run(cwd, ["switch", "-q", name]), `switching to ${name}`)
        return yield* branches(cwd)
      }),

      pullRequest: Effect.fn("WorkbenchGitPanel.pullRequest")(function* (input) {
        const cwd = yield* root
        const current = yield* read(cwd)
        if (!current.branch) return yield* conflict("HEAD is detached; switch to a branch first")
        if (!current.remotes.length) return yield* conflict("this repository has no remote for a pull request")
        // gh would ask where to push an unpublished branch; the panel pushes first.
        if (!current.upstream) return yield* conflict(`push ${current.branch} before creating a pull request`)
        const gh = which("gh")
        if (!gh) return yield* conflict("the GitHub CLI (gh) was not found on PATH")
        const title = input.title?.trim()
        const args = title ? ["pr", "create", "--title", title, "--body", input.body ?? ""] : ["pr", "create", "--fill"]
        const created = yield* remote(cwd, gh, args)
        if (created.exitCode !== 0) return yield* conflict(created.err || created.out || "gh pr create failed")
        const url = created.out.match(/https?:\/\/\S+/g)?.at(-1) ?? created.out
        return { url, output: [created.out, created.err].filter(Boolean).join("\n") }
      }),

      message: Effect.fn("WorkbenchGitPanel.message")(function* () {
        const cwd = yield* root
        const { name, model } = yield* smallModel
        if (!name) return yield* conflict("set small_model in your opencode config to generate commit messages")
        if (!model) return yield* conflict(`small_model ${name} is not available`)
        // The model reads at most MAX_DIFF bytes of the staged diff; git's output past that is not even kept.
        const diff = yield* git.run(["diff", "--cached", "--no-color", "--no-ext-diff"], {
          cwd,
          env: QUIET,
          maxOutputBytes: MAX_DIFF,
        })
        if (!diff.text().trim()) return yield* conflict("nothing is staged")
        const stat = (yield* run(cwd, ["diff", "--cached", "--stat", "--no-color"])).text().trim()
        const sessionID = SessionID.descending()
        const text = yield* llm
          .stream({
            agent: MESSAGE_AGENT,
            user: {
              id: MessageID.ascending(),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: MESSAGE_AGENT.name,
              model: { providerID: model.providerID, modelID: model.id },
            },
            system: [],
            small: true,
            tools: {},
            model,
            sessionID,
            retries: 1,
            messages: [{ role: "user", content: prompt(stat, diff.text(), diff.truncated) }],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((event) => event.text),
            Stream.mkString,
            Effect.mapError((error) =>
              conflict(`the model failed: ${error instanceof Error ? error.message : String(error)}`),
            ),
          )
        const message = clean(text)
        if (!message) return yield* conflict("the model returned no message")
        return { message, model: name }
      }),
    })
  }),
)

function prompt(stat: string, diff: string, truncated: boolean) {
  return [
    "Write a git commit message for the staged changes below.",
    "First line: an imperative summary under 72 characters. Add a blank line and a short body only if it helps.",
    "Reply with the commit message only, no quotes or code fences.",
    "",
    stat,
    "",
    diff + (truncated ? "\n[diff truncated]" : ""),
  ].join("\n")
}

/** The model's reply as a commit message: no thinking blocks, fences or surrounding quotes. */
export function clean(text: string) {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/^\s*```[^\n]*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim()
    .replace(/^["'`](.*)["'`]$/s, "$1")
    .trim()
}

/** `git status --porcelain=v2 -z --branch`, split into the panel's lists. */
export function parseStatus(text: string) {
  const status = {
    branch: undefined as string | undefined,
    head: undefined as string | undefined,
    upstream: undefined as string | undefined,
    ahead: 0,
    behind: 0,
    staged: [] as WorkbenchGit.File[],
    unstaged: [] as WorkbenchGit.File[],
    untracked: [] as WorkbenchGit.File[],
  }
  const fields = text.split("\0")
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index]!
    if (!line) continue
    if (line.startsWith("# ")) {
      const [key, ...rest] = line.slice(2).split(" ")
      const value = rest.join(" ")
      if (key === "branch.head" && value !== "(detached)") status.branch = value
      if (key === "branch.oid" && value !== "(initial)") status.head = value
      if (key === "branch.upstream") status.upstream = value
      if (key === "branch.ab") {
        const [ahead, behind] = value.split(" ")
        status.ahead = Math.abs(Number(ahead) || 0)
        status.behind = Math.abs(Number(behind) || 0)
      }
      continue
    }
    const parts = line.split(" ")
    if (line.startsWith("? ")) {
      status.untracked.push({ path: line.slice(2), state: "untracked" })
      continue
    }
    if (line.startsWith("u ")) {
      status.unstaged.push({ path: parts.slice(10).join(" "), state: "conflicted" })
      continue
    }
    const xy = parts[1] ?? ".."
    if (line.startsWith("1 ")) {
      const file = parts.slice(8).join(" ")
      if (xy[0] !== ".") status.staged.push({ path: file, state: STATE[xy[0]!] ?? "modified" })
      if (xy[1] !== ".") status.unstaged.push({ path: file, state: STATE[xy[1]!] ?? "modified" })
      continue
    }
    if (line.startsWith("2 ")) {
      const file = parts.slice(9).join(" ")
      const from = fields[++index]
      if (xy[0] !== ".")
        status.staged.push({ path: file, state: STATE[xy[0]!] ?? "renamed", ...(from ? { from } : {}) })
      if (xy[1] !== ".") status.unstaged.push({ path: file, state: STATE[xy[1]!] ?? "modified" })
    }
  }
  return status
}

const STATE: Record<string, WorkbenchGit.FileState> = {
  M: "modified",
  T: "typechange",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Git.node, AppProcess.node, Config.node, Provider.node, LLM.node],
})

export * as GitPanel from "./panel"
