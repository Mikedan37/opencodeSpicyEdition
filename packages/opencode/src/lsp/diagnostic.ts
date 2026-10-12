import * as LSPClient from "./client"

const MAX_PER_FILE = 20

export function pretty(diagnostic: LSPClient.Diagnostic) {
  const severityMap = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }

  const severity = severityMap[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  // spicy: name the checker and rule, e.g. "clangd(-Wint-conversion): ", so the agent can tell them apart (DIAG-10)
  const origin = `${diagnostic.source ?? ""}${diagnostic.code === undefined ? "" : `(${diagnostic.code})`}`

  return `${severity} [${line}:${col}] ${origin ? `${origin}: ` : ""}${diagnostic.message}`
}

export function report(file: string, issues: LSPClient.Diagnostic[]) {
  const errors = issues.filter((item) => item.severity === 1)
  if (errors.length === 0) return ""
  const limited = errors.slice(0, MAX_PER_FILE)
  const more = errors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  // spicy: warnings stay out of the list but are counted (DIAG-10)
  const warnings = issues.filter((item) => item.severity === 2).length
  const counted = warnings > 0 ? `\n(${warnings} warning${warnings === 1 ? "" : "s"} not shown)` : ""
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}${counted}\n</diagnostics>`
}

// spicy: tool metadata keeps the reported files' diagnostics plus workspace-wide counts, not the whole workspace
// map that every edit, write and apply_patch part used to carry (REG-08)
export function metadata(all: Record<string, LSPClient.Diagnostic[]>, files: string[]) {
  const issues = Object.values(all).flat()
  return {
    diagnostics: Object.fromEntries(files.filter((file) => all[file]).map((file) => [file, all[file]])),
    diagnosticCounts: {
      error: issues.filter((item) => item.severity === 1).length,
      warning: issues.filter((item) => item.severity === 2).length,
      info: issues.filter((item) => item.severity === 3).length,
      hint: issues.filter((item) => item.severity === 4).length,
    },
  }
}

export * as Diagnostic from "./diagnostic"
