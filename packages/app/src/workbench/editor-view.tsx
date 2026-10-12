import { createEffect, createSignal, Match, on, onCleanup, onMount, Show, Switch, untrack, type JSX } from "solid-js"
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  gutter,
  GutterMarker,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  showTooltip,
  WidgetType,
  type BlockInfo,
  type DecorationSet,
  type Tooltip,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { openSearchPanel, search, searchKeymap } from "@codemirror/search"
import { forEachDiagnostic, lintKeymap, setDiagnostics } from "@codemirror/lint"
import { tags } from "@lezer/highlight"
import type { Workbench } from "@opencode-ai/schema/workbench"
import type { FileSearchControl } from "@opencode-ai/session-ui/file"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { useDebug } from "./debug-context"
import {
  diagnosticsFor,
  glyphFor,
  languageOf,
  lineSeparator,
  type BreakpointMark,
  type GlyphKind,
  type LanguageKey,
} from "./editor"
import { useEditor } from "./editor-context"
import { useWorkbench } from "./panel"

// Language support loads with the first file of its kind.
const LANGUAGES: Record<LanguageKey, () => Promise<Extension>> = {
  ts: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ typescript: true, jsx: true })),
  js: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((mod) => mod.javascript({ jsx: true })),
  python: () => import("@codemirror/lang-python").then((mod) => mod.python()),
  rust: () => import("@codemirror/lang-rust").then((mod) => mod.rust()),
  cpp: () => import("@codemirror/lang-cpp").then((mod) => mod.cpp()),
  go: () => import("@codemirror/lang-go").then((mod) => mod.go()),
  json: () => import("@codemirror/lang-json").then((mod) => mod.json()),
  markdown: () => import("@codemirror/lang-markdown").then((mod) => mod.markdown()),
  swift: () =>
    Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/swift")]).then(
      ([language, mode]) => language.StreamLanguage.define(mode.swift),
    ),
}

// The app's syntax tokens (ui theme.css), so the editor reads like the viewer in light and dark.
const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: "var(--syntax-comment)" },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
      tags.modifier,
      tags.self,
    ],
    color: "var(--syntax-keyword)",
  },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syntax-primitive)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--syntax-property)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    color: "var(--syntax-primitive)",
  },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "var(--syntax-constant)" },
  { tag: tags.regexp, color: "var(--syntax-regexp)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: "var(--syntax-punctuation)" },
  { tag: tags.heading, color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--syntax-primitive)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--syntax-critical)" },
])

const PAUSED = "rgb(from var(--v2-state-fg-warning) r g b / 0.18)"
const SELECTED = "rgb(from var(--v2-border-border-focus) r g b / 0.12)"
const GLYPH_COLOR: Record<GlyphKind, string> = {
  line: "var(--v2-state-fg-danger)",
  condition: "var(--v2-state-fg-warning)",
  log: "var(--v2-state-fg-warning)",
  unverified: "var(--v2-state-fg-danger)",
  error: "var(--v2-state-fg-danger)",
  warning: "var(--v2-state-fg-warning)",
  info: "var(--v2-state-fg-info)",
  hint: "var(--v2-text-text-faint)",
}

