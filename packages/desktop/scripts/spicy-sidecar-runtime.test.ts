import { expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

// spicy: the desktop's v1 sidecar runs the opencode server under Node (Electron's utility process), where `Bun` is not
// defined, so server code must not call Bun APIs. The desktop smoke found "ReferenceError: Bun is not defined" when the
// debugger read launch.json. Only the CLI commands (src/cli) run under Bun alone.
test("server code calls no Bun API", async () => {
  const src = path.resolve(import.meta.dir, "../../opencode/src")
  const found: string[] = []
  for await (const file of new Glob("**/*.{ts,tsx}").scan(src)) {
    if (file.startsWith("cli/")) continue
    const lines = (await Bun.file(path.join(src, file)).text()).split("\n")
    lines.forEach((line, index) => {
      if (/\bBun\.[A-Za-z]/.test(line.replace(/\/\/.*$/, ""))) found.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  expect(found).toEqual([])
})
