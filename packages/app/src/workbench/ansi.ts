// Terminal output → styled segments per line, plus `file:line` references, for the Output tab.

export type AnsiStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}
export type AnsiSegment = { text: string; style?: AnsiStyle }

// Basic colors map to theme variables (defined where the output renders) so they stay readable in light and dark.
const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]

// SGR sequences, other CSI/OSC sequences (dropped), and line breaks.
const ESCAPES = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r?\n|\r/g

// Splits text into lines of styled segments. SGR state carries across lines, like a terminal.
export function ansiLines(text: string) {
  const lines: AnsiSegment[][] = [[]]
  const state = { style: {} as AnsiStyle, last: 0 }
  const push = (chunk: string) => {
    if (!chunk) return
    lines[lines.length - 1]!.push(
      Object.keys(state.style).length ? { text: chunk, style: state.style } : { text: chunk },
    )
  }
  for (const match of text.matchAll(ESCAPES)) {
    push(text.slice(state.last, match.index))
    state.last = match.index + match[0].length
    if (match[0].endsWith("\n")) lines.push([])
    if (match[1] !== undefined) state.style = applySgr(state.style, match[1])
  }
  push(text.slice(state.last))
  return lines
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = (params || "0").split(";").map(Number)
  const next = { ...style }
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!
    if (code === 0) Object.keys(next).forEach((key) => delete next[key as keyof AnsiStyle])
    if (code === 1) next.bold = true
    if (code === 2) next.dim = true
    if (code === 3) next.italic = true
    if (code === 4) next.underline = true
    if (code === 22) {
      delete next.bold
      delete next.dim
    }
    if (code === 23) delete next.italic
    if (code === 24) delete next.underline
    if (code === 39) delete next.fg
    if (code === 49) delete next.bg
    if (code >= 30 && code <= 37) next.fg = basic(code - 30)
    if (code >= 90 && code <= 97) next.fg = basic(code - 90)
    if (code >= 40 && code <= 47) next.bg = basic(code - 40)
    if (code >= 100 && code <= 107) next.bg = basic(code - 100)
    if (code === 38 || code === 48) {
      const color = codes[index + 1] === 5 ? xterm(codes[index + 2] ?? 0) : rgb(codes.slice(index + 2, index + 5))
      index += codes[index + 1] === 5 ? 2 : 4
      if (code === 38) next.fg = color
      if (code === 48) next.bg = color
    }
  }
  return next
}

const basic = (index: number) => `var(--ansi-${BASIC[index]})`

function rgb(values: number[]) {
  return `rgb(${values.map((value) => Math.max(0, Math.min(255, value || 0))).join(", ")})`
}

// xterm 256-color palette: 0-15 basic, 16-231 a 6x6x6 cube, 232-255 grays.
function xterm(index: number) {
  if (index < 16) return basic(index % 8)
  if (index >= 232) return rgb(Array(3).fill(8 + (index - 232) * 10))
  const cube = index - 16
  const level = (value: number) => (value === 0 ? 0 : 55 + value * 40)
  return rgb([level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)])
}

export type TextPart = { text: string } | { text: string; file: string; line: number; column?: number }

// `path:line[:col]` or `path(line,col)` where the path has an extension; never inside URLs (`scheme://host:port`).
const FILE_REF =
  /(?<![\w./\\:@~+-])((?:[A-Za-z]:[\\/])?[\w.@~+-]*(?:[\\/][\w.@~+-]+)*\.[A-Za-z][\w]*)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))/g

export function fileRefs(text: string): TextPart[] {
  const parts: TextPart[] = []
  const state = { last: 0 }
  for (const match of text.matchAll(FILE_REF)) {
    if (match.index > state.last) parts.push({ text: text.slice(state.last, match.index) })
    const column = match[3] ?? match[5]
    parts.push({
      text: match[0],
      file: match[1]!,
      line: Number(match[2] ?? match[4]),
      ...(column ? { column: Number(column) } : {}),
    })
    state.last = match.index + match[0].length
  }
  if (state.last < text.length) parts.push({ text: text.slice(state.last) })
  return parts
}

// Resolves a tool-reported path against the run's working directory (POSIX and Windows separators).
export function resolvePath(base: string, file: string) {
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) return file
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
  return `${base}/${file}`
    .split(/[\\/]+/)
    .reduce<string[]>((parts, part, index) => {
      if (part === "." || (part === "" && index > 0)) return parts
      if (part === ".." && parts.length > 1) return parts.slice(0, -1)
      return [...parts, part]
    }, [])
    .join(separator)
}
