import { describe, expect, test } from "bun:test"
import { ansiLines, fileRefs, resolvePath } from "./ansi"

describe("ansi", () => {
  test("styles carry across segments and lines until reset; other escapes are dropped", () => {
    expect(ansiLines("a\x1b[1;31mred\nstill\x1b[0m done\x1b[2K\r\n\x1b]0;title\x07end")).toEqual([
      [{ text: "a" }, { text: "red", style: { bold: true, fg: "var(--ansi-red)" } }],
      [{ text: "still", style: { bold: true, fg: "var(--ansi-red)" } }, { text: " done" }],
      [{ text: "end" }],
    ])
  })

  test("256-color, truecolor, bright and background codes", () => {
    const [line] = ansiLines("\x1b[38;5;196ma\x1b[38;2;10;20;30;48;5;244mb\x1b[39;49;92mc\x1b[22;3md")
    expect(line).toEqual([
      { text: "a", style: { fg: "rgb(255, 0, 0)" } },
      { text: "b", style: { fg: "rgb(10, 20, 30)", bg: "rgb(128, 128, 128)" } },
      { text: "c", style: { fg: "var(--ansi-green)" } },
      { text: "d", style: { fg: "var(--ansi-green)", italic: true } },
    ])
  })

  test("finds file references, never inside URLs", () => {
    const refs = (text: string) => fileRefs(text).flatMap((part) => ("file" in part ? [part] : []))
    expect(refs("src/a.ts(3,5): error TS2322")).toEqual([
      { text: "src/a.ts(3,5)", file: "src/a.ts", line: 3, column: 5 },
    ])
    expect(refs("/Users/me/x.swift:12:4: error: nope")).toEqual([
      { text: "/Users/me/x.swift:12:4", file: "/Users/me/x.swift", line: 12, column: 4 },
    ])
    expect(refs("./main.go:5: unused, see C:\\proj\\lib.rs:7")).toEqual([
      { text: "./main.go:5", file: "./main.go", line: 5 },
      { text: "C:\\proj\\lib.rs:7", file: "C:\\proj\\lib.rs", line: 7 },
    ])
    expect(refs("https://example.com:443/x.ts:1 at 12:30 v1.2:3")).toEqual([])
    expect(fileRefs("before a.ts:1 after").map((part) => part.text)).toEqual(["before ", "a.ts:1", " after"])
  })

  test("resolves relative paths against the run directory", () => {
    expect(resolvePath("/repo/app", "./src/../lib/a.ts")).toBe("/repo/app/lib/a.ts")
    expect(resolvePath("/repo/app", "/abs/b.ts")).toBe("/abs/b.ts")
    expect(resolvePath("/repo", "../../../x.ts")).toBe("/x.ts")
    expect(resolvePath("C:\\proj", "src\\c.rs")).toBe("C:\\proj\\src\\c.rs")
  })
})
