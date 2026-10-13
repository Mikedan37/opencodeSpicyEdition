import { describe, expect, test } from "bun:test"
import {
  APPROVAL_MODES,
  approvalDetail,
  approvalMode,
  approvalQueue,
  approvalRule,
  approvalTitle,
  type ApprovalMode,
} from "./approval"

const ask = (permission: string, patterns: string[], metadata: Record<string, unknown> = {}) => ({
  permission,
  patterns,
  metadata,
})

describe("the approval card's title", () => {
  test("a short verb and the thing it acts on", () => {
    expect(approvalTitle(ask("bash", ["bun test"], { command: "bun test" }))).toEqual({
      verb: "run",
      object: "bun test",
      more: 0,
    })
    expect(approvalTitle(ask("edit", ["src/app.ts"]))).toEqual({ verb: "edit", object: "src/app.ts", more: 0 })
    expect(approvalTitle(ask("read", [".env"]))).toEqual({ verb: "read", object: ".env", more: 0 })
    expect(approvalTitle(ask("task", ["explore"]))).toEqual({ verb: "start", object: "explore", more: 0 })
    expect(approvalTitle(ask("webfetch", ["https://example.com"]))).toMatchObject({ verb: "fetch" })
  })

  test("a tool that asks for every use names itself (MCP tools ask with their own name)", () => {
    expect(approvalTitle(ask("github_create_issue", ["*"]))).toEqual({
      verb: "use",
      object: "github_create_issue",
      more: 0,
    })
  })

  test("a folder outside the project reads as the folder", () => {
    expect(approvalTitle(ask("external_directory", ["/Users/me/x/*"]))).toEqual({
      verb: "access",
      object: "/Users/me/x",
      more: 0,
    })
  })

  test("more things count as +N more; a shell command shows whole, not its parsed pieces", () => {
    expect(approvalTitle(ask("edit", ["a.ts", "b.ts", "c.ts"]))).toEqual({ verb: "edit", object: "a.ts", more: 2 })
    expect(approvalTitle(ask("bash", ["cd src", "bun test"], { command: "cd src && bun test" }))).toEqual({
      verb: "run",
      object: "cd src && bun test",
      more: 0,
    })
    // Without the command (an old server) the patterns stand in
    expect(approvalTitle(ask("bash", ["git status", "git diff"]))).toEqual({
      verb: "run",
      object: "git status",
      more: 1,
    })
  })
})

describe("what shows under the title", () => {
  test("an edit's diff, a subagent's task, a long or multi-line command", () => {
    expect(approvalDetail(ask("edit", ["a.ts"], { diff: "Index: a.ts\n+x" }))).toEqual({
      kind: "diff",
      text: "Index: a.ts\n+x",
    })
    expect(approvalDetail(ask("task", ["explore"], { description: "Find the bug" }))).toEqual({
      kind: "note",
      text: "Find the bug",
    })
    expect(approvalDetail(ask("bash", ["bun test"], { command: "bun test" }))).toBeUndefined()
    const long = `bun test ${"x".repeat(80)}`
    expect(approvalDetail(ask("bash", ["bun test"], { command: long }))).toEqual({ kind: "command", text: long })
    expect(approvalDetail(ask("bash", ["a", "b"], { command: "a\nb" }))).toEqual({ kind: "command", text: "a\nb" })
    expect(approvalDetail(ask("external_directory", ["/tmp/*"], { command: "cat /tmp/x" }))).toEqual({
      kind: "command",
      text: "cat /tmp/x",
    })
    expect(approvalDetail(ask("github_create_issue", ["*"]))).toBeUndefined()
  })
})

describe("allow rules in words", () => {
  test("a trailing * reads …; * alone is every command or edit, or the tool", () => {
    expect(approvalRule({ permission: "bash", pattern: "bun test *" })).toEqual({
      kind: "command",
      everything: false,
      text: "bun test …",
    })
    expect(approvalRule({ permission: "edit", pattern: "*" })).toEqual({ kind: "edit", everything: true, text: "edit" })
    expect(approvalRule({ permission: "bash", pattern: "*" })).toMatchObject({ kind: "command", everything: true })
    expect(approvalRule({ permission: "webfetch", pattern: "*" })).toEqual({
      kind: "tool",
      everything: false,
      text: "webfetch",
    })
    expect(approvalRule({ permission: "skill", pattern: "release" })).toEqual({
      kind: "tool",
      everything: false,
      text: "release",
    })
  })
})

describe("the card's queue", () => {
  test("counts the run since the queue was empty", () => {
    let state = approvalQueue([], ["a", "b", "c"])
    expect(state).toEqual({ seen: ["a", "b", "c"], position: 1, total: 3 })
    state = approvalQueue(state.seen, ["b", "c"])
    expect(state).toMatchObject({ position: 2, total: 3 })
    // One more arrives mid-run
    state = approvalQueue(state.seen, ["c", "d"])
    expect(state).toMatchObject({ position: 3, total: 4 })
    // Empty starts over
    state = approvalQueue(state.seen, [])
    expect(state).toEqual({ seen: [], position: 0, total: 0 })
    expect(approvalQueue(state.seen, ["e"])).toMatchObject({ position: 1, total: 1 })
  })
})

describe("the composer's approval modes", () => {
  test("each mode is a pair of switches, and back", () => {
    expect(APPROVAL_MODES.ask).toEqual({ edits: false, commands: false })
    expect(APPROVAL_MODES.edits).toEqual({ edits: true, commands: false })
    expect(APPROVAL_MODES.auto).toEqual({ edits: true, commands: true })
    for (const mode of Object.keys(APPROVAL_MODES) as ApprovalMode[])
      expect(approvalMode(APPROVAL_MODES[mode])).toBe(mode)
  })

  test("commands without edits shows as Auto, the mode that warns", () => {
    expect(approvalMode({ edits: false, commands: true })).toBe("auto")
  })
})
