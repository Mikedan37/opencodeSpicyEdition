// The IDE editor's state outside the view: one buffer per file, shared by every tab that shows it, and the pure
// mappings the view uses (language, line endings, problems → diagnostics, gutter marks). The view is editor-view.tsx.
import type { EditorState, Text } from "@codemirror/state"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { WorkbenchRequestError } from "./client"

// Larger files keep the read-only viewer, which stops tokenizing at the same size.
export const EDITOR_MAX_CHARS = 500_000

export type EditorFileClient = {
  readFile: (path: string) => Promise<{ content: string; hash: string }>
  writeFile: (input: { path: string; content: string; baseHash: string | null }) => Promise<{ hash: string }>
}

export type EditorBuffer = {
  // The text the editor started from, exactly as on disk, and the sha256 of its bytes (GET /workbench/file).
  base?: { text: string; hash: string }
  status: "loading" | "ready" | "failed" | "unavailable"
  error?: string
  dirty: boolean
  saving: boolean
  // Why the last save was refused (the file changed on disk); cleared by Reload or Overwrite.
  conflict?: string
}

export type SaveResult = "saved" | "conflict" | "busy"

// A place in a file as LSP names it: 0-based line, UTF-16 column (CodeMirror counts columns the same way).
export type CodePosition = { line: number; character: number }
export type Spot = CodePosition & { path: string }
const TRAIL_MAX = 50

export function createEditorStore(client: EditorFileClient) {
  const [state, setState] = createStore({ files: {} as Record<string, EditorBuffer> })
  // The CodeMirror state a view leaves behind (text, selection, undo history), so switching tabs keeps unsaved edits;
  // and the live text of a mounted view.
  const saved = new Map<string, EditorState>()
  const live = new Map<string, () => string>()
  // Code navigation: where a jump wants the cursor in a file (its editor takes it when it mounts, or at once through
  // `showing` while it is mounted), and the places jumped from, for Back.
  const targets = new Map<string, CodePosition>()
  const showing = new Map<string, (at: CodePosition) => void>()
  const trail: Spot[] = []

  // The buffer's base, read once per file (or again with `force`, for Reload). A server without the route marks the
  // file unavailable, so the read-only viewer stays.
  async function load(path: string, force = false) {
    const current = state.files[path]
    if (!force && current && current.status !== "failed") return
    setState("files", path, (entry) => ({
      ...(entry ?? { dirty: false, saving: false }),
      status: "loading",
      error: undefined,
    }))
    try {
      const file = await client.readFile(path)
      setState("files", path, { base: { text: file.content, hash: file.hash }, status: "ready", conflict: undefined })
    } catch (error) {
      const unavailable = error instanceof WorkbenchRequestError && error.kind === "unavailable" && !error.status
      setState("files", path, { status: unavailable ? "unavailable" : "failed", error: errorMessage(error) })
    }
  }

  const text = (path: string) => live.get(path)?.() ?? saved.get(path)?.sliceDoc()

  async function write(path: string, content: string, baseHash: string | null): Promise<SaveResult> {
    const current = state.files[path]
    if (!current || current.saving) return "busy"
    setState("files", path, "saving", true)
    try {
      const result = await client.writeFile({ path, content, baseHash })
      setState("files", path, { base: { text: content, hash: result.hash }, saving: false, conflict: undefined })
      return "saved"
    } catch (error) {
      setState("files", path, "saving", false)
      if (!(error instanceof WorkbenchRequestError) || error.status !== 409) throw error
      setState("files", path, "conflict", error.message)
      return "conflict"
    }
  }

  return {
    state,
    load,
    text,
    saved,
    live,
    targets,
    showing,
    reveal(path: string, at: CodePosition) {
      const show = showing.get(path)
      if (show) return show(at)
      targets.set(path, at)
    },
    // A jump remembers where it started; Back returns the latest one.
    remember(spot: Spot) {
      trail.push(spot)
      if (trail.length > TRAIL_MAX) trail.shift()
    },
    back: () => trail.pop(),
    dirty: (path: string) => !!state.files[path]?.dirty,
    anyDirty: () => Object.values(state.files).some((buffer) => buffer?.dirty),
    setDirty: (path: string, dirty: boolean) => {
      if (state.files[path] && state.files[path].dirty !== dirty) setState("files", path, "dirty", dirty)
    },
    // Saves over the bytes the buffer started from; a file changed on disk since then is a conflict, never overwritten.
    save: (path: string, content: string) => {
      const base = state.files[path]?.base
      return base ? write(path, content, base.hash) : Promise.resolve<SaveResult>("busy")
    },
    // Writes over whatever is on disk now: the caller asked the user first.
    async overwrite(path: string, content: string) {
      const disk = await client.readFile(path).then(
        (file) => file.hash,
        (error: unknown) => {
          if (error instanceof WorkbenchRequestError && error.status === 404) return null
          throw error
        },
      )
      return write(path, content, disk)
    },
    // Drops unsaved edits: the next view starts from the file on disk.
    discard(path: string) {
      saved.delete(path)
      setState("files", path, undefined!)
    },
  }
}

