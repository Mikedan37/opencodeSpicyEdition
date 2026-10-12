import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Doctor } from "@/workbench/doctor"
import { tmpdir } from "../fixture/fixture"

// spicy: doctor detection logic against fake executables on a private PATH.

async function tool(dir: string, name: string, script: string) {
  const file = path.join(dir, name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(file, `#!/bin/sh\n${script}\n`)
  await fs.chmod(file, 0o755)
  return file
}

function report(input: Omit<Doctor.Input, "directory" | "lsp"> & Partial<Pick<Doctor.Input, "lsp">>, dir: string) {
  return Effect.runPromise(
    Doctor.report({ directory: dir, lsp: true, ...input }).pipe(Effect.provide(LayerNode.compile(AppProcess.node))),
  )
}

function find(result: Doctor.Report, language: string, tool: string) {
  return result.languages.find((item) => item.id === language)?.probes.find((item) => item.tool === tool)
}

describe("workbench doctor", () => {
  test("runnable, stub, timed out and absent tools", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await tool(bin, "clangd", 'echo "clangd version 99.0.0"')
    // The rustup proxy for a component that is not installed.
    await tool(
      bin,
      "rust-analyzer",
      `echo "error: Unknown binary 'rust-analyzer' in official toolchain 'stable-aarch64-apple-darwin'." >&2; exit 1`,
    )
    await tool(bin, "gopls", "exec /bin/sleep 5")

    const started = Date.now()
    const result = await report({ env: { PATH: bin }, home: tmp.path, timeout: "500 millis" }, tmp.path)
    expect(Date.now() - started).toBeLessThan(3_000)

    expect(find(result, "c", "clangd")).toEqual({
      area: "lsp",
      tool: "clangd",
      status: "ok",
      path: path.join(bin, "clangd"),
      version: "clangd version 99.0.0",
    })
    expect(find(result, "rust", "rust-analyzer")).toMatchObject({
      status: "broken",
      reason: "error: Unknown binary 'rust-analyzer' in official toolchain 'stable-aarch64-apple-darwin'.",
    })
    expect(find(result, "go", "gopls")).toMatchObject({ status: "broken", reason: "Timed out" })
    expect(find(result, "go", "dlv")).toEqual({ area: "debug", tool: "dlv", status: "missing" })
    expect(Doctor.table(result)).toContain("rust        lsp      broken   rust-analyzer")
  })

  test("skips a dead python3 and finds debugpy bundled with VS Code", async () => {
    await using tmp = await tmpdir()
    const dead = path.join(tmp.path, "dead")
    const good = path.join(tmp.path, "good")
    // Executable bit but not a runnable image, like an x86_64 binary on arm64.
    await fs.mkdir(dead, { recursive: true })
    await Bun.write(path.join(dead, "python3"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]))
    await fs.chmod(path.join(dead, "python3"), 0o755)
    await tool(
      good,
      "python3",
      [
        'if [ "$1" = "--version" ]; then echo "Python 3.12.1"; exit 0; fi',
        'if [ "$1" = "-c" ] && [ -n "$PYTHONPATH" ]; then printf 1.8.20; exit 0; fi',
        'if [ "$1" = "-c" ]; then echo "ModuleNotFoundError: No module named \'debugpy\'" >&2; exit 1; fi',
        'echo "No module named pytest" >&2; exit 1',
      ].join("\n"),
    )
    const libs = path.join(
      tmp.path,
      ".vscode",
      "extensions",
      "ms-python.debugpy-2026.6.0-darwin-arm64",
      "bundled",
      "libs",
    )
    await fs.mkdir(libs, { recursive: true })

    const result = await report({ env: { PATH: [dead, good].join(path.delimiter) }, home: tmp.path }, tmp.path)

    const python = find(result, "python", "python3")
    expect(python).toMatchObject({ status: "ok", path: path.join(good, "python3"), version: "Python 3.12.1" })
    expect(python?.reason).toStartWith(`skipped ${path.join(dead, "python3")}: `)
    expect(find(result, "python", "debugpy")).toMatchObject({ status: "ok", path: libs, version: "1.8.20" })
    expect(find(result, "python", "pytest")).toMatchObject({
      status: "missing",
      reason: `pytest is not installed for ${path.join(good, "python3")}`,
    })
  })

  test("no runnable python3 at all", async () => {
    await using tmp = await tmpdir()
    const result = await report({ env: { PATH: path.join(tmp.path, "empty") }, home: tmp.path }, tmp.path)
    expect(find(result, "python", "python3")).toMatchObject({ status: "missing" })
    expect(find(result, "python", "debugpy")).toMatchObject({
      status: "missing",
      reason: "no runnable python3 (none on PATH)",
    })
  })

  test.skipIf(process.platform !== "darwin")(
    `lldb-dap is blocked while Developer Mode is off${process.platform === "darwin" ? "" : " (skipped: macOS only)"}`,
    async () => {
      await using tmp = await tmpdir()
      const bin = path.join(tmp.path, "bin")
      await tool(bin, "lldb-dap", 'echo "lldb-dap: LLVM version 21.0.0"')
      await tool(bin, "DevToolsSecurity", 'echo "Developer mode is currently disabled."')
      const result = await report({ env: { PATH: bin }, home: tmp.path }, tmp.path)
      for (const language of ["swift", "c", "rust"])
        expect(find(result, language, "lldb-dap")).toMatchObject({
          status: "blocked",
          path: path.join(bin, "lldb-dap"),
        })
    },
  )

  test("LSP config state", async () => {
    await using tmp = await tmpdir()
    const env = { PATH: path.join(tmp.path, "empty") }
    const off = await report({ env, home: tmp.path, lsp: undefined }, tmp.path)
    expect(off.languages.every((item) => !item.lsp.enabled)).toBe(true)
    const partial = await report({ env, home: tmp.path, lsp: { clangd: { disabled: true } } }, tmp.path)
    expect(partial.languages.find((item) => item.id === "c")?.lsp).toEqual({
      server: "clangd",
      enabled: false,
      reason: '"clangd" is disabled in config',
    })
    expect(partial.languages.find((item) => item.id === "swift")?.lsp.enabled).toBe(true)
  })
})
