// Spicy Workbench route scenarios.
import { createHash } from "crypto"
import { Effect } from "effect"
import path from "path"
import { array, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario, ScenarioContext } from "./types"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const editable = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    if (!ctx.directory) throw new Error("file scenarios need a project directory")
    yield* ctx.file("edit.txt", "hello\n")
    return { directory: ctx.directory }
  })

export const workbenchScenarios: Scenario[] = [
  http.protected.get("/workbench/problems", "workbench.problems").json(200, object),
  http.protected
    .post("/workbench/check", "workbench.check")
    .mutating()
    .at((ctx) => ({ path: "/workbench/check", headers: ctx.headers(), body: { files: [] } }))
    .json(200, (body) => {
      object(body)
      check(String(body.id).startsWith("vr_"), "check should return a verification report")
      check(Array.isArray(body.checks) && body.checks.length === 0, "an empty check should run nothing")
      check(isRecord(body.summary) && body.summary.passed === 0, "an empty check passes nothing")
    }),
  http.protected.get("/workbench/runs", "workbench.runs").json(200, array),
  http.protected
    .get("/workbench/runs/{runID}", "workbench.run")
    .at((ctx) => ({ path: route("/workbench/runs/{runID}", { runID: "run_httpapi_missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .get("/workbench/file", "workbench.file.read")
    .seeded(editable)
    .at((ctx) => ({ path: "/workbench/file?path=edit.txt", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.content === "hello\n", "returns the exact text")
        check(body.hash === sha("hello\n"), "with the sha256 of its bytes")
      },
      "status",
    ),
  http.protected
    .put("/workbench/file", "workbench.file.write")
    .mutating()
    .seeded(editable)
    .at((ctx) => ({
      path: "/workbench/file",
      headers: ctx.headers(),
      body: { path: "edit.txt", content: "saved\n", baseHash: sha("hello\n") },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(body.hash === sha("saved\n"), "returns the hash of the bytes written")
          const text = yield* Effect.promise(() => Bun.file(path.join(ctx.state.directory, "edit.txt")).text())
          check(text === "saved\n", "the file on disk holds the saved text")
        }),
      "status",
    ),
  http.protected.get("/workbench/doctor", "workbench.doctor").json(200, (body) => {
    object(body)
    check(Array.isArray(body.languages) && body.languages.length > 0, "doctor should list languages")
  }),
]
