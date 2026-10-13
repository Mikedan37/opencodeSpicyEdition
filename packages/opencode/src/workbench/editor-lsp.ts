// The IDE editor's code intelligence (/workbench/lsp/*): hover, definition, references, completion and rename at a
// 0-based position (UTF-16 columns, as in LSP and CodeMirror) in a project file, formatting, and the editor's unsaved
// text for the file's language servers. A file without a server, a server without an answer, or "lsp" off give an
// empty answer, never an error.
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import type { Format } from "@/format"
import type { LSPClient } from "@/lsp/client"
import type { LSP } from "@/lsp/lsp"
import { MAX_BYTES } from "./editor-file"

const COMPLETION_MAX = 1_000
// LSP CompletionItemKind → the CodeMirror completion type whose icon it shows.
const KINDS: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "function",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace",
  10: "property",
  11: "constant",
  12: "constant",
  13: "enum",
  14: "keyword",
  20: "enum",
  21: "constant",
  22: "class",
  25: "type",
}

export type At = { file: string; line: number; character: number }

// Files each running server got from the editor (its text, or the file once): a file opens once, instead of being
// re-read on every hover. A restarted server is a new client, so it gets the file again. A server that fails a
// request answers nothing.
const opened = new WeakMap<LSPClient.Info, Set<string>>()
const filesOf = (client: LSPClient.Info) => {
  const files = opened.get(client) ?? new Set<string>()
  opened.set(client, files)
  return files
}

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
  if (filesOf(client).has(file)) return
  await client.notify.open({ path: file })
  filesOf(client).add(file)
}

// The editor's text, or without it the file on disk again (saved, discarded, reloaded or renamed), for the file's
// servers: one full didChange, versioned by the client. Requests after it are answered against that text.
export const sync = (lsp: LSP.Interface, file: string, text?: string) =>
  lsp
    .forFile(file, (client) =>
      client.notify
        .open({ path: file, text })
        .then(() => void filesOf(client).add(file))
        .catch(() => undefined),
    )
    .pipe(Effect.asVoid)

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

export const completion = (lsp: LSP.Interface, at: At) =>
  request(lsp, at, "textDocument/completion", { context: { triggerKind: 1 } }).pipe(
    Effect.map((results): Workbench.LspCompletionList => {
      const lists = results.flatMap((result) => {
        if (Array.isArray(result)) return [{ items: result as unknown[], incomplete: false }]
        const list = result as { items?: unknown; isIncomplete?: unknown } | null
        return list && Array.isArray(list.items)
          ? [{ items: list.items as unknown[], incomplete: !!list.isIncomplete }]
          : []
      })
      const items = lists.flatMap((list) => list.items)
      return {
        items: items.slice(0, COMPLETION_MAX).flatMap(completionItem),
        incomplete: items.length > COMPLETION_MAX || lists.some((list) => list.incomplete),
      }
    }),
  )

function completionItem(value: unknown): Workbench.LspCompletion[] {
  const item = value as {
    label?: unknown
    kind?: unknown
    detail?: unknown
    documentation?: unknown
    insertText?: unknown
    insertTextFormat?: unknown
    textEdit?: { newText?: unknown; range?: unknown; replace?: unknown }
  } | null
  if (typeof item?.label !== "string") return []
  const raw =
    typeof item.textEdit?.newText === "string"
      ? item.textEdit.newText
      : typeof item.insertText === "string"
        ? item.insertText
        : undefined
  // A snippet as plain text: placeholders keep their default text, tab stops go.
  const insert =
    raw !== undefined && item.insertTextFormat === 2
      ? raw
          .replace(/\$\{\d+:([^}]*)\}/g, "$1")
          .replace(/\$\{\d+\}|\$\d+/g, "")
          .replace(/\\\$/g, "$")
      : raw
  // clangd pads labels with a space where it marks completions that add an #include
  const label = item.label.trim()
  return [
    {
      label,
      kind: typeof item.kind === "number" ? KINDS[item.kind] : undefined,
      detail: typeof item.detail === "string" ? item.detail : undefined,
      documentation: markdown(item.documentation) || undefined,
      insert: insert === label ? undefined : insert,
      range: range(item.textEdit?.range ?? item.textEdit?.replace),
    },
  ]
}

// A rename as whole files: the server's WorkspaceEdit applied to each file's text on disk. Edits to files outside the
// project, or creating, renaming or deleting files, refuse it.
export const rename = (lsp: LSP.Interface, at: At, newName: string, directory: string) =>
  request(lsp, at, "textDocument/rename", { newName }).pipe(
    Effect.flatMap((results) =>
      Effect.promise(() =>
        renamed(
          results.find((item) => !!item && typeof item === "object"),
          directory,
        ),
      ),
    ),
  )

