import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EditorSelection, EditorState, Text } from "@codemirror/state"
import { EditorView, runScopeHandlers } from "@codemirror/view"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { createEditorStore, offsetOf, positionOf, type CodePosition } from "./editor"
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import {
  codeIntelligence,
  completionSource,
  createSync,
  findReferences,
  formatDocument,
  goToDefinition,
  hoverAt,
  indentOf,
  noteOf,
  type CodeIntelligence,
} from "./editor-lsp"

const span = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
})

function fake(
  answers: Partial<
    Pick<CodeIntelligence, "hover" | "definition" | "references" | "completion" | "rename" | "renameBlocked" | "format">
  > = {},
) {
  const calls: unknown[][] = []
  const ci: CodeIntelligence = {
    hover: answers.hover ?? (async () => null),
    definition: answers.definition ?? (async () => []),
    references: answers.references ?? (async () => []),
    completion: answers.completion ?? (async () => ({ items: [], incomplete: false })),
    rename: answers.rename ?? (async () => ({ files: [], edits: 0 })),
    renamed: (result) => void calls.push(["renamed", result]),
    renameBlocked: answers.renameBlocked ?? (() => undefined),
    format: answers.format ?? (async () => ({})),
    open: (location, from) => void calls.push(["open", location, from]),
    showReferences: (items, from) => void calls.push(["references", items, from]),
    dismiss: () => (calls.push(["dismiss"]), true),
    back: () => (calls.push(["back"]), true),
    render: (dom, markdown) => {
      dom.textContent = markdown
      calls.push(["render", markdown])
      return () => void calls.push(["disposed"])
    },
    text: (key, values) => [key, ...Object.values(values ?? {})].join(" "),
  }
  return { ci, calls }
}

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => view.destroy()))
// theme-preload.test.ts leaves a window.matchMedia stub behind that CodeMirror cannot listen to.
beforeEach(() => {
  if (typeof window.matchMedia("print").addEventListener === "function") return
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }),
  })
})

function editor(doc: string, ci: CodeIntelligence, cursor = 0) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: codeIntelligence(ci) }),
    parent: document.body,
  })
  views.push(view)
  return view
}

