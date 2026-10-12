import { createEffect, createMemo, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { File, type FileProps, type TextFileProps } from "@opencode-ai/session-ui/file"
import { isBinaryContent, mediaKindFromPath } from "@opencode-ai/session-ui/pierre/media"
import { useDebugOptional, type DebugContextValue } from "./debug-context"
import { EDITOR_MAX_CHARS } from "./editor"
import { useEditorOptional } from "./editor-context"

// CodeMirror loads with the first file opened for editing.
const EditorView = lazy(() => import("./editor-view"))

type Annotation<T> = NonNullable<TextFileProps<T>["annotations"]>[number]
type Marks = {
  breakpoints: { line: number; kind: "line" | "condition" | "log"; verified: boolean }[]
  exec?: number
}

const COLORS = {
  line: "var(--v2-state-fg-danger)",
  condition: "var(--v2-state-fg-warning)",
  log: "var(--v2-state-fg-warning)",
}
const STYLES = ["background-image", "background-repeat", "background-color", "box-shadow", "color"]
// Inline, so it also wins over the viewer's selection color on the same line.
const PAUSED = "rgb(from var(--v2-state-fg-warning) r g b / 0.18)"

// The app-wide File component. In the side panel's file tabs, text files open in the editor (editor-view.tsx), which
// has the debugger's marks and Problems in its gutter; images, audio, binary and very large files keep the read-only
// viewer, with the debugger's marks painted on it.
export function DebugFile<T>(props: FileProps<T>) {
  const debug = useDebugOptional()
  // Only the file viewer (the one with line selection); tool output previews in the timeline show file contents
  // that may predate the program being debugged.
  // Called directly, so diffs and previews keep the props object as is (no spread proxy per instance).
  if (!debug || props.mode !== "text" || !props.enableLineSelection) return File(props)
  const text = props as TextFileProps<T>
  const editor = useEditorOptional()
  const editable = () =>
    !!editor &&
    !!text.file.name &&
    !mediaKindFromPath(text.file.name) &&
    !isBinaryContent(text.media?.current) &&
    text.file.contents.length <= EDITOR_MAX_CHARS
  const viewer = () => <MarkedFile debug={debug} text={text} />
  return (
    <Show when={editable()} fallback={viewer()}>
      <Suspense>
        <EditorView
          path={text.file.name!}
          contents={text.file.contents}
          annotations={text.annotations}
          renderAnnotation={text.renderAnnotation as (annotation: unknown) => HTMLElement | undefined}
          selectedLines={text.selectedLines}
          commentedLines={text.commentedLines}
          onLineSelectionEnd={text.onLineSelectionEnd}
          search={text.search}
          onRendered={text.onRendered}
          fallback={viewer}
        />
      </Suspense>
    </Show>
  )
}

// The read-only viewer with the debugger's marks: breakpoint dots in the gutter, the selected frame's line, and the
// top frame's values under it. Pierre renders lines into a shadow root, so the marks are inline styles on its
// [data-column-number] / [data-line] nodes, reapplied whenever it re-renders them.
function MarkedFile<T>(props: { debug: DebugContextValue; text: TextFileProps<T> }) {
  const debug = props.debug
  const text = props.text
  let host!: HTMLDivElement

  const name = () => (text.file.name ? (debug.relative(text.file.name) ?? text.file.name) : undefined)
  const exec = createMemo(() => {
    const session = debug.selected()
    const stop = session?.state === "stopped" ? session.stop : undefined
    const frame = stop?.frames.find((item) => item.id === debug.frameID())
    if (!stop || !frame?.file || !frame.line || (debug.relative(frame.file) ?? frame.file) !== name()) return
    return { line: frame.line, top: frame.id === stop.frames[0]?.id, locals: stop.locals }
  })
  const marks = createMemo((): Marks => {
    const file = name()
    if (!file) return { breakpoints: [] }
    const verified = debug.verified(file)
    return {
      breakpoints: debug.breakpoints(file).map((item) => ({
        line: item.line,
        kind: item.logMessage ? "log" : item.condition || item.hitCondition ? "condition" : "line",
        verified: verified?.find((entry) => entry.line === item.line)?.verified !== false,
      })),
      exec: exec()?.line,
    }
  })
  // Values of the top frame's locals named on the paused line.
  const values = createMemo(() => {
    const current = exec()
    if (!current?.top) return
    const words = new Set(lineText(text.file.contents, current.line).match(/[A-Za-z_$][\w$]*/g))
    const shown = current.locals.filter((item) => words.has(item.name)).slice(0, 6)
    if (!shown.length) return
    return {
      lineNumber: current.line,
      // Short values keep the row inside the viewer; the Debug tab has them in full.
      metadata: {
        spicyDebugValues: shown
          .map((item) => `${item.name} = ${item.value.length > 40 ? `${item.value.slice(0, 40)}…` : item.value}`)
          .join("   "),
      },
    } as unknown as Annotation<T>
  })
  const annotations = createMemo(() => {
    const own = values()
    const base = text.annotations ?? []
    return own ? [...base, own] : base
  })
  const renderAnnotation = (annotation: Annotation<T>) => {
    const meta = annotation.metadata as { spicyDebugValues?: string } | undefined
    if (meta?.spicyDebugValues === undefined) return text.renderAnnotation?.(annotation)
    const row = document.createElement("div")
    row.dataset.debugValues = ""
    row.className = "truncate px-3 font-mono text-[11px] leading-5 text-v2-state-fg-warning"
    row.textContent = meta.spicyDebugValues
    row.title = meta.spicyDebugValues
    return row
  }

  let frame: number | undefined
  let observed: ShadowRoot | undefined
  const inner = new MutationObserver(() => paint())
  const paint = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const root = host.querySelector("diffs-container")?.shadowRoot ?? undefined
      if (root !== observed) {
        inner.disconnect()
        observed = root
        if (root) inner.observe(root, { childList: true, subtree: true })
      }
      if (root) decorate(root, marks())
    })
  }
  onMount(() => {
    const outer = new MutationObserver(paint)
    outer.observe(host, { childList: true, subtree: true })
    const file = name()
    // F9 toggles what this viewer shows selected (pierre marks it [data-selected-line]).
    const selection = () => {
      const line = host.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line][data-selected-line]")
      return line ? Number(line.getAttribute("data-line")) || undefined : undefined
    }
    if (file) debug.viewers.set(file, selection)
    onCleanup(() => {
      if (file && debug.viewers.get(file) === selection) debug.viewers.delete(file)
      outer.disconnect()
      inner.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })
  createEffect(() => {
    marks()
    paint()
  })

  return (
    <div ref={host} style={{ display: "contents" }}>
      <File
        {...text}
        annotations={annotations()}
        renderAnnotation={renderAnnotation}
        onRendered={() => {
          text.onRendered?.()
          paint()
        }}
      />
    </div>
  )
}

