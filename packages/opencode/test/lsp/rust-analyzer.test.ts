import { describe, expect } from "bun:test"
import { spawnSync } from "child_process"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// DIAG-13 (Rust): with "lsp": true, opencode's rust-analyzer returns the planted type error with its code. Downloads
// stay off. A rustup proxy without the rust-analyzer component exits non-zero on --version, so it skips too.
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ disableLspDownload: true })],
    ]),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)
const missing =
  spawnSync("rust-analyzer", ["--version"]).status === 0
    ? undefined
    : "skipped: rust-analyzer is not installed (rustup component add rust-analyzer)"
const real = missing ? it.instance.skip : it.instance

describe("DIAG-13 real language servers", () => {
  real(
    `[rust-analyzer] a Rust crate's planted type error comes back with its code${missing ? ` (${missing})` : ""}`,
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "src", "main.rs")
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(dir, "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n'),
            Bun.write(file, 'fn main() {\n    let count: i32 = "one";\n    println!("{}", count);\n}\n'),
          ]),
        )
        const lsp = yield* LSP.Service
        yield* lsp.touchFile(file, "document")
        // rust-analyzer loads the crate before it reports, so its first answer for the file can be empty
        const found = yield* pollWithTimeout(
          lsp.diagnostics().pipe(
            Effect.map((all) => (all[file] ?? []).map((item) => [item.severity, item.code, item.range.start.line])),
            Effect.map((items) => (items.some((item) => item[1] === "E0308") ? items : undefined)),
          ),
          "rust-analyzer never reported E0308",
          "50 seconds",
        )
        expect(found).toContainEqual([1, "E0308", 1])
        expect((yield* lsp.status()).map((item) => `${item.id}:${item.status}`)).toContain("rust:connected")
      }),
    { config: { lsp: true } },
    60_000,
  )
})
