import { describe, expect } from "bun:test"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import type { Review } from "@opencode-ai/schema/review"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Layer } from "effect"
import { WorkbenchEditorLsp } from "@/workbench/editor-lsp"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
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

const fake = path.join(__dirname, "../fixture/workbench/lsp-nav.js")
const nav = {
  lsp: { nav: { command: [process.execPath, fake], extensions: [".nav"], env: { FAKE_LSP_LOG: "nav.log" } } },
}

const get = (dir: string, route: string, query: Record<string, string | number>) =>
  Effect.gen(function* () {
    const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))
    const response = yield* requestInDirectory(`${route}?${search}`, dir)
    return { status: response.status, body: JSON.parse(yield* response.text) as unknown }
  })

const span = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
})

describe("workbench code intelligence routes", () => {
  it.live("hover, definition and references come from the file's language server, which opens it once", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: nav })
      const a = path.join(dir, "a.nav")
      const b = path.join(dir, "b.nav")
      yield* Effect.promise(() =>
        Promise.all([Bun.write(a, "use helper\nhelper again\nprintf\nnothing\n"), Bun.write(b, "def helper\n")]),
      )
      const at = (line: number, character: number) => ({ path: "a.nav", line, character })

      expect(yield* get(dir, "/workbench/lsp/hover", at(0, 5))).toEqual({
        status: 200,
        body: { markdown: "**helper**: `fake type`", range: span(0, 4, 10) },
      })
      expect((yield* get(dir, "/workbench/lsp/definition", at(0, 5))).body).toEqual([
        { file: b, range: span(0, 4, 10) },
      ])
      expect((yield* get(dir, "/workbench/lsp/references", at(1, 2))).body).toEqual([
        { file: a, range: span(0, 4, 10), preview: "use helper" },
        { file: a, range: span(1, 0, 6), preview: "helper again" },
        { file: b, range: span(0, 4, 10), preview: "def helper" },
      ])
      // defined outside the project: listed, marked, never previewed
      expect((yield* get(dir, "/workbench/lsp/definition", at(2, 3))).body).toEqual([
        { file: "/usr/include/fake-stdio.h", range: span(2, 4, 10), outside: true },
      ])
      // nothing known: empty answers, not errors
      expect(yield* get(dir, "/workbench/lsp/hover", at(3, 2))).toEqual({ status: 200, body: null })
      expect((yield* get(dir, "/workbench/lsp/definition", at(3, 2))).body).toEqual([])
      expect((yield* get(dir, "/workbench/lsp/references", at(3, 2))).body).toEqual([])

      const methods = (yield* Effect.promise(() => Bun.file(path.join(dir, "nav.log")).text())).split("\n")
      expect(methods.filter((method) => method === "textDocument/didOpen")).toHaveLength(1)
      expect(methods).not.toContain("textDocument/didChange")
    }),
  )

  it.live("paths outside the project are refused; a file without a language server gets empty answers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => Bun.write(path.join(dir, "notes.txt"), "plain words\n"))
      const at = { line: 0, character: 1 }
      expect((yield* get(dir, "/workbench/lsp/hover", { path: "../outside.txt", ...at })).status).toBe(403)
      expect((yield* get(dir, "/workbench/lsp/definition", { path: "missing.txt", ...at })).status).toBe(404)
      expect(yield* get(dir, "/workbench/lsp/hover", { path: "notes.txt", ...at })).toEqual({ status: 200, body: null })
      expect(yield* get(dir, "/workbench/lsp/references", { path: "notes.txt", ...at })).toEqual({
        status: 200,
        body: [],
      })
    }),
  )
})

const send = (dir: string, route: string, body: unknown) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(route, dir, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: JSON.parse(yield* response.text) as unknown }
  })

