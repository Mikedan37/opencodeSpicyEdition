// Spicy Workbench route scenarios.
import { array, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario } from "./types"

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
  http.protected.get("/workbench/doctor", "workbench.doctor").json(200, (body) => {
    object(body)
    check(Array.isArray(body.languages) && body.languages.length > 0, "doctor should list languages")
  }),
]
