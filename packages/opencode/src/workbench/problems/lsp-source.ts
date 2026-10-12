import { fileURLToPath } from "url"
import type { LSPClient } from "@/lsp/client"
import type { Draft } from "./store"

const severities = { 1: "error", 2: "warning", 3: "info", 4: "hint" } as const

// One producer per language server and root, so one server's update replaces only its own slice.
export const producer = (event: LSPClient.DiagnosticsEvent) => `lsp:${event.serverID}:${event.root}`

// LSP ranges are already 0-based, which is what the Workbench contract uses.
export function problems(event: LSPClient.DiagnosticsEvent): Draft[] {
  return event.diagnostics.map((item) => ({
    file: event.file,
    range: item.range,
    severity: severities[item.severity ?? 1],
    message: item.message,
    code: item.code,
    codeHref: item.codeDescription?.href,
    related: item.relatedInformation
      ?.filter((info) => info.location.uri.startsWith("file://"))
      .map((info) => ({ file: fileURLToPath(info.location.uri), range: info.location.range, message: info.message })),
  }))
}

export * as LspSource from "./lsp-source"
