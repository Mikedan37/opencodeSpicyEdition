// The IDE editor's code intelligence, answered by the project's language servers (client.ts lsp*): a markdown hover,
// go to definition (F12 or Mod-click), find references (Shift-F12), Back (Ctrl+-), completion as you type, rename
// (F2, recorded for review) and format (Shift+Alt+F). The view supplies the requests, navigation and the markdown
// renderer (editor-view.tsx); the editor's text reaches the servers through `createSync`. A failed request, no server
// or no answer is a quiet note at the cursor, never an error toast.
import { autocompletion, insertCompletionText, type Completion, type CompletionSource } from "@codemirror/autocomplete"
import { StateEffect, StateField, type Extension } from "@codemirror/state"
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from "@codemirror/view"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { offsetOf, positionOf, type CodePosition } from "./editor"

export type NoteKey =
  | "noDefinition"
  | "noReferences"
  | "outside"
  | "noRename"
  | "renameRefused"
  | "renameLabel"
  | "noFormatter"
  | "formatStale"

export type CodeIntelligence = {
  hover: (at: CodePosition) => Promise<Workbench.LspHover | null>
  definition: (at: CodePosition) => Promise<readonly Workbench.LspLocation[]>
  references: (at: CodePosition) => Promise<readonly Workbench.LspLocation[]>
  completion: (at: CodePosition) => Promise<Workbench.LspCompletionList>
  // Writes the rename and records it for review; rejects with the reason it was refused.
  rename: (at: CodePosition, newName: string) => Promise<Workbench.LspRename>
  // Says the rename is waiting for review. Not a note: the files changed on disk, so the editor is built again.
  renamed: (result: Workbench.LspRename) => void
  // Why a rename cannot start now (unsaved edits, no session), or undefined.
  renameBlocked: () => string | undefined
  format: (text: string, options: { tabSize: number; insertSpaces: boolean }) => Promise<Workbench.LspFormat>
  // Opens a location inside the project; `from` is the cursor before the jump, for Back.
  open: (location: Workbench.LspLocation, from: CodePosition) => void
  showReferences: (items: readonly Workbench.LspLocation[], from: CodePosition) => void
  // Closes the references list; false when none is open.
  dismiss: () => boolean
  back: () => boolean
  // Fills `dom` with the rendered markdown; returns its cleanup.
  render: (dom: HTMLElement, markdown: string) => () => void
  // The notes' and labels' text.
  text: (key: NoteKey, values?: Record<string, string>) => string
}

// The editor's text reaches the language servers `delay` ms after the last edit, and at once before a request
// (`flush`); sends run one at a time, in order.
export function createSync(send: (text?: string) => Promise<unknown>, delay = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let read: (() => string) | undefined
  let chain: Promise<unknown> = Promise.resolve()
  const queue = (text?: string) => (chain = chain.then(() => send(text)).catch(() => undefined))
  const stop = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const flush = () => {
    if (timer === undefined) return chain
    stop()
    return queue(read?.())
  }
  return {
    // `text` is read when the edit is sent.
    edit(text: () => string) {
      read = text
      clearTimeout(timer)
      timer = setTimeout(flush, delay)
    },
    flush,
    // Drops a pending edit (the buffer was discarded).
    stop,
  }
}

