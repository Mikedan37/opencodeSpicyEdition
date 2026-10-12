import { describe, expect, test } from "bun:test"
import { LSP } from "@/lsp/lsp"
import type { LSPClient } from "@/lsp/client"

// spicy: DIAG-10 agent report format and REG-08 tool metadata

const at = (line: number, character: number, rest: Partial<LSPClient.Diagnostic>): LSPClient.Diagnostic => ({
  range: { start: { line, character }, end: { line, character: character + 1 } },
  message: "",
  ...rest,
})

describe("LSP.Diagnostic.report (DIAG-10)", () => {
  test("golden: errors only, with source and code, plus a warnings count", () => {
    const report = LSP.Diagnostic.report("/repo/main.c", [
      at(2, 10, {
        severity: 1,
        source: "clangd",
        code: "-Wint-conversion",
        message: "incompatible pointer to integer conversion",
      }),
      at(4, 0, { severity: 2, source: "clangd", code: "-Wunused-variable", message: "unused variable 'x'" }),
      at(6, 2, { severity: 1, source: "typescript", code: 2322, message: "Type 'string' is not assignable" }),
      at(7, 0, { severity: 1, source: "SourceKit", message: "Cannot convert value" }),
      at(8, 4, { severity: 1, message: "no source or code" }),
      at(9, 0, { severity: 2, message: "second warning" }),
      at(10, 0, { severity: 3, message: "an info line" }),
    ])
    expect(report).toBe(
      [
        '<diagnostics file="/repo/main.c">',
        "ERROR [3:11] clangd(-Wint-conversion): incompatible pointer to integer conversion",
        "ERROR [7:3] typescript(2322): Type 'string' is not assignable",
        "ERROR [8:1] SourceKit: Cannot convert value",
        "ERROR [9:5] no source or code",
        "(2 warnings not shown)",
        "</diagnostics>",
      ].join("\n"),
    )
  })

  test("golden: keeps the 20 per file cap", () => {
    const errors = Array.from({ length: 23 }, (_, index) =>
      at(index, 0, { severity: 1, source: "ruff", code: "F821", message: `undefined name x${index}` }),
    )
    const lines = LSP.Diagnostic.report("/repo/app.py", [
      ...errors,
      at(30, 0, { severity: 2, message: "one warning" }),
    ]).split("\n")
    expect(lines).toHaveLength(24)
    expect(lines[1]).toBe("ERROR [1:1] ruff(F821): undefined name x0")
    expect(lines[20]).toBe("ERROR [20:1] ruff(F821): undefined name x19")
    expect(lines.slice(21)).toEqual(["... and 3 more", "(1 warning not shown)", "</diagnostics>"])
  })

  test("warnings alone produce no report", () => {
    expect(LSP.Diagnostic.report("/repo/a.ts", [at(0, 0, { severity: 2, message: "unused" })])).toBe("")
  })
})

describe("LSP.Diagnostic.metadata (REG-08)", () => {
  test("keeps only the reported files and counts the whole workspace", () => {
    const all = {
      "/repo/a.ts": [at(0, 0, { severity: 1, message: "a" }), at(1, 0, { severity: 2, message: "b" })],
      "/repo/b.ts": [at(0, 0, { severity: 1, message: "c" })],
      "/repo/c.ts": [at(0, 0, { severity: 4, message: "d" }), at(0, 0, { severity: 3, message: "e" })],
    }
    expect(LSP.Diagnostic.metadata(all, ["/repo/a.ts", "/repo/missing.ts"])).toEqual({
      diagnostics: { "/repo/a.ts": all["/repo/a.ts"] },
      diagnosticCounts: { error: 2, warning: 1, info: 1, hint: 1 },
    })
  })
})