describe("workbench code intelligence, editing", () => {
  it.live("sync gives the servers the editor's text; completion answers against it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: nav })
      yield* Effect.promise(() => Bun.write(path.join(dir, "a.nav"), "use helper\n"))
      const labels = (body: unknown) => (body as Workbench.LspCompletionList).items.map((item) => item.label)

      expect(yield* send(dir, "/workbench/lsp/sync", { path: "a.nav", text: "use helper\nunsaved\n" })).toEqual({
        status: 200,
        body: true,
      })
      const typed = yield* get(dir, "/workbench/lsp/completion", { path: "a.nav", line: 1, character: 3 })
      expect(labels(typed.body)).toContain("unsaved")
      expect((typed.body as Workbench.LspCompletionList).items).toContainEqual({
        label: "helper",
        kind: "function",
        detail: "fn helper(arg)",
        insert: "helper(arg)",
      })
      expect((typed.body as Workbench.LspCompletionList).incomplete).toBe(false)

      // without text the servers read the file on disk again
      yield* send(dir, "/workbench/lsp/sync", { path: "a.nav" })
      expect(
        labels((yield* get(dir, "/workbench/lsp/completion", { path: "a.nav", line: 0, character: 2 })).body),
      ).not.toContain("unsaved")
    }),
  )

  it.live("rename writes the files and records them as the session's review changeset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: nav })
      const a = path.join(dir, "a.nav")
      const b = path.join(dir, "b.nav")
      yield* Effect.promise(() =>
        Promise.all([Bun.write(a, "use helper\nhelper again\noutsider\nnothing\n"), Bun.write(b, "def helper\n")]),
      )
      const session = (yield* send(dir, "/session", {})).body as { id: string }
      const rename = (line: number, character: number, newName: string) =>
        send(dir, "/workbench/lsp/rename", { path: "a.nav", line, character, newName, sessionID: session.id })

      expect(yield* rename(0, 5, "assist")).toEqual({
        status: 200,
        body: { files: [a, b], edits: 3, changeset: `chg_${session.id}` },
      })
      expect(yield* Effect.promise(() => Bun.file(a).text())).toBe("use assist\nassist again\noutsider\nnothing\n")
      expect(yield* Effect.promise(() => Bun.file(b).text())).toBe("def assist\n")
      const changesets = (yield* get(dir, "/review/changesets", {})).body as Review.ChangeSet[]
      expect(
        changesets.find((item) => item.id === `chg_${session.id}`)?.files.map((file) => [file.path, file.state]),
      ).toEqual([
        ["a.nav", "pending"],
        ["b.nav", "pending"],
      ])

      // refused: a file outside the project; nothing to rename: no change
      const outside = yield* rename(2, 3, "inside")
      expect(outside.status).toBe(400)
      expect(JSON.stringify(outside.body)).toContain("outside the project")
      expect(yield* rename(3, 3, "something")).toEqual({ status: 200, body: { files: [], edits: 0 } })
      expect(yield* Effect.promise(() => Bun.file(a).text())).toBe("use assist\nassist again\noutsider\nnothing\n")
    }),
  )

  it.live("format: the server's edits for the editor's text, else opencode's formatter on a copy, else nothing", () =>
    Effect.gen(function* () {
      const upper = path.join(__dirname, "../fixture/workbench/upper-format.js")
      const dir = yield* tmpdirScoped({
        git: true,
        config: { ...nav, formatter: { upper: { command: [process.execPath, upper, "$FILE"], extensions: [".up"] } } },
      })
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(dir, "a.nav"), "saved\n"),
          Bun.write(path.join(dir, "b.up"), "saved\n"),
          Bun.write(path.join(dir, "c.txt"), "saved\n"),
        ]),
      )
      expect((yield* send(dir, "/workbench/lsp/format", { path: "a.nav", text: "one  \ntwo\n" })).body).toEqual({
        edits: [{ range: span(0, 3, 5), newText: "" }],
      })
      expect((yield* send(dir, "/workbench/lsp/format", { path: "b.up", text: "unsaved text\n" })).body).toEqual({
        text: "UNSAVED TEXT\n",
      })
      expect((yield* send(dir, "/workbench/lsp/format", { path: "c.txt", text: "x\n" })).body).toEqual({})
      // the copy is gone and the files on disk are untouched
      expect((yield* Effect.promise(() => import("fs/promises").then((fs) => fs.readdir(dir)))).sort()).toEqual(
        [".git", "a.nav", "b.up", "c.txt", "nav.log", "opencode.json"].sort(),
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "b.up")).text())).toBe("saved\n")
    }),
  )
})

const clangd = which("clangd") ? it.live : it.live.skip

