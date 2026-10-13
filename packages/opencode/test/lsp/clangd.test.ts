import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { which } from "@opencode-ai/core/util/which"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// DIAG-13 (C): with "lsp": true, opencode's own clangd returns the planted errors with their codes. Downloads stay
// off, so a machine without clangd skips instead of fetching one.
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ disableLspDownload: true })],
    ]),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)
const missing = which("clangd") ? undefined : "skipped: clangd is not on PATH"
const real = missing ? it.instance.skip : it.instance

describe("DIAG-13 real language servers", () => {
  real(
    `[clangd] a C file's planted errors come back with their codes${missing ? ` (${missing})` : ""}`,
    () =>
      Effect.gen(function* () {
        const file = path.join((yield* TestInstance).directory, "main.c")
        yield* Effect.promise(() => Bun.write(file, 'int main(void) {\n  int count = "three";\n  return missing;\n}\n'))
        const lsp = yield* LSP.Service
        yield* lsp.touchFile(file, "document")
        const found = ((yield* lsp.diagnostics())[file] ?? []).map((item) => [
          item.severity,
          item.code,
          item.range.start.line,
        ])
        expect(found).toContainEqual([1, "-Wint-conversion", 1])
        expect(found).toContainEqual([1, "undeclared_var_use", 2])
        expect((yield* lsp.status()).map((item) => `${item.id}:${item.status}`)).toContain("clangd:connected")
      }),
    { config: { lsp: true } },
    30_000,
  )
})
