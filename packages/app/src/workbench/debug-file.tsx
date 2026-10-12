import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { File, type FileProps, type TextFileProps } from "@opencode-ai/session-ui/file"
import { useDebugOptional } from "./debug-context"

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

// The app-wide File component with the debugger's marks in the read-only viewer: breakpoint dots in the gutter, the
// selected frame's line, and the top frame's values under it. Pierre renders lines into a shadow root, so the marks
// are inline styles on its [data-column-number] / [data-line] nodes, reapplied whenever it re-renders them.
export function DebugFile<T>(props: FileProps<T>) {
  const debug = useDebugOptional()
  if (!debug || props.mode !== "text") return <File {...props} />
  const text = props as TextFileProps<T>
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
      metadata: { spicyDebugValues: shown.map((item) => `${item.name} = ${item.value}`).join("   ") },
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
    onCleanup(() => {
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
