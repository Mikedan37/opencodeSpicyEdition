import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import * as LSPServer from "@/lsp/server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { InstanceContext } from "@/project/instance-context"
import { tmpdir } from "../fixture/fixture"

// spicy: REG-03..REG-06 root and spawn regressions

const ctx = (directory: string): InstanceContext => ({ directory, worktree: directory, project: {} as any })

async function put(file: string, text = "") {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
}

describe("gopls root (REG-03)", () => {
  test("uses the module directory when there is no go.work", async () => {
    await using tmp = await tmpdir()
    await put(path.join(tmp.path, "svc", "go.mod"), "module example.com/svc\n")
    await put(path.join(tmp.path, "svc", "cmd", "main.go"), "package main\n")
    expect(await LSPServer.Gopls.root(path.join(tmp.path, "svc", "cmd", "main.go"), ctx(tmp.path))).toBe(
      path.join(tmp.path, "svc"),
    )
  })

  test("prefers the go.work directory", async () => {
    await using tmp = await tmpdir()
    await put(path.join(tmp.path, "go.work"), "go 1.22\n")
    await put(path.join(tmp.path, "svc", "go.mod"), "module example.com/svc\n")
    await put(path.join(tmp.path, "svc", "main.go"), "package main\n")
    expect(await LSPServer.Gopls.root(path.join(tmp.path, "svc", "main.go"), ctx(tmp.path))).toBe(tmp.path)
  })
})

describe("sourcekit-lsp root and extensions (REG-04, REG-05)", () => {
  test("an Xcode project directory marks the root", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "ios", "App.xcodeproj"), { recursive: true })
    await put(path.join(tmp.path, "ios", "App", "View.swift"))
    expect(await LSPServer.SourceKit.root(path.join(tmp.path, "ios", "App", "View.swift"), ctx(tmp.path))).toBe(
      path.join(tmp.path, "ios"),
    )
  })

  test("a workspace marks the root and the nearest marker wins", async () => {
    await using tmp = await tmpdir()
    const apple = path.join(tmp.path, "apple")
    await fs.mkdir(path.join(apple, "All.xcworkspace"), { recursive: true })
    await put(path.join(apple, "pkg", "Package.swift"))
    await put(path.join(apple, "pkg", "Sources", "Lib", "Lib.swift"))
    await put(path.join(apple, "app", "main.swift"))
    expect(await LSPServer.SourceKit.root(path.join(apple, "app", "main.swift"), ctx(tmp.path))).toBe(apple)
    expect(await LSPServer.SourceKit.root(path.join(apple, "pkg", "Sources", "Lib", "Lib.swift"), ctx(tmp.path))).toBe(
      path.join(apple, "pkg"),
    )
  })

  test("claims Objective-C sources only inside an Apple project", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "mac", "Tool.xcodeproj"), { recursive: true })
    await put(path.join(tmp.path, "mac", "Tool", "main.m"))
    await put(path.join(tmp.path, "matlab", "solve.m"))
    await put(path.join(tmp.path, "loose", "main.swift"))
    expect(LSPServer.SourceKit.extensions).toEqual([".swift", ".m", ".mm"])
    expect(await LSPServer.SourceKit.root(path.join(tmp.path, "mac", "Tool", "main.m"), ctx(tmp.path))).toBe(
      path.join(tmp.path, "mac"),
    )
    expect(await LSPServer.SourceKit.root(path.join(tmp.path, "matlab", "solve.m"), ctx(tmp.path))).toBeUndefined()
    expect(await LSPServer.SourceKit.root(path.join(tmp.path, "loose", "main.swift"), ctx(tmp.path))).toBe(tmp.path)
  })
})

describe("typescript spawn (REG-06)", () => {
  test("does not install typescript-language-server when downloads are disabled", async () => {
    await using tmp = await tmpdir()
    await put(
      path.join(tmp.path, "node_modules", "typescript", "package.json"),
      '{"name":"typescript","version":"5.0.0"}',
    )
    await put(path.join(tmp.path, "node_modules", "typescript", "lib", "tsserver.js"))
    const flags = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* RuntimeFlags.Service
      }).pipe(Effect.provide(RuntimeFlags.layer({ disableLspDownload: true }))),
    )
    const handle = await LSPServer.Typescript.spawn(tmp.path, ctx(tmp.path), flags)
    expect(handle).toBeUndefined()
    expect(
      await Bun.file(path.join(Global.Path.cache, "packages", "typescript-language-server", "package.json")).exists(),
    ).toBe(false)
  })
})
