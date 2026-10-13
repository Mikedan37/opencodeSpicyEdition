import { describe, expect, test } from "bun:test"
import { Text } from "@codemirror/state"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchRequestError } from "./client"
import { createEditorStore, diagnosticsFor, glyphFor, languageOf, lineSeparator } from "./editor"

function fakeDisk(files: Record<string, string>) {
  const hash = (text: string) => `h:${text}`
  const calls: string[] = []
  return {
    calls,
    files,
    client: {
      readFile: async (path: string) => {
        calls.push(`read ${path}`)
        if (!(path in files)) throw new WorkbenchRequestError("unavailable", "No such file", 404)
        return { content: files[path]!, hash: hash(files[path]!) }
      },
      writeFile: async (input: { path: string; content: string; baseHash: string | null }) => {
        calls.push(`write ${input.path} ${input.baseHash}`)
        const current = input.path in files ? hash(files[input.path]!) : null
        if (current !== input.baseHash) throw new WorkbenchRequestError("failed", "changed on disk", 409)
        files[input.path] = input.content
        return { hash: hash(input.content) }
      },
    },
  }
}

describe("editor buffers", () => {
  test("load reads the exact text once; a server without the route leaves the viewer", async () => {
    const disk = fakeDisk({ "app.py": "x = 1\n" })
    const store = createEditorStore(disk.client)
    await store.load("app.py")
    await store.load("app.py")
    expect(store.state.files["app.py"]).toMatchObject({ status: "ready", base: { text: "x = 1\n", hash: "h:x = 1\n" } })
    expect(disk.calls).toEqual(["read app.py"])

    const old = createEditorStore({
      ...disk.client,
      readFile: () => Promise.reject(new WorkbenchRequestError("unavailable", "GET /workbench/file: 200")),
    })
    await old.load("app.py")
    expect(old.state.files["app.py"]?.status).toBe("unavailable")
    await store.load("missing.py")
    expect(store.state.files["missing.py"]?.status).toBe("failed")
  })

  test("save writes over the base; a file changed on disk is a conflict until Reload or Overwrite", async () => {
    const disk = fakeDisk({ "app.py": "x = 1\n" })
    const store = createEditorStore(disk.client)
    await store.load("app.py")
    store.setDirty("app.py", true)
    expect(store.dirty("app.py")).toBe(true)
    expect(await store.save("app.py", "x = 2\n")).toBe("saved")
    expect(disk.files["app.py"]).toBe("x = 2\n")
    expect(store.state.files["app.py"]?.base).toEqual({ text: "x = 2\n", hash: "h:x = 2\n" })

    // Someone else writes the file: the next save is refused and nothing is written.
    disk.files["app.py"] = "x = 3  # theirs\n"
    expect(await store.save("app.py", "x = 4\n")).toBe("conflict")
    expect(disk.files["app.py"]).toBe("x = 3  # theirs\n")
    expect(store.state.files["app.py"]?.conflict).toBe("changed on disk")

    // Overwrite writes over what is on disk now (the user was asked first).
    expect(await store.overwrite("app.py", "x = 4\n")).toBe("saved")
    expect(disk.files["app.py"]).toBe("x = 4\n")
    expect(store.state.files["app.py"]?.conflict).toBeUndefined()

    // Reload takes the disk's text as the new base.
    disk.files["app.py"] = "x = 5\n"
    await store.load("app.py", true)
    expect(store.state.files["app.py"]?.base?.text).toBe("x = 5\n")

    // A deleted file: Overwrite creates it again.
    delete disk.files["app.py"]
    expect(await store.save("app.py", "x = 6\n")).toBe("conflict")
    expect(await store.overwrite("app.py", "x = 6\n")).toBe("saved")
    expect(disk.files["app.py"]).toBe("x = 6\n")
    expect(disk.calls.filter((call) => call.startsWith("write"))).toEqual([
      "write app.py h:x = 1\n",
      "write app.py h:x = 2\n",
      "write app.py h:x = 3  # theirs\n",
      "write app.py h:x = 5\n",
      "write app.py null",
    ])
  })

  test("a save in flight is not repeated; discard forgets the buffer", async () => {
    const disk = fakeDisk({ "a.ts": "a\n" })
    const store = createEditorStore(disk.client)
    await store.load("a.ts")
    const first = store.save("a.ts", "b\n")
    expect(await store.save("a.ts", "c\n")).toBe("busy")
    expect(await first).toBe("saved")
    store.live.set("a.ts", () => "typed")
    expect(store.text("a.ts")).toBe("typed")
    store.discard("a.ts")
    expect(store.state.files["a.ts"]).toBeUndefined()
  })
})

describe("editor mappings", () => {
  test("languages by extension, line endings kept", () => {
    expect(
      ["a.ts", "b.tsx", "c.mjs", "d.jsx", "e.py", "f.rs", "g.hpp", "h.go", "i.jsonc", "j.md", "K.SWIFT"].map(
        languageOf,
      ),
    ).toEqual(["ts", "tsx", "js", "jsx", "python", "rust", "cpp", "go", "json", "markdown", "swift"])
    expect(languageOf("Makefile")).toBeUndefined()
    expect(languageOf(".gitignore")).toBeUndefined()
    expect(lineSeparator("a\r\nb\n")).toBe("\r\n")
    expect(lineSeparator("a\nb\rc")).toBe("\n")
  })

  test("problems become clamped document ranges", () => {
    const doc = Text.of(["def f():", "    return x", ""])
    const problem = (line: number, character: number, end: number, range = true) =>
      ({
        id: `p${line}`,
        file: "/repo/app.py",
        ...(range ? { range: { start: { line, character }, end: { line, character: end } } } : {}),
        severity: "error",
        message: "undefined name x",
        source: { kind: "lsp", tool: "pyright", producer: "lsp:pyright:/repo" },
        observedAt: 1,
        stale: false,
      }) as Workbench.Problem
    expect(
      diagnosticsFor(
        [problem(1, 11, 12), problem(1, 4, 99), problem(9, 0, 1), problem(0, 0, 1, false), problem(1, 4, 4)],
        doc,
      ),
    ).toEqual([
      { from: 20, to: 21, severity: "error", message: "undefined name x", source: "pyright", id: "p1" },
      { from: 13, to: 21, severity: "error", message: "undefined name x", source: "pyright", id: "p1" },
      { from: 22, to: 22, severity: "error", message: "undefined name x", source: "pyright", id: "p9" },
      // A point (tsc reports one) marks the word that starts there: "return".
      { from: 13, to: 19, severity: "error", message: "undefined name x", source: "pyright", id: "p1" },
    ])
  })

  test("the glyph column shows a line's breakpoint first, else its worst diagnostic", () => {
    expect(glyphFor({ line: 2, kind: "line", verified: true }, ["error"])).toBe("line")
    expect(glyphFor({ line: 4, kind: "condition", verified: false }, [])).toBe("unverified")
    expect(glyphFor({ line: 9, kind: "log", verified: true }, [])).toBe("log")
    expect(glyphFor(undefined, ["info", "warning", "hint"])).toBe("warning")
    expect(glyphFor(undefined, ["hint"])).toBe("hint")
    expect(glyphFor(undefined, [])).toBeUndefined()
  })
})
