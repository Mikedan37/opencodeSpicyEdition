import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EditorSelection, EditorState, Text } from "@codemirror/state"
import { EditorView, runScopeHandlers } from "@codemirror/view"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { createEditorStore, offsetOf, positionOf, type CodePosition } from "./editor"
import { codeIntelligence, findReferences, goToDefinition, hoverAt, noteOf, type CodeIntelligence } from "./editor-lsp"

const span = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
})

function fake(answers: Partial<Pick<CodeIntelligence, "hover" | "definition" | "references">> = {}) {
  const calls: unknown[][] = []
  const ci: CodeIntelligence = {
    hover: answers.hover ?? (async () => null),
    definition: answers.definition ?? (async () => []),
    references: answers.references ?? (async () => []),
    open: (location, from) => void calls.push(["open", location, from]),
    showReferences: (items, from) => void calls.push(["references", items, from]),
    dismiss: () => (calls.push(["dismiss"]), true),
    back: () => (calls.push(["back"]), true),
    render: (dom, markdown) => {
      dom.textContent = markdown
      calls.push(["render", markdown])
      return () => void calls.push(["disposed"])
    },
    text: (key, place) => (place ? `${key} ${place}` : key),
  }
  return { ci, calls }
}

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => view.destroy()))
// theme-preload.test.ts leaves a window.matchMedia stub behind that CodeMirror cannot listen to.
beforeEach(() => {
  if (window.matchMedia("print").addEventListener) return
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
    // the note goes with the next cursor move
    view.dispatch({ selection: { anchor: 1 } })
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