describe("workbench code intelligence with a real language server", () => {
  clangd(
    `[clangd] hover shows a C function's signature; definition and references find it${which("clangd") ? "" : " (skipped: clangd is not on PATH)"}`,
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { lsp: true } })
        const file = path.join(dir, "main.c")
        yield* Effect.promise(() =>
          Bun.write(file, "int add(int a, int b) { return a + b; }\nint main(void) {\n  return add(1, 2);\n}\n"),
        )
        const call = { path: "main.c", line: 2, character: 10 }
        const hover = (yield* get(dir, "/workbench/lsp/hover", call)).body as { markdown: string }
        expect(hover.markdown).toContain("int add(int a, int b)")
        expect((yield* get(dir, "/workbench/lsp/definition", call)).body).toEqual([{ file, range: span(0, 4, 7) }])
        expect((yield* get(dir, "/workbench/lsp/references", call)).body).toEqual([
          { file, range: span(0, 4, 7), preview: "int add(int a, int b) { return a + b; }" },
          { file, range: span(2, 9, 12), preview: "return add(1, 2);" },
        ])
      }),
    30_000,
  )

  clangd(
    `[clangd] completion of the editor's text, a rename for review, formatting${which("clangd") ? "" : " (skipped: clangd is not on PATH)"}`,
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { lsp: true } })
        const file = path.join(dir, "main.c")
        const saved = "int add(int a, int b) { return a + b; }\nint main(void) {\n  return add(1, 2);\n}\n"
        yield* Effect.promise(() => Bun.write(file, saved))

        // the unsaved line `  return ad` completes to add
        yield* send(dir, "/workbench/lsp/sync", { path: "main.c", text: saved.replace("add(1, 2);", "ad") })
        const completion = (yield* get(dir, "/workbench/lsp/completion", { path: "main.c", line: 2, character: 11 }))
          .body as Workbench.LspCompletionList
        expect(completion.items).toContainEqual(expect.objectContaining({ label: "add" }))

        // Diagnostics follow the editor's text: an unsaved error shows in Problems, and goes with the text on disk.
        const errors = () =>
          get(dir, "/workbench/problems", { file: "main.c", severity: "error" }).pipe(
            Effect.map((result) => (result.body as Workbench.ProblemsSnapshot).problems.length),
          )
        yield* send(dir, "/workbench/lsp/sync", { path: "main.c", text: saved.replace("add(1, 2)", "missing(1, 2)") })
        yield* pollWithTimeout(
          errors().pipe(Effect.map((count) => (count > 0 ? count : undefined))),
          "the unsaved error never reached Problems",
          "20 seconds",
        )
        yield* send(dir, "/workbench/lsp/sync", { path: "main.c" })
        yield* pollWithTimeout(
          errors().pipe(Effect.map((count) => (count === 0 ? true : undefined))),
          "the error stayed after the text on disk came back",
          "20 seconds",
        )

        const session = (yield* send(dir, "/session", {})).body as { id: string }
        expect(
          yield* send(dir, "/workbench/lsp/rename", {
            path: "main.c",
            line: 2,
            character: 10,
            newName: "sum",
            sessionID: session.id,
          }),
        ).toEqual({ status: 200, body: { files: [file], edits: 2, changeset: `chg_${session.id}` } })
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(saved.replaceAll("add", "sum"))

        const format = (yield* send(dir, "/workbench/lsp/format", {
          path: "main.c",
          text: "int main(void){return 0;}\n",
        })).body as Workbench.LspFormat
        expect(WorkbenchEditorLsp.applyEdits("int main(void){return 0;}\n", format.edits ?? [])).toBe(
          "int main(void) { return 0; }\n",
        )
      }),
    30_000,
  )
})

describe("workbench code intelligence results", () => {
  it.live("hover contents of every LSP shape become markdown", () =>
    Effect.sync(() => {
      expect(WorkbenchEditorLsp.markdown({ kind: "markdown", value: "**x**" })).toBe("**x**")
      expect(WorkbenchEditorLsp.markdown({ kind: "plaintext", value: "int x" })).toBe("```\nint x\n```")
      expect(WorkbenchEditorLsp.markdown(["intro", { language: "c", value: "int x" }, ""])).toBe(
        "intro\n\n```c\nint x\n```",
      )
      expect(WorkbenchEditorLsp.markdown(null)).toBe("")
    }),
  )

  it.live("a server's real path under a symlinked project is named as the project names it", () =>
    Effect.gen(function* () {
      const real = yield* tmpdirScoped()
      const link = path.join(yield* tmpdirScoped(), "project")
      yield* Effect.promise(() => import("fs/promises").then((fs) => fs.symlink(real, link)))
      const realFile = path.join(
        yield* Effect.promise(() => import("fs/promises").then((fs) => fs.realpath(real))),
        "x.c",
      )
      const found = yield* Effect.promise(() =>
        WorkbenchEditorLsp.locations(
          [
            [{ uri: `file://${realFile}`, range: span(1, 0, 1) }],
            { targetUri: "file://host/x", targetSelectionRange: span(0, 0, 1) },
          ],
          link,
          false,
        ),
      )
      expect(found).toEqual([{ file: path.join(link, "x.c"), range: span(1, 0, 1) }])
    }),
  )
})