const setNote = StateEffect.define<{ pos: number; text: string } | null>()
// The quiet note: gone with the person's next edit or cursor move. It outlives the editor's own changes (a rename
// reloads the file), so the position is clamped rather than mapped.
const noteField = StateField.define<{ pos: number; text: string } | null>({
  create: () => null,
  update: (value, tr) =>
    tr.effects.reduce<typeof value>(
      (next, effect) => (effect.is(setNote) ? effect.value : next),
      !value || tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("select")
        ? null
        : { ...value, pos: Math.min(value.pos, tr.state.doc.length) },
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
    outside
      ? ci.text("outside", { place: `${outside.file}:${outside.range.start.line + 1}` })
      : ci.text("noDefinition"),
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

// Completion from the language servers: asked after a short pause in typing (CodeMirror drops the answer when the
// person typed on); the list is narrowed locally while the word grows, unless the server said it is incomplete.
export function completionSource(ci: CodeIntelligence): CompletionSource {
  return async (context) => {
    const word = context.matchBefore(/[\w$]+/)
    const trigger = /[.:>]/.test(context.state.sliceDoc(context.pos - 1, context.pos))
    if (!context.explicit && !word && !trigger) return null
    const list = await ci.completion(positionOf(context.state.doc, context.pos)).catch(() => undefined)
    if (!list?.items.length || context.aborted) return null
    return {
      from: word?.from ?? context.pos,
      options: list.items.map((item): Completion => {
        const text = item.insert ?? item.label
        const range = item.range
        return {
          label: item.label,
          type: item.kind,
          detail: item.detail,
          info: item.documentation ? () => markdownInfo(item.documentation!, ci) : undefined,
          apply: range
            ? (view, _completion, _from, to) =>
                view.dispatch(insertCompletionText(view.state, text, offsetOf(view.state.doc, range.start), to))
            : text,
        }
      }),
      validFor: list.incomplete ? undefined : /^[\w$]*$/,
    }
  }
}

function markdownInfo(markdown: string, ci: CodeIntelligence) {
  const dom = document.createElement("div")
  dom.className = "cm-spicy-hover"
  return { dom, destroy: ci.render(dom, markdown) }
}

// F2: a box over the word asks for the new name. Enter renames, Escape or leaving it cancels.
export function codeRename(ci: CodeIntelligence) {
  const setRename = StateEffect.define<{ pos: number; name: string } | null>()
  const field = StateField.define<{ pos: number; name: string } | null>({
    create: () => null,
    update: (value, tr) =>
      tr.effects.reduce<typeof value>(
        (next, effect) => (effect.is(setRename) ? effect.value : next),
        tr.docChanged ? null : value,
      ),
    provide: (self) =>
      showTooltip.from(self, (open): Tooltip | null =>
        open
          ? {
              pos: open.pos,
              above: true,
              create: (view) => {
                const dom = document.createElement("div")
                dom.className = "cm-spicy-rename"
                const input = document.createElement("input")
                input.value = open.name
                input.spellcheck = false
                input.dataset.lspRename = ""
                input.setAttribute("aria-label", ci.text("renameLabel", { name: open.name }))
                const close = () => {
                  if (view.state.field(self, false)) view.dispatch({ effects: setRename.of(null) })
                }
                input.addEventListener("keydown", (event) => {
                  if (event.key !== "Enter" && event.key !== "Escape") return
                  event.preventDefault()
                  const next = input.value.trim()
                  close()
                  view.focus()
                  if (event.key === "Enter" && next && next !== open.name) void submitRename(view, open.pos, next, ci)
                })
                input.addEventListener("blur", close)
                dom.append(input)
                return {
                  dom,
                  mount: () => {
                    input.focus()
                    input.select()
                  },
                }
              },
            }
          : null,
      ),
  })
  const start = (view: EditorView) => {
    const head = view.state.selection.main.head
    const blocked = ci.renameBlocked()
    if (blocked) return note(view, head, blocked)
    const word = view.state.wordAt(head)
    if (!word) return note(view, head, ci.text("noRename"))
    view.dispatch({ effects: setRename.of({ pos: word.from, name: view.state.sliceDoc(word.from, word.to) }) })
  }
  return { field, start }
}

export async function submitRename(view: EditorView, pos: number, newName: string, ci: CodeIntelligence) {
  const result = await ci.rename(positionOf(view.state.doc, pos), newName).then(
    (value) => value,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  if (typeof result !== "string" && result.files.length) return ci.renamed(result)
  if (!view.dom.isConnected) return
  note(view, pos, typeof result === "string" ? ci.text("renameRefused", { reason: result }) : ci.text("noRename"))
}

// Shift+Alt+F: the servers' edits, or the formatter's whole text as one change, applied as one undoable step, when
// the text is still what was sent.
export async function formatDocument(view: EditorView, ci: CodeIntelligence) {
  const doc = view.state.doc
  const text = doc.toString()
  const result = await ci.format(text, indentOf(text)).catch(() => undefined)
  if (!view.dom.isConnected) return
  const head = view.state.selection.main.head
  if (!view.state.doc.eq(doc)) return note(view, head, ci.text("formatStale"))
  if (result?.edits)
    return view.dispatch({
      changes: result.edits.map((edit) => ({
        from: offsetOf(doc, edit.range.start),
        to: offsetOf(doc, edit.range.end),
        insert: edit.newText,
      })),
      userEvent: "format",
    })
  if (result?.text === undefined) return note(view, head, ci.text("noFormatter"))
  // One change over the part that differs, so the cursor and the rest of the text stay put.
  const next = result.text
  let start = 0
  while (start < text.length && start < next.length && text[start] === next[start]) start++
  if (start === text.length && start === next.length) return
  let end = 0
  while (
    end < text.length - start &&
    end < next.length - start &&
    text[text.length - 1 - end] === next[next.length - 1 - end]
  )
    end++
  view.dispatch({
    changes: { from: start, to: text.length - end, insert: next.slice(start, next.length - end) },
    userEvent: "format",
  })
}

// ponytail: indentation guessed from the text (tabs, else the smallest space indent); an editorconfig reader would
// replace it.
export function indentOf(text: string) {
  const indents = text.match(/^[ \t]+(?=\S)/gm) ?? []
  if (indents.some((indent) => indent.includes("\t"))) return { tabSize: 4, insertSpaces: false }
  const smallest = Math.min(...indents.map((indent) => indent.length))
  return { tabSize: smallest >= 1 && smallest <= 8 ? smallest : 2, insertSpaces: true }
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export function codeIntelligence(ci: CodeIntelligence): Extension {
  const rename = codeRename(ci)
  return [
    noteField,
    rename.field,
    hoverTooltip((view, pos) => hoverAt(view, pos, ci), { hoverTime: 350 }),
    autocompletion({ override: [completionSource(ci)], activateOnTypingDelay: 150 }),
    keymap.of([
      { key: "F12", run: (view) => (void goToDefinition(view, view.state.selection.main.head, ci), true) },
      { key: "Shift-F12", run: (view) => (void findReferences(view, view.state.selection.main.head, ci), true) },
      { key: "Ctrl--", run: () => ci.back() },
      { key: "Escape", run: () => ci.dismiss() },
      { key: "F2", run: (view) => (rename.start(view), true) },
      { key: "Shift-Alt-f", run: (view) => (void formatDocument(view, ci), true) },
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
      ".cm-spicy-rename input": {
        width: "220px",
        padding: "2px 6px",
        font: "inherit",
        fontFamily: "var(--font-family-mono)",
        color: "var(--v2-text-text-base)",
        background: "var(--v2-background-bg-base)",
        border: "none",
        outline: "none",
      },
    }),
  ]
}
