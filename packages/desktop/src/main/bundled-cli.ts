// spicy: the opencode CLI bundled with the app (moved out of background-cli.ts, which keeps using it). The v2
// background service runs it; the v1 sidecar's server runs under Node and has no CLI of its own, so it gets this one
// as OPENCODE_BIN_PATH, and Agent HQ re-runs it as the Workbench MCP server it gives external agents.
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))

export function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}

/** In the app's resources when packaged, in this tree's resources in development. */
export function bundledCli(packaged: boolean, resourcesPath: string) {
  return packaged ? join(resourcesPath, executableName()) : join(root, "../../resources", executableName())
}

/** OPENCODE_BIN_PATH for the v1 sidecar, when the bundled CLI exists. */
export function bundledCliEnv(packaged: boolean, resourcesPath: string): Record<string, string> {
  const cli = bundledCli(packaged, resourcesPath)
  return existsSync(cli) ? { OPENCODE_BIN_PATH: cli } : {}
}