const key = (view: EditorView, init: KeyboardEventInit) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", init), "editor")
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("editor code intelligence", () => {
  test("go to definition opens a project location; outside, nothing or a failure is a quiet note", async () => {
    const inside: Workbench.LspLocation = { file: "/p/b.nav", range: span(0, 4, 10) }
    const outside: Workbench.LspLocation = { file: "/usr/include/x.h", range: span(2, 0, 1), outside: true }
    let answer: () => Promise<readonly Workbench.LspLocation[]> = async () => [outside, inside]
    const { ci, calls } = fake({ definition: () => answer() })
    const view = editor("use helper\nhelper\n", ci, 13)

    await goToDefinition(view, 5, ci)
    expect(calls).toEqual([["open", inside, { line: 0, character: 5 }]])

    answer = async () => [outside]
    await goToDefinition(view, 5, ci)
    expect(noteOf(view)).toBe("outside /usr/include/x.h:3")
    expect(view.dom.querySelector("[data-lsp-note]")?.textContent).toBe("outside /usr/include/x.h:3")

    answer = async () => []
    await goToDefinition(view, 5, ci)
    expect(noteOf(view)).toBe("noDefinition")
    answer = () => Promise.reject(new Error("server gone"))
    await goToDefinition(view, 5, ci)
    expect(noteOf(view)).toBe("noDefinition")
    // the note outlives the editor's own changes, and goes with the person's next cursor move
    view.dispatch({ changes: { from: 0, insert: "x" } })
    expect(noteOf(view)).toBe("noDefinition")
    view.dispatch({ selection: { anchor: 1 }, userEvent: "select" })
    expect(noteOf(view)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test("references open the list; none is a note; F12, Shift-F12, Ctrl+- and Escape are bound", async () => {
    const found: Workbench.LspLocation[] = [{ file: "/p/a.nav", range: span(0, 4, 10), preview: "use helper" }]
    let answer: readonly Workbench.LspLocation[] = found
    const asked: CodePosition[] = []
    const { ci, calls } = fake({
      references: async (at) => (asked.push(at), answer),
      definition: async (at) => (asked.push(at), []),
    })
    const view = editor("use helper\n", ci, 6)

    await findReferences(view, 6, ci)
    expect(calls).toEqual([["references", found, { line: 0, character: 6 }]])
    answer = []
    await findReferences(view, 6, ci)
    expect(noteOf(view)).toBe("noReferences")

    calls.length = 0
    asked.length = 0
    expect(key(view, { key: "F12" })).toBe(true)
    expect(key(view, { key: "F12", shiftKey: true })).toBe(true)
    await settle()
    expect(asked).toEqual([
      { line: 0, character: 6 },
      { line: 0, character: 6 },
    ])
    expect(key(view, { key: "-", ctrlKey: true })).toBe(true)
    expect(key(view, { key: "Escape" })).toBe(true)
    expect(calls).toEqual([["back"], ["dismiss"]])
  })

  test("the hover shows the server's markdown over the word it describes", async () => {
    const { ci, calls } = fake({
      hover: async (at) => (at.character === 6 ? { markdown: "**helper**", range: span(0, 4, 10) } : null),
    })
    const view = editor("use helper\n", ci)
    expect(await hoverAt(view, 1, ci)).toBeNull()

    const tooltip = await hoverAt(view, 6, ci)
    expect(tooltip).toMatchObject({ pos: 4, end: 10, above: true })
    const shown = tooltip!.create(view)
    expect(shown.dom.dataset.lspHover).toBe("")
    expect(shown.dom.textContent).toBe("**helper**")
    shown.destroy?.()
    expect(calls).toEqual([["render", "**helper**"], ["disposed"]])
  })
})

describe("editor navigation", () => {
  test("positions are 0-based lines and UTF-16 columns, clamped to the document", () => {
    const doc = Text.of(["a😀b", "second"])
    expect(positionOf(doc, 3)).toEqual({ line: 0, character: 3 })
    expect(offsetOf(doc, { line: 0, character: 3 })).toBe(3)
    expect(offsetOf(doc, { line: 1, character: 99 })).toBe(doc.length)
    expect(offsetOf(doc, { line: 9, character: 0 })).toBe(5)
  })

  test("a jump's target waits for its file's editor; Back returns the latest start, at most 50", () => {
    const store = createEditorStore({
      readFile: async () => ({ content: "", hash: "" }),
      writeFile: async () => ({ hash: "" }),
    })
    store.reveal("b.ts", { line: 3, character: 1 })
    expect(store.targets.get("b.ts")).toEqual({ line: 3, character: 1 })
    const shown: CodePosition[] = []
    store.showing.set("a.ts", (at) => void shown.push(at))
    store.reveal("a.ts", { line: 1, character: 0 })
    expect(shown).toEqual([{ line: 1, character: 0 }])
    expect(store.targets.has("a.ts")).toBe(false)

    for (let line = 0; line < 55; line++) store.remember({ path: "a.ts", line, character: 0 })
    expect(store.back()).toEqual({ path: "a.ts", line: 54, character: 0 })
    const rest = [...Array(60)].map(() => store.back()).filter(Boolean)
    expect(rest).toHaveLength(49)
    expect(store.back()).toBeUndefined()
  })
})

describe("editor code intelligence, editing", () => {
  test("the text goes out after a pause, at once on flush, in order; a dropped edit is never sent", async () => {
    const sent: (string | undefined)[] = []
    const sync = createSync(async (text) => void sent.push(text), 20)
    let text = "a"
    sync.edit(() => text)
    text = "ab"
    sync.edit(() => text)
    expect(sent).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sent).toEqual(["ab"])

    text = "abc"
    sync.edit(() => text)
    await sync.flush()
    expect(sent).toEqual(["ab", "abc"])
    await sync.flush()
    expect(sent).toEqual(["ab", "abc"])

    sync.edit(() => "dropped")
    sync.stop()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sent).toEqual(["ab", "abc"])
  })

  test("completion offers the servers' items over the word; a server range replaces from its start", async () => {
    const asked: CodePosition[] = []
    const { ci } = fake({
      completion: async (at) => {
        asked.push(at)
        return {
          items: [
            { label: "helper", kind: "function", insert: "helper(arg)" },
            { label: "member", range: span(0, 3, 4) },
          ],
          incomplete: false,
        }
      },
    })
    const view = editor("do.he", ci, 5)
    const source = completionSource(ci)
    const result = (await source(new CompletionContext(view.state, 5, false))) as CompletionResult
    expect(asked).toEqual([{ line: 0, character: 5 }])
    expect(result.from).toBe(3)
    expect(result.validFor).toEqual(/^[\w$]*$/)
    expect(result.options.map((option) => [option.label, option.type])).toEqual([
      ["helper", "function"],
      ["member", undefined],
    ])
    expect(result.options[0].apply).toBe("helper(arg)")
    const apply = result.options[1].apply as (view: EditorView, completion: unknown, from: number, to: number) => void
    apply(view, result.options[1], 3, 5)
    expect(view.state.doc.toString()).toBe("do.member")

    // nothing typed and not after a trigger character: not asked
    expect(await source(new CompletionContext(EditorState.create({ doc: "do " }), 3, false))).toBeNull()
    expect(asked).toHaveLength(1)
  })

  test("F2 asks for the new name over the word; Enter renames for review; refused, blocked or nothing is a note", async () => {
    const done: Workbench.LspRename = { files: ["/p/a.nav"], edits: 2, changeset: "chg_x" }
    let answer: () => Promise<Workbench.LspRename> = async () => done
    let blocked: string | undefined
    const renamed: [CodePosition, string][] = []
    const { ci, calls } = fake({
      rename: (at, name) => (renamed.push([at, name]), answer()),
      renameBlocked: () => blocked,
    })
    const view = editor("use helper\n", ci, 6)
    expect(key(view, { key: "F2" })).toBe(true)
    const input = document.querySelector<HTMLInputElement>("[data-lsp-rename]")!
    expect(input.value).toBe("helper")
    input.value = "assist"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))
    await settle()
    expect(renamed).toEqual([[{ line: 0, character: 4 }, "assist"]])
    expect(document.querySelector("[data-lsp-rename]")).toBeNull()
    expect(calls).toEqual([["renamed", done]])

    answer = () => Promise.reject(new Error("outside the project"))
    key(view, { key: "F2" })
    const again = document.querySelector<HTMLInputElement>("[data-lsp-rename]")!
    again.value = "other"
    again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))
    await settle()
    expect(noteOf(view)).toBe("renameRefused outside the project")

    // Escape cancels without asking
    key(view, { key: "F2" })
    document.querySelector("[data-lsp-rename]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(document.querySelector("[data-lsp-rename]")).toBeNull()
    expect(renamed).toHaveLength(2)

    blocked = "save first"
    key(view, { key: "F2" })
    expect(document.querySelector("[data-lsp-rename]")).toBeNull()
    expect(noteOf(view)).toBe("save first")
  })

  test("format applies the servers' edits or the formatter's text as one change; stale or none is a note", async () => {
    let answer: Workbench.LspFormat = { edits: [{ range: span(0, 3, 5), newText: "" }] }
    const asked: unknown[] = []
    const { ci } = fake({ format: async (text, options) => (asked.push([text, options]), answer) })
    const view = editor("one  \n    two\n", ci, 0)
    await formatDocument(view, ci)
    expect(view.state.doc.toString()).toBe("one\n    two\n")
    expect(asked).toEqual([["one  \n    two\n", { tabSize: 4, insertSpaces: true }]])

    answer = { text: "one\n  two\n" }
    await formatDocument(view, ci)
    expect(view.state.doc.toString()).toBe("one\n  two\n")

    answer = {}
    await formatDocument(view, ci)
    expect(noteOf(view)).toBe("noFormatter")

    // the person typed while the server formatted: nothing is applied
    const slow = fake({
      format: async () => {
        view.dispatch({ changes: { from: 0, insert: "!" } })
        return { text: "formatted" }
      },
    })
    await formatDocument(view, slow.ci)
    expect(view.state.doc.toString()).toBe("!one\n  two\n")
    expect(noteOf(view)).toBe("formatStale")
  })

  test("indentation is guessed from the text", () => {
    expect(indentOf("a\n\tb\n")).toEqual({ tabSize: 4, insertSpaces: false })
    expect(indentOf("a\n  b\n    c\n")).toEqual({ tabSize: 2, insertSpaces: true })
    expect(indentOf("plain\n")).toEqual({ tabSize: 2, insertSpaces: true })
  })
})
