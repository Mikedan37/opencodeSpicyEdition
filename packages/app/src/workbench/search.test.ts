import { describe, expect, test } from "bun:test"
import {
  compile,
  matchFiles,
  matchesIn,
  relisted,
  replaceIn,
  replacementAt,
  searchRows,
  type SearchFile,
} from "./search"

const query = (pattern: string, options: { regex?: boolean; caseSensitive?: boolean; word?: boolean } = {}) => {
  const re = compile({ pattern, regex: false, caseSensitive: false, word: false, ...options })
  if ("error" in re) throw new Error(re.error)
  return re
}
const texts = (line: string, re: RegExp) => matchesIn(line, re).map((range) => line.slice(range.start, range.end))

describe("compile", () => {
  test("literal text is matched as typed, ignoring case unless asked", () => {
    expect(texts("a.b(c) A.B(C) axb(c)", query("a.b(c)"))).toEqual(["a.b(c)", "A.B(C)"])
    expect(texts("a.b(c) A.B(C)", query("a.b(c)", { caseSensitive: true }))).toEqual(["a.b(c)"])
    expect(texts("$& \\d", query("$& \\d"))).toEqual(["$& \\d"])
  })

  test("whole words: no word character, in any script, right before or after", () => {
    expect(texts("foo foobar _foo café caf", query("foo", { word: true }))).toEqual(["foo"])
    expect(texts("café caf", query("caf", { word: true }))).toEqual(["caf"])
    expect(texts("x.y foo.bar", query("foo|x", { regex: true, word: true }))).toEqual(["x", "foo"])
  })

  test("regular expressions, with ripgrep-style escapes that only compile without the u flag", () => {
    expect(texts("foo(1) foo(22)", query("foo\\((\\d+)\\)", { regex: true }))).toEqual(["foo(1)", "foo(22)"])
    expect(texts("a-b a_b", query("a\\-b", { regex: true }))).toEqual(["a-b"])
    expect(texts("x(foo) foo", query("(?<=\\()foo", { regex: true }))).toEqual(["foo"])
    expect(compile({ pattern: "foo(", regex: true, caseSensitive: false, word: false })).toMatchObject({
      error: expect.stringContaining("Invalid regular expression"),
    })
  })

  test("empty matches are not results", () => {
    expect(matchesIn("abc", query("x*", { regex: true }))).toEqual([])
  })
})

describe("replacementAt", () => {
  test("literal replace text stays literal; a regular expression fills in its groups", () => {
    const line = "call foo(1) and foo(22)"
    expect(replacementAt(line, 5, "foo(1)", query("foo(1)"), "$&-$1", false)).toBe("$&-$1")
    const re = query("foo\\((?<n>\\d+)\\)", { regex: true })
    expect(replacementAt(line, 16, "foo(22)", re, "bar[$1|$<n>|$&]", true)).toBe("bar[22|22|foo(22)]")
    // Look-behind sees the line before the match.
    expect(replacementAt("(foo) foo", 1, "foo", query("(?<=\\()foo", { regex: true }), "X", true)).toBe("X")
  })

  test("nothing when the match is no longer there", () => {
    expect(replacementAt("foo bar", 4, "foo", query("foo"), "x", false)).toBeUndefined()
    expect(replacementAt("foo bar", 0, "fo", query("foo"), "x", false)).toBeUndefined()
  })
})

describe("replaceIn", () => {
  const re = query("foo")
  test("replaces the listed matches only, keeping line endings, the BOM and the rest", () => {
    const content = "﻿foo one foo\r\nkeep foo\nfoo\n"
    const next = replaceIn(
      content,
      [
        { line: 1, start: 0, text: "foo" },
        { line: 1, start: 8, text: "foo" },
        { line: 3, start: 0, text: "foo" },
      ],
      re,
      "bar",
      false,
    )
    expect(next).toBe("﻿bar one bar\r\nkeep foo\nbar\n")
  })

  test("a regular expression's groups, per match", () => {
    const content = "a(1) b(2)\n"
    const regex = query("(\\w)\\((\\d)\\)", { regex: true })
    const targets = [
      { line: 1, start: 0, text: "a(1)" },
      { line: 1, start: 5, text: "b(2)" },
    ]
    expect(replaceIn(content, targets, regex, "$2:$1", true)).toBe("1:a 2:b\n")
  })

  test("undefined when the file no longer has a listed match where it was", () => {
    expect(replaceIn("xfoo\n", [{ line: 1, start: 0, text: "foo" }], re, "bar", false)).toBeUndefined()
    expect(replaceIn("foo\n", [{ line: 5, start: 0, text: "foo" }], re, "bar", false)).toBeUndefined()
    expect(replaceIn("fox\n", [{ line: 1, start: 0, text: "foo" }], re, "bar", false)).toBeUndefined()
  })
})

describe("results", () => {
  const files: SearchFile[] = [
    { path: "a.ts", hash: "h1", lines: [{ line: 2, text: "foo(foo)" }] },
    // A line ripgrep matched that JavaScript does not (an engine difference) lists nothing.
    { path: "b.ts", hash: "h2", lines: [{ line: 1, text: "nothing" }] },
  ]

  test("files with their matches, one row per match under its file, collapsed files without them", () => {
    const entries = matchFiles(files, query("foo"))
    expect(entries.map((entry) => [entry.file.path, entry.matches.map((match) => match.start)])).toEqual([
      ["a.ts", [0, 4]],
    ])
    expect(searchRows(entries, {}).map((row) => row.key)).toEqual(["a.ts", "a.ts:2:0", "a.ts:2:4"])
    expect(searchRows(entries, { "a.ts": true }).map((row) => [row.type, row.key])).toEqual([["file", "a.ts"]])
  })

  test("after a write the listed lines show the file's new text and hash", () => {
    expect(relisted(files[0], "﻿x\nbar(foo)\n", "h3")).toEqual({
      path: "a.ts",
      hash: "h3",
      lines: [{ line: 2, text: "bar(foo)" }],
    })
  })
})
