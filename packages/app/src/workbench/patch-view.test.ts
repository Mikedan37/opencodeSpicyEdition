import { describe, expect, test } from "bun:test"
import { splitPatch } from "./patch-view"

describe("patch view", () => {
  test("splits a unified diff per file, git's and jsdiff's, named after the new file", () => {
    const git =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
    expect(splitPatch(git).map((item) => item.file)).toEqual(["src/a.ts", "old.ts"])
    expect(splitPatch(git)[0]!.patch).toBe(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    )
    const jsdiff =
      "Index: a.txt\n===================================================================\n--- a.txt\t\n+++ a.txt\t\n@@ -1 +1 @@\n-one\n+ONE\n" +
      "Index: b.txt\n===================================================================\n--- b.txt\t\n+++ b.txt\t\n@@ -1 +1 @@\n-two\n+TWO"
    expect(splitPatch(jsdiff).map((item) => [item.file, item.patch.endsWith("\n")])).toEqual([
      ["a.txt", true],
      ["b.txt", true],
    ])
    // No file marker: one file, named from its headers.
    expect(splitPatch("--- x.py\n+++ x.py\n@@ -1 +1 @@\n-a\n+b\n").map((item) => item.file)).toEqual(["x.py"])
    expect(splitPatch("")).toEqual([])
  })
})
