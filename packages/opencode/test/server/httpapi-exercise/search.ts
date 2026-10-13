// Spicy project search route scenarios.
import { createHash } from "crypto"
import { Effect } from "effect"
import { array, check, object } from "./assertions"
import { http } from "./dsl"
import type { Scenario, ScenarioContext } from "./types"

const seeded = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    if (!ctx.directory) throw new Error("search scenarios need a project directory")
    yield* ctx.file("found.txt", "needle here\n")
    return { directory: ctx.directory }
  })

export const searchScenarios: Scenario[] = [
  http.protected
    .get("/workbench/search", "workbench.search")
    .seeded(seeded)
    .at((ctx) => ({ path: "/workbench/search?query=needle", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.files)
        const file = body.files.find((item) => (item as { path?: unknown }).path === "found.txt")
        object(file)
        check(file.hash === createHash("sha256").update("needle here\n").digest("hex"), "with the file's hash")
        check(JSON.stringify(file.lines) === JSON.stringify([{ line: 1, text: "needle here" }]), "lists the line")
      },
      "status",
    ),
]
