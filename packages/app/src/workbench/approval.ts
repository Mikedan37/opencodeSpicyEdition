// The words of the approval card (approval-card.tsx), the project's saved approvals (Settings → Permissions) and the
// composer's approval modes, as pure functions.
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { AutoApprove } from "./client"

export type ApprovalVerb =
  | "run"
  | "edit"
  | "read"
  | "start"
  | "access"
  | "fetch"
  | "search"
  | "debug"
  | "evaluate"
  | "repeat"
  | "use"

// By permission name; anything else (MCP tools, custom tools, skills, todos) is "Use".
const VERBS: Record<string, ApprovalVerb> = {
  bash: "run",
  "verify.exec": "run",
  "debug.lldbCommand": "run",
  edit: "edit",
  read: "read",
  task: "start",
  external_directory: "access",
  webfetch: "fetch",
  websearch: "search",
  codesearch: "search",
  glob: "search",
  grep: "search",
  "debug.launch": "debug",
  "debug.evaluate": "evaluate",
  doom_loop: "repeat",
}

// A command longer than this also shows in full under the title, which keeps to one line.
const LONG = 60

type Ask = Pick<PermissionRequest, "permission" | "patterns" | "metadata">

const text = (request: Ask, key: string) => {
  const value = request.metadata[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

// A shell command asks with the command it runs; its patterns are only the parsed pieces of it.
const command = (request: Ask) =>
  request.permission === "bash" || request.permission === "debug.lldbCommand" ? text(request, "command") : undefined

/** The things a request asks about, in words: a folder's glob reads as the folder. */
export function approvalThings(request: Ask) {
  return request.patterns
    .filter((pattern) => pattern && pattern !== "*")
    .map((pattern) =>
      request.permission === "external_directory" ? pattern.replace(/[/\\]\*$/, "") || pattern : pattern,
    )
}

/** "Run `bun test`", "Edit `src/app.ts` +2 more", "Use `github_create_issue`": a verb, a thing, and how many more. */
export function approvalTitle(request: Ask & { always?: string[] }) {
  const verb = VERBS[request.permission] ?? "use"
  const full = command(request)
  // A long command shows whole under the title; the title names its programs ("cd, bun test").
  if (full && long(full)) return { verb, object: programs(request) || full.split("\n")[0]!, more: 0 }
  if (full) return { verb, object: full, more: 0 }
  const things = approvalThings(request)
  return { verb, object: things[0] ?? request.permission, more: Math.max(0, things.length - 1) }
}

const long = (command: string) => command.includes("\n") || command.length > LONG

// A shell ask's always-patterns are its programs ("bun test *").
const programs = (request: Ask & { always?: string[] }) =>
  (request.always ?? [])
    .map((pattern) => pattern.replace(/ \*$/, ""))
    .filter((pattern) => pattern && pattern !== "*")
    .join(", ")

/** What shows under the title: a command the title cuts short, an edit's diff, or a subagent's task. */
export function approvalDetail(request: Ask): { kind: "command" | "diff" | "note"; text: string } | undefined {
  if (request.permission === "edit") {
    const diff = text(request, "diff")
    return diff ? { kind: "diff", text: diff } : undefined
  }
  if (request.permission === "task") {
    const note = text(request, "description")
    return note ? { kind: "note", text: note } : undefined
  }
  // A shell command that reaches outside the project asks for the folder; the command shows under it.
  if (request.permission === "external_directory") {
    const full = text(request, "command")
    return full ? { kind: "command", text: full } : undefined
  }
  const full = command(request)
  if (full && long(full)) return { kind: "command", text: full }
}

export type ApprovalKind = "command" | "edit" | "tool"

export const approvalKind = (permission: string): ApprovalKind =>
  permission === "bash" ? "command" : permission === "edit" ? "edit" : "tool"

/**
 * An allow rule in words: `bun test *` reads "bun test …". `everything` is a rule for every command or edit (the UI
 * says "all commands" / "all edits"); a tool's rule for every use reads as the tool's name.
 */
export function approvalRule(rule: { permission: string; pattern: string }) {
  const kind = approvalKind(rule.permission)
  if (rule.pattern !== "*")
    return {
      kind,
      everything: false,
      text: rule.pattern.endsWith("*") ? `${rule.pattern.slice(0, -1)}…` : rule.pattern,
    }
  return { kind, everything: kind !== "tool", text: rule.permission }
}

/** Where the first pending request sits in the run the card has shown since its queue was last empty ("2 of 3"). */
export function approvalQueue(seen: readonly string[], pending: readonly string[]) {
  if (!pending.length) return { seen: [] as string[], position: 0, total: 0 }
  const next = [...seen, ...pending.filter((id) => !seen.includes(id))]
  return { seen: next, position: next.length - pending.length + 1, total: next.length }
}

export type ApprovalMode = "ask" | "edits" | "auto"

/** The composer's modes and the session's two switches. */
export const APPROVAL_MODES: Record<ApprovalMode, AutoApprove> = {
  ask: { edits: false, commands: false },
  edits: { edits: true, commands: false },
  auto: { edits: true, commands: true },
}

// ponytail: commands without edits is no mode (only the raw API sets it); it shows as Auto, the mode that warns.
export const approvalMode = (value: AutoApprove): ApprovalMode =>
  value.commands ? "auto" : value.edits ? "edits" : "ask"