export type EditorStore = ReturnType<typeof createEditorStore>

// While any buffer has unsaved edits the page asks before it unloads: the browser's leave-page confirmation on a
// reload or a tab close; the desktop app shows its own dialog (packages/desktop/src/main/unsaved.ts).
export function guardUnload(dirty: () => boolean, target: Pick<Window, "addEventListener" | "removeEventListener">) {
  const ask = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    // Older engines show the dialog only for a set returnValue.
    event.returnValue = ""
  }
  const asking = createMemo(dirty)
  createEffect(() => {
    if (!asking()) return
    target.addEventListener("beforeunload", ask)
    onCleanup(() => target.removeEventListener("beforeunload", ask))
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------- pure mappings

export type LanguageKey = "ts" | "tsx" | "js" | "jsx" | "python" | "rust" | "cpp" | "go" | "json" | "markdown" | "swift"

const EXTENSIONS: Record<string, LanguageKey> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  py: "python",
  pyi: "python",
  rs: "rust",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  m: "cpp",
  mm: "cpp",
  go: "go",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  swift: "swift",
}

export function languageOf(path: string) {
  const name = path.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined
}

// CodeMirror joins lines with the state's separator, so a CRLF file is saved with CRLF. A file with any CRLF keeps
// CRLF; otherwise only "\n" breaks lines, so a stray "\r" stays in the text instead of becoming a new line.
// ponytail: a file that mixes CRLF and LF is saved all-CRLF; per-line endings would need a custom Text.
export const lineSeparator = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n")

export type EditorDiagnostic = {
  from: number
  to: number
  severity: Workbench.Severity
  message: string
  source: string
  // The problem it shows (the lint tooltip's Fix sends it).
  id: string
}

// Problems of one file as document ranges. LSP positions are 0-based lines and UTF-16 columns, which is how
// CodeMirror counts too; positions past a line's end clamp to it. Problems without a range stay in the Problems tab.
export function diagnosticsFor(problems: readonly Workbench.Problem[], doc: Text): EditorDiagnostic[] {
  // A point (tsc reports one) marks the word that starts there.
  const word = (from: number) => {
    const line = doc.lineAt(from)
    return from + (/^[\w$]+/.exec(line.text.slice(from - line.from))?.[0].length ?? 0)
  }
  return problems.flatMap((problem) => {
    if (!problem.range) return []
    const from = offsetOf(doc, problem.range.start)
    const to = offsetOf(doc, problem.range.end)
    return [
      {
        from,
        to: to > from ? to : word(from),
        severity: problem.severity,
        message: problem.message,
        source: problem.source.tool,
        id: problem.id,
      },
    ]
  })
}

export function positionOf(doc: Text, offset: number): CodePosition {
  const line = doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

// Positions past the last line or a line's end clamp to them.
export function offsetOf(doc: Text, position: CodePosition) {
  const line = doc.line(Math.min(Math.max(position.line + 1, 1), doc.lines))
  return Math.min(line.from + Math.max(position.character, 0), line.to)
}

export type BreakpointMark = { line: number; kind: "line" | "condition" | "log"; verified: boolean }
export type GlyphKind = "line" | "condition" | "log" | "unverified" | Workbench.Severity

const RANK: Workbench.Severity[] = ["error", "warning", "info", "hint"]

// The gutter's glyph for one line: its breakpoint, else its worst diagnostic.
export function glyphFor(breakpoint: BreakpointMark | undefined, severities: Iterable<Workbench.Severity>) {
  if (breakpoint) return (breakpoint.verified ? breakpoint.kind : "unverified") satisfies GlyphKind
  let worst: Workbench.Severity | undefined
  for (const severity of severities) if (!worst || RANK.indexOf(severity) < RANK.indexOf(worst)) worst = severity
  return worst satisfies GlyphKind | undefined
}