function decorate(root: ShadowRoot, marks: Marks) {
  for (const node of root.querySelectorAll<HTMLElement>("[data-spicy-breakpoint], [data-spicy-exec]")) {
    delete node.dataset.spicyBreakpoint
    delete node.dataset.spicyExec
    for (const style of STYLES) node.style.removeProperty(style)
  }
  for (const mark of marks.breakpoints)
    for (const node of root.querySelectorAll<HTMLElement>(`[data-column-number="${mark.line}"]`)) {
      const color = COLORS[mark.kind]
      node.dataset.spicyBreakpoint = mark.verified ? mark.kind : "unverified"
      node.style.backgroundImage = mark.verified
        ? `radial-gradient(circle at 7px 50%, ${color} 3.5px, transparent 4px)`
        : `radial-gradient(circle at 7px 50%, transparent 2.5px, ${color} 3px, ${color} 4px, transparent 4.5px)`
      node.style.backgroundRepeat = "no-repeat"
    }
  if (marks.exec === undefined) return
  for (const node of root.querySelectorAll<HTMLElement>(`[data-line="${marks.exec}"]`)) {
    node.dataset.spicyExec = ""
    node.style.backgroundColor = PAUSED
  }
  for (const node of root.querySelectorAll<HTMLElement>(`[data-column-number="${marks.exec}"]`)) {
    node.dataset.spicyExec = ""
    node.style.backgroundColor = PAUSED
    node.style.boxShadow = "inset 3px 0 0 var(--v2-state-fg-warning)"
    node.style.color = "var(--v2-state-fg-warning)"
  }
}

// One 1-based line of `contents`; split stops after that line.
function lineText(contents: string, line: number) {
  return contents.split("\n", line).at(line - 1) ?? ""
}