// Font, size and line height of the read-only viewer (session-ui pierre styleVariables).
const THEME = EditorView.theme({
  "&": { color: "var(--v2-text-text-base)", backgroundColor: "transparent", fontSize: "var(--font-size-small)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-family-mono)",
    fontFeatureSettings: "var(--font-family-mono--font-feature-settings)",
    lineHeight: "24px",
  },
  ".cm-content": { caretColor: "var(--v2-text-text-base)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--v2-text-text-base)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgb(from var(--v2-border-border-focus) r g b / 0.28)",
  },
  ".cm-activeLine": { backgroundColor: "rgb(from var(--v2-text-text-base) r g b / 0.04)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--v2-text-text-faint)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--v2-text-text-muted)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 2px", minWidth: "3ch", cursor: "pointer" },
  ".cm-spicy-glyphs .cm-gutterElement": { width: "16px", cursor: "pointer", display: "flex", alignItems: "center" },
  ".cm-spicy-glyph": { display: "inline-block", margin: "0 auto" },
  ...Object.fromEntries(
    (["line", "condition", "log"] as const).map((kind) => [
      `.cm-spicy-glyph-${kind}`,
      { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: GLYPH_COLOR[kind] },
    ]),
  ),
  ".cm-spicy-glyph-unverified": {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    boxShadow: `inset 0 0 0 1.5px ${GLYPH_COLOR.unverified}`,
  },
  ...Object.fromEntries(
    (["error", "warning", "info", "hint"] as const).map((kind) => [
      `.cm-spicy-glyph-${kind}`,
      { width: "3px", height: "12px", borderRadius: "1px", backgroundColor: GLYPH_COLOR[kind] },
    ]),
  ),
  ".cm-spicy-exec": { backgroundColor: PAUSED },
  ".cm-gutterElement.cm-spicy-exec-gutter": {
    backgroundColor: PAUSED,
    color: "var(--v2-state-fg-warning)",
  },
  ".cm-lineNumbers .cm-gutterElement.cm-spicy-exec-gutter": { boxShadow: "inset 3px 0 0 var(--v2-state-fg-warning)" },
  ".cm-spicy-selected": { backgroundColor: SELECTED },
  ".cm-spicy-commented": { boxShadow: "inset 2px 0 0 var(--v2-border-border-focus)" },
  ".cm-spicy-values": {
    padding: "0 12px",
    fontSize: "11px",
    lineHeight: "20px",
    color: "var(--v2-state-fg-warning)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "rgb(from var(--v2-border-border-focus) r g b / 0.2)",
    outline: "1px solid rgb(from var(--v2-border-border-focus) r g b / 0.5)",
  },
  ".cm-panels": {
    backgroundColor: "var(--v2-background-bg-base)",
    color: "var(--v2-text-text-base)",
    fontFamily: "var(--font-family-sans)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--v2-border-border-muted)" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px" },
  ".cm-panel.cm-search label": { fontSize: "12px", color: "var(--v2-text-text-muted)" },
  ".cm-textfield": {
    fontSize: "12px",
    padding: "2px 6px",
    border: "1px solid var(--v2-border-border-muted)",
    borderRadius: "4px",
    backgroundColor: "var(--v2-background-bg-base)",
    color: "var(--v2-text-text-base)",
  },
  ".cm-textfield:focus": { outline: "none", borderColor: "var(--v2-border-border-focus)" },
  ".cm-button": {
    fontSize: "12px",
    padding: "2px 8px",
    backgroundImage: "none",
    backgroundColor: "var(--v2-background-bg-layer-01)",
    border: "1px solid var(--v2-border-border-muted)",
    borderRadius: "4px",
    color: "var(--v2-text-text-base)",
  },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--v2-background-bg-layer-02)" },
  ".cm-searchMatch": { backgroundColor: "rgb(from var(--v2-state-fg-warning) r g b / 0.22)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(from var(--v2-state-fg-warning) r g b / 0.45)" },
  ".cm-tooltip": {
    backgroundColor: "var(--v2-background-bg-base)",
    color: "var(--v2-text-text-base)",
    border: "1px solid var(--v2-border-border-muted)",
    borderRadius: "6px",
    fontFamily: "var(--font-family-sans)",
    fontSize: "12px",
  },
  ".cm-spicy-comment": {
    display: "block",
    padding: "2px 8px",
    font: "inherit",
    color: "var(--v2-text-text-base)",
    cursor: "pointer",
  },
})

// ---------------------------------------------------------------- debugger and comment decorations

