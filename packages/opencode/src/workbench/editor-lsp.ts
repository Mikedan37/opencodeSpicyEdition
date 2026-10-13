// The IDE editor's code intelligence (GET /workbench/lsp/*): hover, definition and references at a 0-based position
// (UTF-16 columns, as in LSP and CodeMirror) in a project file, answered by the file's language servers. A file
// without a server, a server without an answer, or "lsp" off give an empty answer, never an error.
import fs from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import type { LSPClient } from "@/lsp/client"
import type { LSP } from "@/lsp/lsp"
import { MAX_BYTES } from "./editor-file"

export type At = { file: string; line: number; character: number }

// Files each running server got through these requests: a file opens once, instead of being re-read on every hover.
// A restarted server is a new client, so it gets the file again. A server that fails a request answers nothing.
const opened = new WeakMap<LSPClient.Info, Set<string>>()

function request(lsp: LSP.Interface, at: At, method: string, params: object = {}) {
  return lsp.forFile(at.file, (client) =>
    open(client, at.file)
      .then(() =>
        client.connection.sendRequest<unknown>(method, {
          textDocument: { uri: pathToFileURL(at.file).href },
          position: { line: at.line, character: at.character },
          ...params,
        }),
      )
      .catch(() => null),
  )
}

async function open(client: LSPClient.Info, file: string) {
  const files = opened.get(client) ?? new Set<string>()
  opened.set(client, files)
  if (files.has(file)) return
  await client.notify.open({ path: file })
  files.add(file)
}

export const hover = (lsp: LSP.Interface, at: At) =>
  request(lsp, at, "textDocument/hover").pipe(
    Effect.map((results): Workbench.LspHover | null => {
      for (const result of results) {
        if (!result || typeof result !== "object") continue
        const text = markdown((result as { contents?: unknown }).contents)
        if (text.trim()) return { markdown: text, range: range((result as { range?: unknown }).range) }
      }
      return null
    }),
  )

export const definition = (lsp: LSP.Interface, at: At, directory: string) =>
  request(lsp, at, "textDocument/definition").pipe(
    Effect.flatMap((results) => Effect.promise(() => locations(results, directory, false))),
  )

export const references = (lsp: LSP.Interface, at: At, directory: string) =>
  request(lsp, at, "textDocument/references", { context: { includeDeclaration: true } }).pipe(
    Effect.flatMap((results) => Effect.promise(() => locations(results, directory, true))),
  )

// Hover contents as markdown: MarkupContent, a MarkedString ({ language, value } becomes a fence) or a list of them.
export function markdown(contents: unknown): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents))
    return contents
      .map(markdown)
      .filter((item) => item.trim())
      .join("\n\n")
  if (!contents || typeof contents !== "object") return ""
  const item = contents as { kind?: unknown; language?: unknown; value?: unknown }
  const value = typeof item.value === "string" ? item.value : ""
  if (!value) return ""
  if (typeof item.language === "string") return "```" + item.language + "\n" + value + "\n```"
  return item.kind === "plaintext" ? "```\n" + value + "\n```" : value
}

function range(value: unknown): Workbench.Range | undefined {
  const item = value as Workbench.Range | undefined
  const valid = (position: unknown) =>
    !!position &&
    Number.isInteger((position as { line?: unknown }).line) &&
    Number.isInteger((position as { character?: unknown }).character)
  return item && valid(item.start) && valid(item.end) ? { start: item.start, end: item.end } : undefined
}

function filePath(uri: string) {
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

// Location and LocationLink results of every server, as files the editor can open: a path under the project directory
// is named as the project names it (a server may answer with the real path of a symlinked folder); anything else is
// `outside`. References come sorted, with the line's text.
export async function locations(results: unknown[], directory: string, previews: boolean) {
  const real = await fs.realpath(directory).catch(() => directory)
  const under = (root: string, file: string) => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  const seen = new Set<string>()
  const found = results.flat().flatMap((item): Workbench.LspLocation[] => {
    if (!item || typeof item !== "object") return []
    const link = item as { uri?: unknown; range?: unknown; targetUri?: unknown; targetSelectionRange?: unknown }
    const uri = typeof link.targetUri === "string" ? link.targetUri : link.uri
    const at = range(typeof link.targetUri === "string" ? link.targetSelectionRange : link.range)
    const file = typeof uri === "string" && uri.startsWith("file:") ? filePath(uri) : undefined
    if (!file || !at) return []
    const named = under(directory, file)
      ? file
      : under(real, file)
        ? path.join(directory, path.relative(real, file))
        : undefined
    const key = JSON.stringify([named ?? file, at])
    if (seen.has(key)) return []
    seen.add(key)
    return [named ? { file: named, range: at } : { file, range: at, outside: true }]
  })
  if (!previews) return found
  const texts = new Map<string, Promise<string[] | undefined>>()
  const lines = (file: string) => {
    const cached = texts.get(file)
    if (cached) return cached
    const next = fs
      .stat(file)
      .then((stat) => (stat.size > MAX_BYTES ? undefined : fs.readFile(file, "utf8").then((text) => text.split("\n"))))
      .catch(() => undefined)
    texts.set(file, next)
    return next
  }
  const withText = await Promise.all(
    found.map(async (item) => {
      if (item.outside) return item
      const text = (await lines(item.file))?.[item.range.start.line]?.trim()
      return text === undefined ? item : { ...item, preview: text.slice(0, 200) }
    }),
  )
  return withText.toSorted(
    (a, b) =>
      Number(!!a.outside) - Number(!!b.outside) ||
      a.file.localeCompare(b.file) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
  )
}

export * as WorkbenchEditorLsp from "./editor-lsp"
