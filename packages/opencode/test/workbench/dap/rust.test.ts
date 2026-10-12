// Rust under lldb-dap: rustc's LLDB formatters through initCommands, and the rust-test preset that finds the
// unit-test binary with `cargo test --no-run --message-format=json`. Launching needs macOS Developer Mode; while
// it is off only building and the refusal are exercised (no lldb-dap process is started).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { which } from "@opencode-ai/core/util/which"
import { Lldb } from "../../../src/workbench/dap/adapters/lldb"
import { DebugLaunch } from "../../../src/workbench/dap/launch"
import { WorkbenchDebug } from "../../../src/workbench/dap/service"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(WorkbenchDebug.node))
const developer = await Lldb.developerMode()
const cargo = which("cargo") && which("rustc")
const agent = { by: "agent" as const, sessionID: "ses_rust" }

const created: string[] = []
afterEach(async () => {
  await disposeAllInstances()
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const crate = (lib: string) => ({
  "Cargo.toml": '[package]\nname = "avg"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/lib.rs": lib,
})
const AVG = `pub fn average(xs: &[i32]) -> i32 {
    let total: i32 = xs.iter().sum();
    total / xs.len() as i32
}

#[cfg(test)]
mod tests {
    #[test]
    fn empty() {
        let orders = vec![10, 20];
        assert_eq!(super::average(&orders[..0]), 0);
    }
}
`

async function project(files: Record<string, string>) {
  // Real path: cargo reports /private/var/... for macOS temp folders.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-rust-")))
  created.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await Bun.write(path.join(dir, name), text)
  }
  return dir
}

// Captured from `cargo test --no-run --message-format=json` (cargo 1.84) with paths shortened to /ROOT.
const CARGO = [
  `{"reason":"compiler-artifact","target":{"kind":["lib"],"name":"avg","test":true},"profile":{"test":false},"executable":null}`,
  `{"reason":"compiler-artifact","target":{"kind":["test"],"name":"integration","test":true},"profile":{"test":true},"executable":"/ROOT/target/debug/deps/integration-1"}`,
  `{"reason":"compiler-artifact","target":{"kind":["lib"],"name":"avg","test":true},"profile":{"test":true},"executable":"/ROOT/target/debug/deps/avg-2"}`,
  `{"reason":"build-finished","success":true}`,
].join("\n")

describe("rust-test preset and formatters", () => {
  test("test binaries from cargo JSON: the library's unit tests first; compile errors kept", () => {
    expect(Lldb.testBinaries(CARGO).binaries).toEqual([
      { path: "/ROOT/target/debug/deps/avg-2", target: "avg", kind: ["lib"] },
      { path: "/ROOT/target/debug/deps/integration-1", target: "integration", kind: ["test"] },
    ])
    const broken = `{"reason":"compiler-message","message":{"rendered":"error[E0308]: mismatched types\\n --> src/lib.rs:2:5"}}`
    expect(Lldb.testBinaries(broken)).toEqual({
      binaries: [],
      errors: ["error[E0308]: mismatched types\n --> src/lib.rs:2:5"],
    })
  })

  test("the preset builds after approval and stops on panics; Rust programs get the formatters", async () => {
    const dir = await project(crate(AVG))
    const spec: DebugLaunch.Spec = await Effect.runPromise(
      DebugLaunch.resolve({ preset: "rust-test", program: ".", args: ["empty"] }, { directory: dir }),
    )
    expect(spec).toMatchObject({
      adapter: "lldb-dap",
      request: "launch",
      name: `${path.basename(dir)} tests`,
      build: { command: ["cargo", "test", "--no-run", "--message-format=json"], cwd: dir },
      rust: true,
      functions: ["rust_panic"],
      arguments: { args: ["empty"], cwd: dir, runInTerminal: true },
    })
    expect(spec.program).toBeUndefined()
    const binary = await Effect.runPromise(
      DebugLaunch.resolve({ program: "target/debug/avg", adapter: "lldb-dap" }, { directory: dir }),
    )
    expect(binary).toMatchObject({ rust: true, functions: ["rust_panic"] })
    const c = await project({ "main.c": "int main(void) { return 0; }\n" })
    const native = await Effect.runPromise(DebugLaunch.resolve({ program: "a.out" }, { directory: c }))
    expect(native.rust).toBeUndefined()
    const missing = await Effect.runPromise(
      DebugLaunch.resolve({ preset: "rust-test", program: "nope" }, { directory: dir }).pipe(Effect.flip),
    )
    expect(missing.message).toContain("no Cargo.toml")
  })

  test.skipIf(!cargo)(
    `rustc's LLDB formatters resolve to existing files${cargo ? "" : " [skipped: rustc not found]"}`,
    async () => {
      const commands = await Lldb.rust(os.tmpdir())
      expect(commands).toHaveLength(2)
      const files = commands!.map((item) => /"(.+)"/.exec(item)![1])
      expect(files.map((file) => path.basename(file))).toEqual(["lldb_lookup.py", "lldb_commands"])
      expect(await Promise.all(files.map((file) => Bun.file(file).exists()))).toEqual([true, true])
      expect(commands![0]).toStartWith("command script import ")
      expect(commands![1]).toStartWith("command source -s 0 ")
    },
  )

  test.skipIf(!cargo)(
    `cargo test --no-run locates the unit-test binary; a compile error is reported${cargo ? "" : " [skipped: cargo not found]"}`,
    async () => {
      const dir = await project(crate(AVG))
      const built = await Lldb.testBinary({ command: ["cargo", "test", "--no-run", "--message-format=json"], cwd: dir })
      if ("error" in built) throw new Error(built.error)
      expect(built.program.startsWith(path.join(dir, "target", "debug", "deps", "avg-"))).toBe(true)
      expect((await fs.stat(built.program)).mode & 0o111).toBeGreaterThan(0)
      const broken = await project(crate(`pub fn average() -> i32 { "zero" }\n`))
      const failed = await Lldb.testBinary({
        command: ["cargo", "test", "--no-run", "--message-format=json"],
        cwd: broken,
      })
      expect("error" in failed && failed.error).toContain("mismatched types")
    },
    120_000,
  )

  it.instance("while Developer Mode is off, rust-test is refused before anything is built", () =>
    Effect.gen(function* () {
      if (developer) return
      const test = yield* TestInstance
      for (const [name, text] of Object.entries(crate(AVG))) {
        yield* Effect.promise(() => fs.mkdir(path.dirname(path.join(test.directory, name)), { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(test.directory, name), text))
      }
      const debug = yield* WorkbenchDebug.Service
      const spec = yield* debug.prepare({ preset: "rust-test" })
      const error = yield* debug.start(spec, agent).pipe(Effect.flip)
      expect(error.message).toBe(Lldb.DEVELOPER_MODE_OFF)
      const built = yield* Effect.promise(() =>
        fs.stat(path.join(test.directory, "target")).then(
          () => true,
          () => false,
        ),
      )
      expect(built).toBe(false)
    }),
  )

  // Only ever runs with Developer Mode on, where launching does not prompt.
  const launch = !developer || !cargo ? it.instance.skip : it.instance
  launch(
    `DAP-18 rust-test under lldb-dap stops on the panic with formatted locals${
      !developer ? " [skipped: Developer Mode off]" : !cargo ? " [skipped: cargo not found]" : ""
    }`,
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        for (const [name, text] of Object.entries(crate(AVG))) {
          yield* Effect.promise(() => fs.mkdir(path.dirname(path.join(test.directory, name)), { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(test.directory, name), text))
        }
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ preset: "rust-test", args: ["empty"] })
        const { session, result } = yield* debug.start(spec, agent)
        expect(result.outcome).toBe("stopped")
        const frame = result.info.stop?.frames.find((item) => item.name.includes("empty"))
        expect(frame).toBeDefined()
        // With rustc's formatters a Vec shows its elements instead of raw buffer fields.
        const tree = yield* session.inspect({ frameID: frame!.id, path: "orders" }, agent)
        expect(JSON.stringify(tree)).toContain("20")
      }),
    120_000,
  )
})