type Marks = { breakpoints: Map<number, BreakpointMark>; exec?: number; values?: string }
const setMarks = StateEffect.define<Marks>()
const marksField = StateField.define<Marks>({
  create: () => ({ breakpoints: new Map() }),
  update: (value, tr) => tr.effects.reduce((next, effect) => (effect.is(setMarks) ? effect.value : next), value),
})

class GlyphMarker extends GutterMarker {
  constructor(
    readonly kind: GlyphKind,
    readonly line: number,
  ) {
    super()
  }
  override eq(other: GlyphMarker) {
    return other.kind === this.kind && other.line === this.line
  }
  override toDOM() {
    const node = document.createElement("span")
    node.className = `cm-spicy-glyph cm-spicy-glyph-${this.kind}`
    node.dataset.spicyGlyph = this.kind
    node.dataset.line = String(this.line)
    if (this.kind === "line" || this.kind === "condition" || this.kind === "log" || this.kind === "unverified")
      node.dataset.spicyBreakpoint = this.kind
    return node
  }
}

// Severities by line, once per state.
const severities = new WeakMap<EditorState, Map<number, Workbench.Severity[]>>()
function lineSeverities(state: EditorState) {
  const cached = severities.get(state)
  if (cached) return cached
  const map = new Map<number, Workbench.Severity[]>()
  forEachDiagnostic(state, (diagnostic, from) => {
    const line = state.doc.lineAt(from).number
    map.set(line, [...(map.get(line) ?? []), diagnostic.severity])
  })
  severities.set(state, map)
  return map
}

// Keeps the glyph column's width before the first mark.
const spacer = new (class extends GutterMarker {
  override toDOM() {
    const node = document.createElement("span")
    node.className = "cm-spicy-glyph cm-spicy-glyph-line"
    return node
  }
})()

const execGutterMarker = new (class extends GutterMarker {
  override elementClass = "cm-spicy-exec-gutter"
})()

class ValuesWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  override eq(other: ValuesWidget) {
    return other.text === this.text
  }
  override toDOM() {
    const row = document.createElement("div")
    row.className = "cm-spicy-values"
    row.dataset.debugValues = ""
    row.textContent = this.text
    row.title = this.text
    return row
  }
}

const execDecorations = EditorView.decorations.compute([marksField], (state) => {
  const { exec, values } = state.field(marksField)
  if (!exec || exec > state.doc.lines) return Decoration.none
  const line = state.doc.line(exec)
  const ranges = [
    Decoration.line({ class: "cm-spicy-exec", attributes: { "data-spicy-exec": "", "data-line": String(exec) } }).range(
      line.from,
    ),
  ]
  if (values) ranges.push(Decoration.widget({ widget: new ValuesWidget(values), block: true, side: 1 }).range(line.to))
  return Decoration.set(ranges)
})

const execGutter = gutterLineClass.compute([marksField], (state) => {
  const exec = state.field(marksField).exec
  if (!exec || exec > state.doc.lines) return RangeSet.empty
  return RangeSet.of([execGutterMarker.range(state.doc.line(exec).from)])
})

// Comment boxes and the comment draft (upstream's line comment controller renders them) as block widgets under
// their line. The controller owns each element; the editor only places it.
const resizes = new WeakMap<HTMLElement, ResizeObserver>()
class HostWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super()
  }
  override eq(other: HostWidget) {
    return other.host === this.host
  }
  override toDOM(view: EditorView) {
    // A draft grows as the user types; the editor measures block widgets only when told.
    resizes.get(this.host)?.disconnect()
    const observer = new ResizeObserver(() => view.requestMeasure())
    observer.observe(this.host)
    resizes.set(this.host, observer)
    return this.host
  }
  override destroy(dom: HTMLElement) {
    resizes.get(dom)?.disconnect()
    resizes.delete(dom)
  }
  override ignoreEvent() {
    return true
  }
}

