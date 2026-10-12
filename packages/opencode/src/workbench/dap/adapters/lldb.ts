// lldb-dap (C, C++, Swift, Rust). Launching or attaching needs macOS Developer Mode: without
// it macOS shows an admin password prompt, so the session is refused up front instead.
import { Process } from "@/util/process"

export const DEVELOPER_MODE_OFF = "Developer Mode off — run sudo DevToolsSecurity -enable"

export async function resolve(): Promise<{ binary: string } | { error: string }> {
  if (process.platform === "darwin") {
    const out = await Process.text(["xcrun", "-f", "lldb-dap"], {
      nothrow: true,
      abort: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    const found = out?.code === 0 ? out.text.trim() : ""
    if (found) return { binary: found }
  }
  const found = Bun.which("lldb-dap")
  if (found) return { binary: found }
  return { error: "lldb-dap was not found (install Xcode or LLVM)" }
}

export async function developerMode() {
  if (process.platform !== "darwin") return true
  const out = await Process.text(["DevToolsSecurity", "-status"], {
    nothrow: true,
    abort: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  return /\benabled\b/i.test(out?.text ?? "") && !/disabled/i.test(out?.text ?? "")
}

/**
 * Variable REPL mode for every session: LLDB command mode runs host commands (platform shell,
 * script), so the console evaluates expressions unless a human uses the ` escape prefix.
 */
export function command(binary: string) {
  return [binary, "--repl-mode", "variable"]
}

export * as Lldb from "./lldb"
