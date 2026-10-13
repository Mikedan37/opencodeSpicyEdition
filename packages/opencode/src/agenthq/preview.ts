// What a permission request is about, built the same way for every adapter (AgentHQ.PermissionPreview): an edit as a
// unified diff of a file relative to the project, a command and where it runs, or one line. The provider's raw request
// data stays in `details`.
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { createTwoFilesPatch } from "diff"
import { realpathSync } from "fs"
import path from "path"

export * as AgentPreview from "./preview"

/** Enough for the edits people approve one by one; anything longer says it was cut. */
export const DIFF_LIMIT = 32_000
const SUMMARY_LIMIT = 500

/** `file` relative to `root` when it is inside it, else as given. */
export function relative(root: string, file: string) {
  const inside = path.relative(root, path.resolve(root, file))
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? inside : file
}

/** A unified diff whose file headers (`Index:`, `---`, `+++`) name files relative to `root`, as given or resolved. */
export function relativeHeaders(diff: string, root: string) {
  const roots = [root, ...resolved(root)].map((item) => (item.endsWith(path.sep) ? item : item + path.sep))
  return diff
    .split("\n")
    .map((line) => {
      const header = /^(Index: |--- |\+\+\+ )(.*)$/.exec(line)
      const root = header && roots.find((item) => header[2]!.startsWith(item))
      return header && root ? header[1] + header[2]!.slice(root.length) : line
    })
    .join("\n")
}

function resolved(file: string) {
  try {
    return [realpathSync(file)]
  } catch {
    return []
  }
}

export function edit(file: string, diff: string): AgentHQ.PermissionPreview {
  if (diff.length <= DIFF_LIMIT) return { kind: "edit", path: file, diff }
  return { kind: "edit", path: file, diff: diff.slice(0, DIFF_LIMIT), truncated: true }
}

/** An edit from the file's text before and after. */
export function change(file: string, before: string, after: string) {
  return edit(file, createTwoFilesPatch(file, file, before, after, undefined, undefined, { context: 3 }))
}

export function command(line: string, cwd?: string): AgentHQ.PermissionPreview {
  return { kind: "command", command: line, ...(cwd ? { cwd } : {}) }
}

export function other(summary: string): AgentHQ.PermissionPreview {
  return { kind: "other", summary: summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT) }
}
