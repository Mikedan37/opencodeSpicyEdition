// Spicy git panel route scenarios. Each runs in a fresh git project; the push remote is a bare repository kept inside
// .git (gone with the project), and the pull request scenario stops before gh because the project has no remote.
import { Effect } from "effect"
import path from "path"
import { array, check, object } from "./assertions"
import { http } from "./dsl"
import type { Scenario, ScenarioContext } from "./types"

const git = (directory: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

// A project with a.txt on disk; `setup` runs git in it before the request.
const project = (ctx: ScenarioContext, setup: (directory: string) => void = () => {}) =>
  Effect.gen(function* () {
    if (!ctx.directory) throw new Error("git scenarios need a project directory")
    yield* ctx.file("a.txt", "one\n")
    setup(ctx.directory)
    return { directory: ctx.directory, branch: git(ctx.directory, ["branch", "--show-current"]) }
  })
const committed = (directory: string) => {
  git(directory, ["add", "a.txt"])
  git(directory, ["commit", "-q", "-m", "Add a.txt"])
}

const paths = (list: unknown) => {
  array(list)
  return list.map((item) => (item as { path?: unknown }).path)
}
const post = (route: string, body: unknown) => (ctx: ScenarioContext) => ({ path: route, headers: ctx.headers(), body })

export const workbenchGitScenarios: Scenario[] = [
  http.protected
    .get("/workbench/git/status", "workbench.git.status")
    .seeded((ctx) => project(ctx))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.branch === ctx.state.branch, "names the current branch")
        check(paths(body.untracked).includes("a.txt"), "lists the untracked file")
        object(body.generate)
        check(body.generate.available === false, "generate is off without a small_model")
      },
      "status",
    ),
  http.protected
    .post("/workbench/git/stage", "workbench.git.stage")
    .mutating()
    .seeded((ctx) => project(ctx))
    .at(post("/workbench/git/stage", { paths: ["a.txt"] }))
    .json(
      200,
      (body) => {
        object(body)
        check(paths(body.staged).includes("a.txt"), "a.txt is staged")
      },
      "status",
    ),
  http.protected
    .post("/workbench/git/unstage", "workbench.git.unstage")
    .mutating()
    .seeded((ctx) => project(ctx, (directory) => git(directory, ["add", "a.txt"])))
    .at(post("/workbench/git/unstage", { paths: ["a.txt"] }))
    .json(
      200,
      (body) => {
        object(body)
        check(paths(body.staged).length === 0, "nothing stays staged")
        check(paths(body.untracked).includes("a.txt"), "a.txt is untracked again")
      },
      "status",
    ),
  http.protected
    .post("/workbench/git/commit", "workbench.git.commit")
    .mutating()
    .seeded((ctx) => project(ctx, (directory) => git(directory, ["add", "a.txt"])))
    .at(post("/workbench/git/commit", { message: "Add a.txt" }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.sync(() => {
          object(body)
          check(body.subject === "Add a.txt", "returns the subject")
          check(body.sha === git(ctx.state.directory, ["rev-parse", "HEAD"]), "returns the new HEAD")
        }),
      "status",
    ),
  http.protected
    .post("/workbench/git/push", "workbench.git.push")
    .mutating()
    .seeded((ctx) =>
      project(ctx, (directory) => {
        committed(directory)
        const bare = path.join(directory, ".git", "exercise-origin.git")
        git(directory, ["init", "-q", "--bare", bare])
        git(directory, ["remote", "add", "origin", bare])
      }),
    )
    .at(post("/workbench/git/push", { setUpstream: true }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.sync(() => {
          object(body)
          check(body.upstream === `origin/${ctx.state.branch}`, "publishes the branch to origin")
          const bare = path.join(ctx.state.directory, ".git", "exercise-origin.git")
          check(
            git(ctx.state.directory, ["--git-dir", bare, "rev-parse", ctx.state.branch]) ===
              git(ctx.state.directory, ["rev-parse", "HEAD"]),
            "the remote has the commit",
          )
        }),
      "status",
    ),
  http.protected
    .get("/workbench/git/branches", "workbench.git.branches")
    .seeded((ctx) => project(ctx))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.current === ctx.state.branch, "names the current branch")
        array(body.branches)
      },
      "status",
    ),
  http.protected
    .post("/workbench/git/branches", "workbench.git.branch.create")
    .mutating()
    .seeded((ctx) => project(ctx))
    .at(post("/workbench/git/branches", { name: "feature" }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        array(body.branches)
        check(
          body.branches.some((item) => (item as { name?: unknown }).name === "feature"),
          "the new branch is listed",
        )
        check(body.current === ctx.state.branch, "without switching to it")
      },
      "status",
    ),
  http.protected
    .post("/workbench/git/switch", "workbench.git.switch")
    .mutating()
    .seeded((ctx) => project(ctx, (directory) => git(directory, ["branch", "feature"])))
    .at(post("/workbench/git/switch", { name: "feature" }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.sync(() => {
          object(body)
          check(body.current === "feature", "switches")
          check(git(ctx.state.directory, ["branch", "--show-current"]) === "feature", "in the repository")
        }),
      "status",
    ),
  http.protected
    .post("/workbench/git/switch", "workbench.git.switch.dirty")
    .seeded((ctx) =>
      project(ctx, (directory) => {
        committed(directory)
        git(directory, ["branch", "feature"])
      }).pipe(Effect.tap((state) => ctx.file("a.txt", "edited\n").pipe(Effect.as(state)))),
    )
    .at(post("/workbench/git/switch", { name: "feature" }))
    .jsonEffect(
      409,
      (body, ctx) =>
        Effect.sync(() => {
          check(JSON.stringify(body).includes("uncommitted changes"), "says why")
          check(git(ctx.state.directory, ["branch", "--show-current"]) === ctx.state.branch, "and stays put")
        }),
      "status",
    ),
  http.protected
    .post("/workbench/git/pr", "workbench.git.pr")
    .seeded((ctx) => project(ctx))
    .at(post("/workbench/git/pr", {}))
    .json(409, (body) => check(JSON.stringify(body).includes("no remote"), "needs a remote before gh"), "status"),
  http.protected
    .post("/workbench/git/message", "workbench.git.message")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const state = yield* project(ctx, (directory) => git(directory, ["add", "a.txt"]))
        yield* ctx.llmText("Add a.txt")
        return state
      }),
    )
    .at(post("/workbench/git/message", undefined))
    .json(
      200,
      (body) => {
        object(body)
        check(body.message === "Add a.txt", "returns the small model's message")
        check(body.model === "test/test-model", "from the configured small_model")
      },
      "status",
    ),
]
