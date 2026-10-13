// Security review, finding 4: enable checked the hash of the disabled file, then renamed whatever the file held by
// then. A writer that swaps the content between the check and the rename must not get its code loaded: the file system
// below swaps it right after the service reads it.
import { describe, expect } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { WorkbenchTools } from "@/workbench/tools/tools"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const swaps = new Map<string, string>()
const racing = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const real = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...real,
      readFileStringSafe: (file) =>
        real.readFileStringSafe(file).pipe(
          Effect.tap(() => {
            const next = swaps.get(file)
            if (next === undefined) return Effect.void
            swaps.delete(file)
            return Effect.promise(() => fs.writeFile(file, next))
          }),
        ),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const it = testEffect(LayerNode.compile(WorkbenchTools.node, [[FSUtil.node, racing]]))
const exists = (file: string) =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )

describe("tool creator: enable", () => {
  it.instance("loads the reviewed source even when the disabled file is swapped after the check", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = yield* WorkbenchTools.Service
      const folder = path.join(test.directory, ".opencode", "tool")
      const disabled = path.join(folder, "custom_racer.ts.disabled")
      const marker = path.join(test.directory, "swapped-code-ran")
      const reviewed = `export default { description: "reviewed", args: {}, execute: async () => "reviewed" }\n`
      const swapped = [
        `import { writeFileSync } from "node:fs"`,
        `writeFileSync(${JSON.stringify(marker)}, "ran")`,
        `export default { description: "swapped", args: {}, execute: async () => "swapped" }`,
        "",
      ].join("\n")
      yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }).then(() => fs.writeFile(disabled, reviewed)))
      swaps.set(disabled, swapped)

      const enabled = yield* tools.enable("racer", createHash("sha256").update(reviewed).digest("hex"))
      expect(enabled).toMatchObject({ status: "enabled", source: reviewed })
      expect(yield* Effect.promise(() => fs.readFile(path.join(folder, "custom_racer.ts"), "utf8"))).toBe(reviewed)
      expect(yield* exists(marker)).toBe(false)
      expect(yield* exists(disabled)).toBe(false)
      // The module that loaded (and that the registry gets from the module cache) is the reviewed one.
      const loaded = yield* Effect.promise(() => import(path.join(folder, "custom_racer.ts")))
      expect(loaded.default.description).toBe("reviewed")
    }),
  )
})
