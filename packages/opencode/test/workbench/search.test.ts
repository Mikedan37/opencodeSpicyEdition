import { describe, expect } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { WorkbenchSearch } from "../../src/workbench/search"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.promise(() => resetDatabase()),
        () => Effect.promise(() => resetDatabase()),
      ),
    ),
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    httpApiLayer,
  ),
)

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const FILES: Record<string, string> = {
  ".gitignore": "ignored/\n",
  "a.ts": "const foo = 1\nfoo(foo)\nfoobar\n",
  "sub/b.ts": "Foo\n",
  "lib/c.js": "foo bar\n",
  ".hidden.ts": "foo\n",
  "ignored/d.ts": "foo\n",
  // rg leaves the BOM out of the first line; the editor's text keeps it.
  "bom.txt": "﻿foo first\n",
}

const project = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  for (const [name, text] of Object.entries(FILES)) {
    yield* Effect.promise(() => fs.mkdir(path.join(dir, path.dirname(name)), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(dir, name), text))
  }
  return dir
})

type Result = WorkbenchSearch.Result

const search = (dir: string, query: Record<string, string>) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(`/workbench/search?${new URLSearchParams(query)}`, dir)
    return { status: response.status, body: JSON.parse(yield* response.text) as Result & { message?: string } }
  })

const paths = (result: Result) => result.files.map((file) => file.path)

describe("GET /workbench/search", () => {
  it.live("lists matching lines by file in path order, gitignore-aware, with each file's hash", () =>
    Effect.gen(function* () {
      const dir = yield* project
      const found = yield* search(dir, { query: "foo" })
      expect(found.status).toBe(200)
      expect(paths(found.body)).toEqual([".hidden.ts", "a.ts", "bom.txt", "lib/c.js", "sub/b.ts"])
      const a = found.body.files.find((file) => file.path === "a.ts")!
      expect(a.hash).toBe(sha(FILES["a.ts"]))
      expect(a.lines).toEqual([
        { line: 1, text: "const foo = 1" },
        { line: 2, text: "foo(foo)" },
        { line: 3, text: "foobar" },
      ])
      expect(found.body.files.find((file) => file.path === "bom.txt")).toEqual({
        path: "bom.txt",
        hash: sha(FILES["bom.txt"]),
        lines: [{ line: 1, text: "foo first" }],
      })
      // ripgrep's count: two on line 2, "Foo" ignoring case.
      expect(found.body).toMatchObject({ listed: 8, total: 8 })
      expect((yield* search(dir, { query: "nothing like it" })).body).toEqual({ files: [], listed: 0, total: 0 })
    }),
  )

  it.live("matches case, whole words, regular expressions and literal text as asked", () =>
    Effect.gen(function* () {
      const dir = yield* project
      expect(paths((yield* search(dir, { query: "Foo", case: "true" })).body)).toEqual(["sub/b.ts"])
      const words = (yield* search(dir, { query: "foo", word: "true" })).body
      expect(words.files.find((file) => file.path === "a.ts")!.lines.map((line) => line.line)).toEqual([1, 2])
      const regex = (yield* search(dir, { query: "fo+\\(", regex: "true" })).body
      expect(regex.files.map((file) => [file.path, file.lines.map((line) => line.line)])).toEqual([["a.ts", [2]]])
      // Look-behind runs on PCRE2, like JavaScript allows it.
      const behind = (yield* search(dir, { query: "(?<=\\()foo", regex: "true" })).body
      expect(behind.files.map((file) => [file.path, file.lines.map((line) => line.line)])).toEqual([["a.ts", [2]]])
      // Literal by default: "foo(" is text, not an unclosed group.
      expect(paths((yield* search(dir, { query: "foo(" })).body)).toEqual(["a.ts"])
    }),
  )

  it.live("includes and excludes globs or plain paths", () =>
    Effect.gen(function* () {
      const dir = yield* project
      expect(paths((yield* search(dir, { query: "foo", include: "sub" })).body)).toEqual(["sub/b.ts"])
      expect(paths((yield* search(dir, { query: "foo", include: "*.js, sub/b.ts" })).body)).toEqual([
        "lib/c.js",
        "sub/b.ts",
      ])
      expect(paths((yield* search(dir, { query: "foo", include: "*.{js,txt}" })).body)).toEqual(["bom.txt", "lib/c.js"])
      expect(paths((yield* search(dir, { query: "foo", exclude: "lib, sub/, *.txt" })).body)).toEqual([
        ".hidden.ts",
        "a.ts",
      ])
    }),
  )

  it.live("refuses a pattern or glob ripgrep cannot use, with its message", () =>
    Effect.gen(function* () {
      const dir = yield* project
      const regex = yield* search(dir, { query: "foo(", regex: "true" })
      expect(regex.status).toBe(400)
      expect(regex.body.message).toContain("regex")
      const glob = yield* search(dir, { query: "foo", include: "[" })
      expect(glob.status).toBe(400)
      expect(glob.body.message).toContain("glob")
      expect((yield* search(dir, { query: "" })).status).toBe(400)
    }),
  )

  it.live("sends lines up to the match cap and counts the rest", () =>
    Effect.gen(function* () {
      const dir = yield* project
      yield* Effect.promise(() =>
        fs.writeFile(path.join(dir, "many.txt"), "foo\n".repeat(WorkbenchSearch.MAX_MATCHES + 100)),
      )
      const found = (yield* search(dir, { query: "foo" })).body
      expect(found.listed).toBeGreaterThanOrEqual(WorkbenchSearch.MAX_MATCHES)
      expect(found.listed).toBeLessThan(WorkbenchSearch.MAX_MATCHES + 3)
      expect(found.total).toBe(WorkbenchSearch.MAX_MATCHES + 100 + 8)
      expect(found.files.reduce((sum, file) => sum + file.lines.length, 0)).toBeLessThanOrEqual(found.listed)
    }),
  )

  it.live("leaves a file's hash out when the editor does not open it", () =>
    Effect.gen(function* () {
      const dir = yield* project
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "big.log"), "foo\n" + "x".repeat(8 * 1024 * 1024)))
      const big = (yield* search(dir, { query: "foo", include: "*.log" })).body.files
      expect(big).toEqual([{ path: "big.log", lines: [{ line: 1, text: "foo" }] }])
    }),
  )
})
