// Spicy review route scenarios. Seeds write the review document straight into the isolated JSON store
// and baselines into the project's snapshot store, the same places ReviewChanges reads.
import { Hash } from "@opencode-ai/core/util/hash"
import { Effect } from "effect"
import { mkdirSync } from "fs"
import path from "path"
import { array, check, object } from "./assertions"
import { http, route } from "./dsl"
import { exerciseDataDirectory } from "./environment"
import type { Scenario, ScenarioContext } from "./types"

const ID = "chg_ses_exercise"
const FILE = "new.txt"

const git = (args: string[], env: Record<string, string> = {}, stdin?: string) =>
  Bun.spawnSync(["git", ...args], {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
  })
    .stdout.toString()
    .trim()

// One changeset whose session added new.txt. `onDisk: false` seeds it after a reject that undo can revert.
const seed = (ctx: ScenarioContext, options: { onDisk: boolean } = { onDisk: true }) =>
  Effect.gen(function* () {
    if (!ctx.directory) throw new Error("review scenarios need a project directory")
    const project = yield* ctx.project()
    const gitdir = path.join(exerciseDataDirectory, "snapshot", project.id, Hash.fast(project.worktree))
    mkdirSync(gitdir, { recursive: true })
    git(["init", "-q"], { GIT_DIR: gitdir, GIT_WORK_TREE: project.worktree })
    const before = git(["--git-dir", gitdir, "hash-object", "-w", "--stdin"], {}, "hello\n")
    const doc = {
      files: { [FILE]: { base: null, owner: ID, settled: !options.onDisk } },
      changesets: {
        [ID]: {
          owner: { kind: "opencode-session", id: "ses_exercise" },
          directory: ctx.directory,
          updatedAt: Date.now(),
          decided: options.onDisk ? {} : { [FILE]: { accepted: 0, rejected: 1, status: "added" } },
        },
      },
      undo: options.onDisk ? [] : [{ changeset: ID, path: FILE, before, after: null, hunks: 1 }],
    }
    const file = path.join(
      exerciseDataDirectory,
      "storage",
      "review",
      project.id,
      Hash.fast(project.worktree) + ".json",
    )
    yield* Effect.promise(() => Bun.write(file, JSON.stringify(doc)))
    if (options.onDisk) yield* ctx.file(FILE, "hello\n")
    return { directory: ctx.directory }
  })

const decision = (ctx: ScenarioContext, suffix: string, body: unknown) => ({
  path: route(`/review/changesets/{changesetID}${suffix}`, { changesetID: ID }),
  headers: ctx.headers(),
  body,
})

const exists = (directory: string) => Effect.promise(() => Bun.file(path.join(directory, FILE)).exists())

export const reviewScenarios: Scenario[] = [
  http.protected
    .get("/review/changesets", "review.changesets.list")
    .seeded((ctx) => seed(ctx))
    .json(
      200,
      (body) => {
        array(body)
        const changeset = body.find((item) => (item as { id?: unknown }).id === ID)
        object(changeset)
        array(changeset.files)
        check(
          changeset.files.length === 1 && (changeset.files[0] as { status?: unknown }).status === "added",
          "lists the added file",
        )
      },
      "status",
    ),
  http.protected
    .get("/review/changesets/{changesetID}", "review.changesets.get")
    .seeded((ctx) => seed(ctx))
    .at((ctx) => ({ path: route("/review/changesets/{changesetID}", { changesetID: ID }), headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.id === ID, "returns the changeset")
      },
      "status",
    ),
  http.protected
    .post("/review/changesets/{changesetID}/hunks/{hunkID}", "review.changesets.hunk")
    .seeded((ctx) => seed(ctx))
    .at((ctx) => decision(ctx, "/hunks/hunk_stale", { action: "reject" }))
    .status(409),
  http.protected
    .post("/review/changesets/{changesetID}/files", "review.changesets.file")
    .seeded((ctx) => seed(ctx))
    .at((ctx) => decision(ctx, "/files", { path: FILE, action: "accept" }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          array(body.files)
          check((body.files[0] as { state?: unknown }).state === "accepted", "the file is accepted")
          check(yield* exists(ctx.state.directory), "accept leaves the file in place")
        }),
      "status",
    ),
  http.protected
    .post("/review/changesets/{changesetID}/all", "review.changesets.all")
    .seeded((ctx) => seed(ctx))
    .at((ctx) => decision(ctx, "/all", { action: "reject" }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          array(body.files)
          check((body.files[0] as { state?: unknown }).state === "rejected", "the file is rejected")
          check(!(yield* exists(ctx.state.directory)), "rejecting an added file deletes it")
        }),
      "status",
    ),
  http.protected
    .post("/review/changesets/{changesetID}/undo", "review.changesets.undo")
    .seeded((ctx) => seed(ctx, { onDisk: false }))
    .at((ctx) => decision(ctx, "/undo", { path: FILE }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(yield* exists(ctx.state.directory), "undo restores the rejected file")
        }),
      "status",
    ),
]