const decorationField = () => {
  const set = StateEffect.define<DecorationSet>()
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (value, tr) =>
      tr.effects.reduce((next, effect) => (effect.is(set) ? effect.value : next), value.map(tr.changes)),
    provide: (self) => EditorView.decorations.from(self),
  })
  return { set, field }
}
const annotationsField = decorationField()
const linesField = decorationField()

function lineDecorations(
  state: EditorState,
  selected: SelectedLineRange | null | undefined,
  commented: readonly SelectedLineRange[],
) {
  const ranges: ReturnType<Decoration["range"]>[] = []
  const add = (range: SelectedLineRange, className: string) => {
    const first = Math.max(1, Math.min(range.start, range.end))
    const last = Math.min(state.doc.lines, Math.max(range.start, range.end))
    for (let line = first; line <= last; line++)
      ranges.push(Decoration.line({ class: className }).range(state.doc.line(line).from))
  }
  for (const range of commented) add(range, "cm-spicy-commented")
  if (selected) add(selected, "cm-spicy-selected")
  return Decoration.set(ranges, true)
}

// The lines a selection covers; a selection that ends at the start of a line does not include it.
function selectedRange(state: EditorState): SelectedLineRange | undefined {
  const range = state.selection.main
  if (range.empty) return
  const end = state.doc.lineAt(range.to)
  return {
    start: state.doc.lineAt(range.from).number,
    end: end.from === range.to && range.to > range.from ? end.number - 1 : end.number,
  }
}

// ---------------------------------------------------------------- the editor

type Annotation = { lineNumber: number; metadata?: unknown }

// The file view renders its viewer again when the file changes on disk (a save does that too); the new editor takes
// the old one's state, and its focus.
let refocus: string | undefined

export type EditorViewProps = {
  path: string
  // The viewer's (trimmed) text of the file: it changes when the file changes on disk.
  contents: string
  annotations?: readonly Annotation[]
  renderAnnotation?: (annotation: Annotation) => HTMLElement | undefined
  selectedLines?: SelectedLineRange | null
  commentedLines?: readonly SelectedLineRange[]
  onLineSelectionEnd?: (range: SelectedLineRange | null) => void
  search?: FileSearchControl
  onRendered?: () => void
  // The read-only viewer, for a file the server does not open for editing.
  fallback: () => JSX.Element
}

export default function EditorPane(props: EditorViewProps) {
  const editor = useEditor()
  const language = useLanguage()
  const path = untrack(() => props.path)
  const buffer = () => editor.store.state.files[path]
  void editor.store.load(path)
  return (
    <Switch fallback={<div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>}>
      <Match when={buffer()?.base}>
        <Editor {...props} path={path} />
      </Match>
      {/* No editor route on this server, or a file it does not edit (outside the project, not UTF-8): read-only. */}
      <Match when={buffer()?.status === "unavailable" || buffer()?.status === "failed"}>{props.fallback()}</Match>
    </Switch>
  )
}

