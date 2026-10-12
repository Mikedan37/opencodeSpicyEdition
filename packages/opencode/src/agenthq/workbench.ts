// The Workbench tools for external agents: one stdio MCP server, `opencode workbench mcp`, run by this same
// opencode and pointed at this process's HTTP server and the session's directory (a task's worktree when the
// task is isolated). Tool calls go through the agent's own permission flow like any other tool.
//
// Secrets: the server password goes only into the MCP server's environment, never into its arguments, and
// nothing else from this process's environment is passed along.
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import { fileURLToPath } from "url"
import type { AgentProvider } from "./provider"

export const NAME = "opencode-workbench"

/** How to run this opencode again: the compiled binary itself, or Bun with this tree's entry point. */
function self(): string[] | undefined {
  // A Node build (the desktop's utility-process server) has no CLI of its own unless it is told where one is.
  if (typeof Bun === "undefined") return process.env.OPENCODE_BIN_PATH ? [process.env.OPENCODE_BIN_PATH] : undefined
  if (import.meta.url.includes("/$bunfs/") || import.meta.url.includes("/~BUN/")) return [process.execPath]
  return [process.execPath, "run", fileURLToPath(new URL("../index.ts", import.meta.url))]
}

/** The Workbench MCP server for an agent working in `directory`, or undefined when this process serves no HTTP. */
export const server = Effect.fnUntraced(function* (directory: string) {
  const command = self()
  if (!command) return undefined
  // Imported lazily: the server module imports the routes, which import Agent HQ.
  const { Server } = yield* Effect.promise(() => import("@/server/server"))
  if (!Server.url) return undefined
  const url = new URL(Server.url)
  // A server listening on every interface is reached through loopback.
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1"
  const password = Flag.OPENCODE_SERVER_PASSWORD
  const result: AgentProvider.McpServer = {
    name: NAME,
    command: command[0],
    args: [...command.slice(1), "workbench", "mcp", "--url", url.origin, "--directory", directory],
    env: password
      ? { OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME ?? "opencode", OPENCODE_SERVER_PASSWORD: password }
      : {},
  }
  return result
})

export * as AgentWorkbench from "./workbench"
