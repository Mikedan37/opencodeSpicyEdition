import {
  createEffect,
  createSignal,
  For,
  getOwner,
  Match,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { render } from "solid-js/web"
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
  tooltips,
  WidgetType,
  type BlockInfo,
  type DecorationSet,
  type Tooltip,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { openSearchPanel, search, searchKeymap } from "@codemirror/search"
import { forEachDiagnostic, lintKeymap, setDiagnostics } from "@codemirror/lint"
import type { Workbench } from "@opencode-ai/schema/workbench"
import type { FileSearchControl } from "@opencode-ai/session-ui/file"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { HIGHLIGHT, loadLanguage, THEME } from "./codemirror"
import { stopException } from "./debug"
import { useDebug } from "./debug-context"
import {
  diagnosticsFor,
  glyphFor,
  lineSeparator,
  offsetOf,
  type BreakpointMark,
  type CodePosition,
  type GlyphKind,
  type Spot,
} from "./editor"
import { useEditor } from "./editor-context"
import { codeIntelligence, type CodeIntelligence } from "./editor-lsp"
import { useFileLineOpener } from "./open-file"
import { useWorkbench } from "./panel"

// ---------------------------------------------------------------- debugger and comment decorations

type Marks = { breakpoints: Map<number, BreakpointMark>; exec?: number; values?: string; exception?: string }
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
const exceptionGutterMarker = new (class extends GutterMarker {
  override elementClass = "cm-spicy-exec-gutter cm-spicy-exec-exception"
})()

// A row under the paused line: the exception it stopped on (red), or the top frame's values.
class NoteWidget extends WidgetType {
  constructor(
    readonly kind: "values" | "exception",
    readonly text: string,
  ) {
    super()
  }
  override eq(other: NoteWidget) {
    return other.kind === this.kind && other.text === this.text
  }
  override toDOM() {
    const row = document.createElement("div")
    row.className = `cm-spicy-${this.kind}`
    row.dataset[this.kind === "values" ? "debugValues" : "debugException"] = ""
    row.textContent = this.text
    row.title = this.text
    return row
  }
}

const execDecorations = EditorView.decorations.compute([marksField], (state) => {
  const { exec, values, exception } = state.field(marksField)
  if (!exec || exec > state.doc.lines) return Decoration.none
  const line = state.doc.line(exec)
  const ranges = [
    Decoration.line({
      class: exception ? "cm-spicy-exec cm-spicy-exec-exception" : "cm-spicy-exec",
      attributes: { "data-spicy-exec": "", "data-line": String(exec) },
    }).range(line.from),
  ]
  if (exception)
    ranges.push(
      Decoration.widget({ widget: new NoteWidget("exception", exception), block: true, side: 1 }).range(line.to),
    )
  if (values)
    ranges.push(Decoration.widget({ widget: new NoteWidget("values", values), block: true, side: 2 }).range(line.to))
  return Decoration.set(ranges)
})

const execGutter = gutterLineClass.compute([marksField], (state) => {
  const { exec, exception } = state.field(marksField)
  if (!exec || exec > state.doc.lines) return RangeSet.empty
  return RangeSet.of([(exception ? exceptionGutterMarker : execGutterMarker).range(state.doc.line(exec).from)])
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
  const openLine = useFileLineOpener()
  const owner = getOwner()
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

  // Code intelligence. A jump remembers where it started (Back); another file opens in its tab, and its editor puts
  // the cursor on the spot when it mounts (or at once when it already shows).
  const [references, setReferences] = createSignal<{
    items: readonly Workbench.LspLocation[]
    from: CodePosition
  }>()
  const jump = (target: Spot) => {
    if (target.path === path) return editor.store.reveal(path, target)
    openLine(target.path, target.line + 1, false)
    requestAnimationFrame(() => editor.store.reveal(target.path, target))
  }
  const go = (location: Workbench.LspLocation, from: CodePosition) => {
    editor.store.remember({ path, ...from })
    jump({ path: file.normalize(location.file), ...location.range.start })
  }
  const intelligence: CodeIntelligence = {
    hover: (at) => workbench.client.lspHover(path, at),
    definition: (at) => workbench.client.lspDefinition(path, at),
    references: (at) => workbench.client.lspReferences(path, at),
    open: go,
    showReferences: (items, from) => setReferences({ items, from }),
    dismiss: () => {
      if (!references()) return false
      setReferences(undefined)
      return true
    },
    back: () => {
      const spot = editor.store.back()
      if (spot) jump(spot)
      return !!spot
    },
    render: (dom, markdown) =>
      runWithOwner(owner, () => render(() => <Markdown text={markdown} class="select-text text-[12px]" />, dom)) ??
      (() => {}),
    text: (key, place) => language.t(`workbench.editor.lsp.${key}`, { place: place ?? "" }),
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
    codeIntelligence(intelligence),
    // Tooltips (hover, lint, comment) live in the page, so the side panel's edge does not cut them.
    tooltips({ parent: document.body }),
    THEME,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...lintKeymap, indentWithTab]),
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
  const languageLoad = (current: EditorView) =>
    void loadLanguage(path).then(
      (extension) => alive && extension && current.dispatch({ effects: languageCompartment.reconfigure(extension) }),
    )

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
    const show = (at: CodePosition) => {
      const pos = offsetOf(current.state.doc, at)
      current.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) })
      current.focus()
    }
    editor.store.showing.set(path, show)
    const target = editor.store.targets.get(path)
    editor.store.targets.delete(path)
    // After this editor's own first scroll (a selected line).
    if (target) queueMicrotask(() => alive && show(target))
    onCleanup(() => {
      if (editor.store.showing.get(path) === show) editor.store.showing.delete(path)
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
    const byID = new Map(own.map((problem) => [problem.id, problem]))
    // UX #10: the hover tooltip offers Fix with agent for the problem it shows.
    const fix = language.t("workbench.handoff.fixShort")
    current.dispatch(
      setDiagnostics(
        current.state,
        diagnosticsFor(own, current.state.doc).map((item) => ({
          ...item,
          actions: [
            {
              name: fix,
              apply: () => {
                const problem = byID.get(item.id)
                if (problem) workbench.fixProblems([problem], problem.file)
              },
            },
          ],
        })),
      ),
    )
  })

  // The debugger: breakpoints, the selected frame's line, and the top frame's values under it.
  const exec = () => {
    const session = debug.selected()
    const stop = session?.state === "stopped" ? session.stop : undefined
    const frame = stop?.frames.find((item) => item.id === debug.frameID())
    if (!stop || !frame?.file || !frame.line || (debug.relative(frame.file) ?? frame.file) !== path) return
    const top = frame.id === stop.frames[0]?.id
    // The exception was raised in the top frame; a caller's line keeps the paused look.
    const exception = top ? stopException(stop, language.t("workbench.debug.exceptionStop")) : undefined
    return { line: frame.line, top, locals: stop.locals, exception }
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
    current.dispatch({
      effects: setMarks.of({
        breakpoints,
        exec: paused?.line,
        values: values || undefined,
        exception: paused?.exception,
      }),
    })
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
      <Show when={references()}>
        {(found) => (
          <div
            data-slot="editor-references"
            class="sticky bottom-0 z-20 max-h-48 overflow-auto border-t border-v2-border-border-muted bg-v2-background-bg-base text-[12px] text-v2-text-text-base"
            onKeyDown={(event) => {
              if (event.key === "Escape") setReferences(undefined)
            }}
          >
            <div class="flex items-center gap-2 px-3 py-1 text-v2-text-text-weak">
              <span class="min-w-0 flex-1">
                {language.t("workbench.editor.lsp.references", { count: String(found().items.length) })}
              </span>
              <ButtonV2
                size="small"
                variant="ghost"
                data-action="close-references"
                onClick={() => setReferences(undefined)}
              >
                {language.t("workbench.editor.lsp.references.close")}
              </ButtonV2>
            </div>
            <For each={found().items}>
              {(item) => {
                const place = `${item.outside ? item.file : file.normalize(item.file)}:${item.range.start.line + 1}`
                return (
                  <Show
                    when={!item.outside}
                    fallback={<div class="truncate px-3 py-0.5 text-v2-text-text-weak">{place}</div>}
                  >
                    <button
                      type="button"
                      data-slot="editor-reference"
                      class="flex w-full min-w-0 gap-3 px-3 py-0.5 text-left hover:bg-v2-overlay-simple-overlay-hover"
                      onClick={() => go(item, found().from)}
                    >
                      <span class="shrink-0 font-mono">{place}</span>
                      <span class="min-w-0 truncate font-mono text-v2-text-text-weak">{item.preview}</span>
                    </button>
                  </Show>
                )
              }}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}