function Editor(props: EditorViewProps) {
  const editor = useEditor()
  const debug = useDebug()
  const workbench = useWorkbench()
  const language = useLanguage()
  const theme = useTheme()
  const file = useFile()
  const { tabs } = useSessionLayout()
  const path = props.path
  const name = getFilename(path)
  const buffer = () => editor.store.state.files[path]
  const [view, setView] = createSignal<EditorView>()
  // Bumped when the document is replaced wholesale (Reload), so the decorations are placed again.
  const [epoch, setEpoch] = createSignal(0)
  const languageCompartment = new Compartment()
  const darkCompartment = new Compartment()
  let host!: HTMLDivElement
  let base = Text.empty

  const setBase = (text: string, separator: string) => {
    base = Text.of(text.split(separator))
  }
  const dark = () => EditorView.darkTheme.of(theme.mode() === "dark")

  const save = async () => {
    const current = view()
    if (current) await editor.save(path, current.state.sliceDoc())
  }

  const toggleBreakpoint = (state: EditorState, block: BlockInfo) => {
    void debug.toggleBreakpoint(path, state.doc.lineAt(block.from).number).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("workbench.debug.failed.breakpoints"),
        description: errorText(error),
      }),
    )
    return true
  }
  const gutterClick = {
    mousedown: (view: EditorView, block: BlockInfo, event: Event) =>
      (event as MouseEvent).button === 0 && toggleBreakpoint(view.state, block),
  }

  // A non-empty selection offers to comment on its lines (upstream's comment draft), since a gutter click now sets a
  // breakpoint.
  const commentTooltip = StateField.define<readonly Tooltip[]>({
    create: (state) => commentTooltips(state),
    // Not for a match the search selected.
    update: (value, tr) =>
      tr.isUserEvent("select.search") ? [] : tr.docChanged || tr.selection ? commentTooltips(tr.state) : value,
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
  })
  function commentTooltips(state: EditorState): readonly Tooltip[] {
    const range = selectedRange(state)
    if (!range || !props.onLineSelectionEnd) return []
    return [
      {
        pos: state.selection.main.head,
        above: true,
        create: (editorView) => {
          const dom = document.createElement("div")
          const button = document.createElement("button")
          button.type = "button"
          button.className = "cm-spicy-comment"
          button.dataset.action = "comment"
          button.textContent = language.t("workbench.editor.comment")
          button.addEventListener("mousedown", (event) => event.preventDefault())
          button.addEventListener("click", () => {
            editorView.dispatch({ selection: EditorSelection.cursor(editorView.state.selection.main.head) })
            props.onLineSelectionEnd?.(range)
          })
          dom.append(button)
          return { dom }
        },
      },
    ]
  }

  const extensions = (separator: string): Extension => [
    EditorState.lineSeparator.of(separator),
    marksField,
    annotationsField.field,
    linesField.field,
    gutter({
      class: "cm-spicy-glyphs",
      lineMarker: (current, block) => {
        const line = current.state.doc.lineAt(block.from).number
        const kind = glyphFor(
          current.state.field(marksField).breakpoints.get(line),
          lineSeverities(current.state).get(line) ?? [],
        )
        return kind ? new GlyphMarker(kind, line) : null
      },
      lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.length > 0),
      initialSpacer: () => spacer,
      domEventHandlers: gutterClick,
    }),
    lineNumbers({ domEventHandlers: gutterClick }),
    execGutter,
    execDecorations,
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(HIGHLIGHT),
    languageCompartment.of([]),
    darkCompartment.of(dark()),
    search({ top: true }),
    commentTooltip,
    THEME,
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (void save(), true) },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    EditorView.contentAttributes.of({ "aria-label": language.t("workbench.editor.label", { file: name }) }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      const dirty = !update.state.doc.eq(base)
      // Editing a preview tab keeps it open, like any edited file.
      if (dirty && !editor.store.dirty(path)) void tabs().open(file.tab(path))
      editor.store.setDirty(path, dirty)
    }),
  ]

  // A new view of a file this editor showed before takes over its state (text, selection, undo history); the
  // extensions are rebuilt, so nothing of the old view's component stays.
  const create = () => {
    const text = buffer()!.base!.text
    const saved = editor.store.saved.get(path)
    const separator = saved?.lineBreak ?? lineSeparator(text)
    setBase(text, separator)
    const state = saved
      ? saved.update({ effects: StateEffect.reconfigure.of(extensions(separator)) }).state
      : EditorState.create({ doc: text, extensions: extensions(separator) })
    return new EditorView({ state, parent: host })
  }

  // Reload from disk: the file's text replaces the editor's, edits included (the user chose it).
  // One undoable change, so Undo brings the edits back.
  const reload = async () => {
    await editor.store.load(path, true)
    const current = view()
    const text = buffer()?.base?.text
    if (!current || text === undefined) return
    // The file could not be read again (deleted, unreadable): the editor keeps its text.
    if (buffer()?.status !== "ready")
      return showToast({
        variant: "error",
        title: language.t("workbench.editor.reloadFailed", { file: name }),
        description: buffer()?.error,
      })
    setBase(text, current.state.lineBreak)
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: text },
      selection: { anchor: Math.min(current.state.selection.main.head, text.length) },
    })
    setEpoch((value) => value + 1)
  }

  const overwrite = async () => {
    const choice = await editor.ask({
      title: language.t("workbench.editor.overwrite.title", { file: name }),
      description: language.t("workbench.editor.overwrite.description"),
      choices: [
        { id: "cancel", label: language.t("common.cancel"), variant: "ghost" },
        { id: "overwrite", label: language.t("workbench.editor.overwrite"), variant: "danger" },
      ],
    })
    const current = view()
    if (choice !== "overwrite" || !current) return
    await editor.store.overwrite(path, current.state.sliceDoc()).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("workbench.editor.saveFailed", { file: name }),
        description: errorText(error),
      }),
    )
  }

  let alive = true
  const languageLoad = (current: EditorView) => {
    const key = languageOf(path)
    if (!key) return
    void LANGUAGES[key]().then(
      (extension) => alive && current.dispatch({ effects: languageCompartment.reconfigure(extension) }),
      () => undefined,
    )
  }

  // The file changed on disk and the editor has nothing unsaved: show the new text. Unsaved edits stay; their save
  // is refused with a conflict instead.
  const followDisk = () => {
    const current = buffer()
    if (!current?.base || current.dirty || current.saving) return
    if (props.contents.trim() === current.base.text.trim()) return
    void reload()
  }

  onMount(() => {
    const current = create()
    setView(current)
    languageLoad(current)
    editor.store.live.set(path, () => current.state.sliceDoc())
    // F9 toggles a breakpoint on the cursor's line while the editor has focus (else on the paused line).
    const cursorLine = () =>
      current.hasFocus ? current.state.doc.lineAt(current.state.selection.main.head).number : undefined
    debug.viewers.set(path, cursorLine)
    props.search?.register({ focus: () => openSearchPanel(current) })
    props.onRendered?.()
    if (refocus === path) current.focus()
    refocus = undefined
    followDisk()
    onCleanup(() => {
      props.search?.register(null)
      if (debug.viewers.get(path) === cursorLine) debug.viewers.delete(path)
      if (editor.store.live.get(path)) editor.store.live.delete(path)
      // Kept while the file has a buffer (a tab switch or a re-render); closing the tab drops it.
      if (editor.store.state.files[path]) editor.store.saved.set(path, current.state)
      if (current.hasFocus) refocus = path
      alive = false
      current.destroy()
    })
  })

  createEffect(on(() => props.contents, followDisk, { defer: true }))

  // A save or a reload moved the base: the editor is dirty only where it differs from it.
  createEffect(
    on(
      () => buffer()?.base,
      (next) => {
        const current = view()
        if (!next || !current) return
        setBase(next.text, current.state.lineBreak)
        editor.store.setDirty(path, !current.state.doc.eq(base))
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const dark = theme.mode() === "dark"
    view()?.dispatch({ effects: darkCompartment.reconfigure(EditorView.darkTheme.of(dark)) })
  })

  // Problems of this file as lint diagnostics (underlines, hover messages, gutter glyphs).
  createEffect(() => {
    const current = view()
    if (!current) return
    epoch()
    const own = (workbench.problems.state.snapshot?.problems ?? []).filter(
      (problem) => problem.file && file.normalize(problem.file) === path,
    )
    current.dispatch(setDiagnostics(current.state, diagnosticsFor(own, current.state.doc)))
  })

  // The debugger: breakpoints, the selected frame's line, and the top frame's values under it.
  const exec = () => {
    const session = debug.selected()
    const stop = session?.state === "stopped" ? session.stop : undefined
    const frame = stop?.frames.find((item) => item.id === debug.frameID())
    if (!stop || !frame?.file || !frame.line || (debug.relative(frame.file) ?? frame.file) !== path) return
    return { line: frame.line, top: frame.id === stop.frames[0]?.id, locals: stop.locals }
  }
  createEffect(() => {
    const current = view()
    if (!current) return
    epoch()
    const verified = debug.verified(path)
    const breakpoints = new Map(
      debug.breakpoints(path).map((item): [number, BreakpointMark] => [
        item.line,
        {
          line: item.line,
          kind: item.logMessage ? "log" : item.condition || item.hitCondition ? "condition" : "line",
          verified: verified?.find((entry) => entry.line === item.line)?.verified !== false,
        },
      ]),
    )
    const paused = exec()
    const doc = current.state.doc
    const words =
      paused?.top && paused.line <= doc.lines
        ? new Set(doc.line(paused.line).text.match(/[A-Za-z_$][\w$]*/g))
        : new Set<string>()
    const shown = paused?.top ? paused.locals.filter((item) => words.has(item.name)).slice(0, 6) : []
    const values = shown
      .map((item) => `${item.name} = ${item.value.length > 40 ? `${item.value.slice(0, 40)}…` : item.value}`)
      .join("   ")
    current.dispatch({ effects: setMarks.of({ breakpoints, exec: paused?.line, values: values || undefined }) })
  })
  createEffect(
    on(
      () => [view(), exec()?.line] as const,
      ([current, line]) => {
        if (!current || !line || line > current.state.doc.lines) return
        current.dispatch({
          effects: EditorView.scrollIntoView(current.state.doc.line(line).from, { y: "nearest", yMargin: 96 }),
        })
      },
    ),
  )

  // Comments: highlighted lines, and the boxes and draft under their lines.
  createEffect(() => {
    const current = view()
    if (!current) return
    epoch()
    current.dispatch({
      effects: linesField.set.of(lineDecorations(current.state, props.selectedLines, props.commentedLines ?? [])),
    })
  })
  createEffect(
    on(
      () => [view(), props.selectedLines] as const,
      ([current, range]) => {
        if (!current || !range) return
        const line = Math.min(Math.max(1, Math.min(range.start, range.end)), current.state.doc.lines)
        current.dispatch({
          effects: EditorView.scrollIntoView(current.state.doc.line(line).from, { y: "nearest", yMargin: 96 }),
        })
      },
    ),
  )
  createEffect(() => {
    const current = view()
    if (!current) return
    epoch()
    const doc = current.state.doc
    const ranges = (props.annotations ?? []).flatMap((annotation) => {
      const element = props.renderAnnotation?.(annotation)
      if (!element || annotation.lineNumber < 1 || annotation.lineNumber > doc.lines) return []
      return [
        Decoration.widget({ widget: new HostWidget(element), block: true, side: 2 }).range(
          doc.line(annotation.lineNumber).to,
        ),
      ]
    })
    current.dispatch({ effects: annotationsField.set.of(Decoration.set(ranges, true)) })
  })

  return (
    <div data-component="workbench-editor" data-path={path} class="relative">
      <Show when={buffer()?.conflict}>
        <div
          data-slot="editor-conflict"
          class="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-base px-3 py-1.5 text-[12px] text-v2-text-text-base"
        >
          <span class="min-w-0 flex-1">{language.t("workbench.editor.conflict", { file: name })}</span>
          <ButtonV2
            size="small"
            variant="neutral"
            data-action="reload"
            class="shrink-0 whitespace-nowrap"
            onClick={() => void reload()}
          >
            {language.t("workbench.editor.reload")}
          </ButtonV2>
          <ButtonV2
            size="small"
            variant="ghost"
            data-action="overwrite"
            class="shrink-0 whitespace-nowrap"
            onClick={() => void overwrite()}
          >
            {language.t("workbench.editor.overwrite")}
          </ButtonV2>
        </div>
      </Show>
      <div ref={host} />
    </div>
  )
}
