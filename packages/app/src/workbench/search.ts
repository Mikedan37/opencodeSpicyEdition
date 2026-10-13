// The Search tab's model (search-side.tsx, search-panel.tsx). GET /workbench/search lists the lines ripgrep matched;
// where the query matches inside them, and what a replace writes, is worked out here in JavaScript, the same way for
// the preview and for the write.

export type SearchQuery = {
  pattern: string
  regex: boolean
  caseSensitive: boolean
  word: boolean
  include: string
  exclude: string
}

export type SearchLine = { line: number; text: string }
// `hash`: sha256 of the file's bytes when it was searched, the baseHash of its replace; absent when the editor does
// not open the file.
export type SearchFile = { path: string; hash?: string; lines: readonly SearchLine[] }
export type SearchMatch = { line: SearchLine; start: number; end: number }
export type FileMatches = { file: SearchFile; matches: SearchMatch[] }

// Lines as the server cuts them (src/workbench/search.ts MAX_LINE).
const MAX_LINE = 2_000
const SYNTAX = /[\\^$.*+?()[\]{}|]/g

// The query as a global RegExp, or why it is not one. Unicode-aware like ripgrep; a regular expression that only
// compiles without the u flag (escapes such as \- or \: that ripgrep accepts) gets ASCII semantics instead. Whole
// words are ripgrep's --word-regexp: no word character right before or after the match.
export function compile(query: Pick<SearchQuery, "pattern" | "regex" | "caseSensitive" | "word">) {
  const source = query.regex ? query.pattern : query.pattern.replace(SYNTAX, "\\$&")
  const make = (unicode: boolean) => {
    const word = unicode ? "[\\p{L}\\p{M}\\p{N}\\p{Pc}]" : "\\w"
    const body = query.word ? `(?<!${word})(?:${source})(?!${word})` : source
    return new RegExp(body, (query.caseSensitive ? "g" : "gi") + (unicode ? "u" : ""))
  }
  try {
    return make(true)
  } catch (error) {
    try {
      return make(false)
    } catch {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}

// Non-empty matches of `re` in one line, as UTF-16 columns.
export function matchesIn(text: string, re: RegExp) {
  return [...text.matchAll(re)].flatMap((match) =>
    match[0] ? [{ start: match.index, end: match.index + match[0].length }] : [],
  )
}

export function matchFiles(files: readonly SearchFile[], re: RegExp): FileMatches[] {
  return files.flatMap((file) => {
    const matches = file.lines.flatMap((line) => matchesIn(line.text, re).map((range) => ({ line, ...range })))
    return matches.length ? [{ file, matches }] : []
  })
}

// What the match at `start` of `text` becomes, or undefined when `expected` is no longer matched there. A regular
// expression fills in $1, $& and $<name> with JavaScript's own rules: the engine replaces exactly that match, and the
// rest of the line is cut away again.
export function replacementAt(
  text: string,
  start: number,
  expected: string,
  re: RegExp,
  replace: string,
  regex: boolean,
) {
  const sticky = new RegExp(re.source, re.flags.replace("g", "") + "y")
  sticky.lastIndex = start
  if (sticky.exec(text)?.[0] !== expected) return undefined
  if (!regex) return replace
  sticky.lastIndex = start
  const replaced = text.replace(sticky, replace)
  return replaced.slice(start, replaced.length - (text.length - start - expected.length))
}

export type Target = { line: number; start: number; text: string }

// The file's new content with each target replaced, or undefined when the content no longer has a target where it
// was listed. Lines count as ripgrep counts them: split at "\n", the BOM left out of the first line.
export function replaceIn(content: string, targets: readonly Target[], re: RegExp, replace: string, regex: boolean) {
  const bom = content.startsWith("﻿") ? "﻿" : ""
  const lines = content.slice(bom.length).split("\n")
  const byLine = Map.groupBy(targets, (target) => target.line)
  for (const [number, list] of byLine) {
    const text = lines[number - 1]
    if (text === undefined) return undefined
    // Every replacement is worked out on the line as it is, then applied from the right.
    const edits = list.map((target) => ({
      ...target,
      replacement: replacementAt(text, target.start, target.text, re, replace, regex),
    }))
    if (edits.some((edit) => edit.replacement === undefined)) return undefined
    lines[number - 1] = edits
      .toSorted((a, b) => b.start - a.start)
      .reduce(
        (line, edit) => line.slice(0, edit.start) + edit.replacement + line.slice(edit.start + edit.text.length),
        text,
      )
  }
  return bom + lines.join("\n")
}

// The listed lines of a file as its new content has them, after a write: the rows show the file as it is now.
export function relisted(file: SearchFile, content: string, hash: string): SearchFile {
  const lines = content.replace(/^﻿/, "").split("\n")
  return {
    ...file,
    hash,
    lines: file.lines.map((line) => {
      const text = lines[line.line - 1] ?? ""
      return { line: line.line, text: text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text }
    }),
  }
}

export type SearchRow =
  | { type: "file"; key: string; entry: FileMatches; collapsed: boolean }
  | { type: "match"; key: string; entry: FileMatches; match: SearchMatch }

export function searchRows(
  entries: readonly FileMatches[],
  collapsed: Record<string, boolean | undefined>,
): SearchRow[] {
  return entries.flatMap((entry) => [
    { type: "file" as const, key: entry.file.path, entry, collapsed: !!collapsed[entry.file.path] },
    ...(collapsed[entry.file.path]
      ? []
      : entry.matches.map((match) => ({
          type: "match" as const,
          key: `${entry.file.path}:${match.line.line}:${match.start}`,
          entry,
          match,
        }))),
  ])
}
