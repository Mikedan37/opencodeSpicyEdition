import { describe, expect, test } from "bun:test"
import { AgentPreview } from "../../src/agenthq/preview"

describe("agenthq permission previews", () => {
  test("diff headers lose only a leading project root; long diffs are cut and say so", () => {
    // The root as given may sit inside a resolved path (/var in /private/var): only a leading root goes.
    const diff = "Index: /private/var/p/a.txt\n--- /var/p/a.txt\n+++ /var/p/a.txt\n@@ -1 +1 @@\n-/var/p/x\n+y"
    expect(AgentPreview.relativeHeaders(diff, "/var/p")).toBe(
      "Index: /private/var/p/a.txt\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-/var/p/x\n+y",
    )
    const long = AgentPreview.change("a.txt", "", "x\n".repeat(AgentPreview.DIFF_LIMIT))
    expect(long).toMatchObject({ kind: "edit", path: "a.txt", truncated: true })
    expect(long.kind === "edit" && long.diff.length).toBe(AgentPreview.DIFF_LIMIT)
    expect(AgentPreview.change("a.txt", "a\n", "b\n")).toEqual({
      kind: "edit",
      path: "a.txt",
      diff: expect.stringContaining("-a\n+b\n"),
    })
  })
})
