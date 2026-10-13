// The IDE editor's code intelligence, answered by the project's language servers (client.ts lsp*): a markdown hover,
// go to definition (F12 or Mod-click), find references (Shift-F12) and Back (Ctrl+-). The view supplies the requests,
// navigation and the markdown renderer (editor-view.tsx). A failed request, no server or no answer is a quiet note at
// the cursor, never an error toast.
import { StateEffect, StateField, type Extension } from "@codemirror/state"
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from "@codemirror/view"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { offsetOf, positionOf, type CodePosition } from "./editor"

export type CodeIntelligence = {
  hover: (at: CodePosition) => Promise<Workbench.LspHover | null>
  definition: (at: CodePosition) => Promise<readonly Workbench.LspLocation[]>
  references: (at: CodePosition) => Promise<readonly Workbench.LspLocation[]>
  // Opens a location inside the project; `from` is the cursor before the jump, for Back.
  open: (location: Workbench.LspLocation, from: CodePosition) => void
  showReferences: (items: readonly Workbench.LspLocation[], from: CodePosition) => void
  // Closes the references list; false when none is open.
  dismiss: () => boolean
  back: () => boolean
  // Fills `dom` with the rendered markdown; returns its cleanup.
  render: (dom: HTMLElement, markdown: string) => () => void
  // The quiet notes' text.
  text: (key: "noDefinition" | "noReferences" | "outside", place?: string) => string
}

const setNote = StateEffect.define<{ pos: number; text: string } | null>()
// The quiet note: gone with the next edit or cursor move.
const noteField = StateField.define<{ pos: number; text: string } | null>({
  create: () => null,
  update: (value, tr) =>
    tr.effects.reduce<typeof value>(
      (next, effect) => (effect.is(setNote) ? effect.value : next),
      tr.docChanged || tr.selection ? null : value,
    ),
  provide: (field) =>
    showTooltip.from(field, (note): Tooltip | null =>
      note
        ? {
            pos: note.pos,
            above: true,
            create: () => {
              const dom = document.createElement("div")
              dom.className = "cm-spicy-note"
              dom.dataset.lspNote = ""
              dom.setAttribute("role", "status")
              dom.textContent = note.text
              return { dom }
            },
          }
        : null,
    ),
})

export const noteOf = (view: EditorView) => view.state.field(noteField, false)?.text

const note = (view: EditorView, pos: number, text: string) => view.dispatch({ effects: setNote.of({ pos, text }) })

// `pos` is also where Back returns.
export async function goToDefinition(view: EditorView, pos: number, ci: CodeIntelligence) {
  const from = positionOf(view.state.doc, pos)
  const found = await ci.definition(from).catch(() => [])
  // The editor closed while the server thought.
  if (!view.dom.isConnected) return
  const inside = found.find((item) => !item.outside)
  if (inside) return ci.open(inside, from)
  const outside = found[0]
  note(
    view,
    pos,
    outside ? ci.text("outside", `${outside.file}:${outside.range.start.line + 1}`) : ci.text("noDefinition"),
  )
}

export async function findReferences(view: EditorView, pos: number, ci: CodeIntelligence) {
  const from = positionOf(view.state.doc, pos)
  const found = await ci.references(from).catch(() => [])
  if (!view.dom.isConnected) return
  if (found.length) return ci.showReferences(found, from)
  note(view, pos, ci.text("noReferences"))
}

// The hover tooltip over the word the server describes. Markdown renders after mount (code blocks highlight later),
// so the tooltip is measured again when it grows.
export async function hoverAt(view: EditorView, pos: number, ci: CodeIntelligence): Promise<Tooltip | null> {
  const hover = await ci.hover(positionOf(view.state.doc, pos)).catch(() => null)
  if (!hover || !view.dom.isConnected) return null
  const doc = view.state.doc
  return {
    pos: hover.range ? offsetOf(doc, hover.range.start) : pos,
    end: hover.range ? offsetOf(doc, hover.range.end) : pos,
    above: true,
    create: (tooltipView) => {
      const dom = document.createElement("div")
      dom.className = "cm-spicy-hover"
      dom.dataset.lspHover = ""
      const dispose = ci.render(dom, hover.markdown)
      const resize =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => tooltipView.requestMeasure())
      resize?.observe(dom)
      return {
        dom,
        destroy: () => {
          resize?.disconnect()
          dispose()
        },
      }
    },
  }
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export function codeIntelligence(ci: CodeIntelligence): Extension {
  return [
    noteField,
    hoverTooltip((view, pos) => hoverAt(view, pos, ci), { hoverTime: 350 }),
    keymap.of([
      { key: "F12", run: (view) => (void goToDefinition(view, view.state.selection.main.head, ci), true) },
      { key: "Shift-F12", run: (view) => (void findReferences(view, view.state.selection.main.head, ci), true) },
      { key: "Ctrl--", run: () => ci.back() },
      { key: "Escape", run: () => ci.dismiss() },
    ]),
    // Cmd-click on macOS, Ctrl-click elsewhere (as CodeMirror's own Mod).
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (event.button !== 0 || !(mac ? event.metaKey : event.ctrlKey)) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        event.preventDefault()
        view.dispatch({ selection: { anchor: pos } })
        void goToDefinition(view, pos, ci)
        return true
      },
    }),
    EditorView.theme({
      ".cm-spicy-hover": {
        maxWidth: "min(560px, 80vw)",
        maxHeight: "320px",
        overflow: "auto",
        padding: "6px 10px",
        fontSize: "12px",
        lineHeight: "18px",
      },
      // The chat's markdown spacing, tightened for a tooltip.
      ".cm-spicy-hover [data-component='markdown']": { fontSize: "12px", lineHeight: "18px" },
      ".cm-spicy-hover hr": { margin: "6px 0" },
      ".cm-spicy-hover h1, .cm-spicy-hover h2, .cm-spicy-hover h3": { margin: "0 0 4px", fontSize: "12px" },
      ".cm-spicy-hover p, .cm-spicy-hover ul, .cm-spicy-hover pre": { margin: "2px 0" },
      ".cm-spicy-note": { padding: "2px 8px", fontSize: "12px", color: "var(--v2-text-text-weak)" },
    }),
  ]
}