async function renamed(
  edit: unknown,
  directory: string,
): Promise<{ files: { file: string; content: string }[]; edits: number } | { error: string }> {
  const workspace = edit as { changes?: Record<string, unknown>; documentChanges?: unknown[] } | undefined
  const changes = [
    ...Object.entries(workspace?.changes ?? {}),
    ...(workspace?.documentChanges ?? []).map((change) => {
      const document = change as { textDocument?: { uri?: unknown }; edits?: unknown }
      return [document.textDocument?.uri, document.edits] as const
    }),
  ]
  if (changes.some(([uri, edits]) => typeof uri !== "string" || !Array.isArray(edits)))
    return { error: "The rename would create, rename or delete files, which the editor does not do" }
  const real = await fs.realpath(directory).catch(() => directory)
  const named = changes.map(([uri, edits]) => {
    const file = filePath(uri as string)
    return {
      file: file && projectName(file, directory, real),
      shown: file ?? (uri as string),
      edits: edits as unknown[],
    }
  })
  const outside = named.find((item) => !item.file)
  if (outside) return { error: `The rename would change a file outside the project: ${outside.shown}` }
  const byFile = Map.groupBy(named, (item) => item.file!)
  const files = await Promise.all(
    [...byFile].map(async ([file, items]) => {
      const edits = items.flatMap((item) => item.edits.flatMap(textEdit))
      return { file, edits, text: await fs.readFile(file, "utf8").catch(() => undefined) }
    }),
  )
  const unreadable = files.find((item) => item.text === undefined)
  if (unreadable) return { error: `The rename would change a file that cannot be read: ${unreadable.file}` }
  return {
    files: files.map((item) => ({ file: item.file, content: applyEdits(item.text!, item.edits) })),
    edits: files.reduce((sum, item) => sum + item.edits.length, 0),
  }
}

// Formatting for the editor's text: the file's language servers' edits, else opencode's formatter (the `formatter`
// config) on a copy of the text beside the file, where it finds the project's formatter settings.
export const format = (
  lsp: LSP.Interface,
  formatter: Format.Interface,
  file: string,
  text: string,
  options: { tabSize: number; insertSpaces: boolean },
) =>
  Effect.gen(function* () {
    yield* sync(lsp, file, text)
    const results = yield* lsp.forFile(file, (client) =>
      client.connection
        .sendRequest<unknown>("textDocument/formatting", { textDocument: { uri: pathToFileURL(file).href }, options })
        .catch(() => null),
    )
    const edits = results.find(Array.isArray)
    if (edits) return { edits: edits.flatMap(textEdit) } satisfies Workbench.LspFormat
    const copy = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomBytes(4).toString("hex")}${path.extname(file)}`,
    )
    yield* Effect.promise(() => fs.writeFile(copy, text))
    const formatted = yield* formatter.file(copy).pipe(
      Effect.flatMap((ran) => (ran ? Effect.promise(() => fs.readFile(copy, "utf8")) : Effect.succeed(undefined))),
      Effect.ensuring(Effect.promise(() => fs.rm(copy, { force: true }))),
    )
    return (formatted === undefined ? {} : { text: formatted }) satisfies Workbench.LspFormat
  })

function textEdit(value: unknown): Workbench.LspTextEdit[] {
  const edit = value as { range?: unknown; newText?: unknown } | null
  const at = range(edit?.range)
  return at && typeof edit?.newText === "string" ? [{ range: at, newText: edit.newText }] : []
}

// Text edits (LSP positions: 0-based lines, UTF-16 columns) applied to a text; positions past a line's end clamp to it.
export function applyEdits(text: string, edits: readonly Workbench.LspTextEdit[]) {
  const starts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)]
  const offset = (at: { line: number; character: number }) =>
    at.line >= starts.length
      ? text.length
      : Math.min(starts[at.line] + at.character, at.line + 1 < starts.length ? starts[at.line + 1] - 1 : text.length)
  return edits
    .map((edit) => ({ from: offset(edit.range.start), to: offset(edit.range.end), text: edit.newText }))
    .toSorted((a, b) => b.from - a.from || b.to - a.to)
    .reduce((result, edit) => result.slice(0, edit.from) + edit.text + result.slice(edit.to), text)
}

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
  const seen = new Set<string>()
  const found = results.flat().flatMap((item): Workbench.LspLocation[] => {
    if (!item || typeof item !== "object") return []
    const link = item as { uri?: unknown; range?: unknown; targetUri?: unknown; targetSelectionRange?: unknown }
    const uri = typeof link.targetUri === "string" ? link.targetUri : link.uri
    const at = range(typeof link.targetUri === "string" ? link.targetSelectionRange : link.range)
    const file = typeof uri === "string" && uri.startsWith("file:") ? filePath(uri) : undefined
    if (!file || !at) return []
    const named = projectName(file, directory, real)
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

// A file under the project directory as the project names it (a server may answer with the real path of a symlinked
// folder); undefined outside it.
function projectName(file: string, directory: string, real: string) {
  const under = (root: string) => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  if (under(directory)) return file
  if (under(real)) return path.join(directory, path.relative(real, file))
}

export * as WorkbenchEditorLsp from "./editor-lsp"
