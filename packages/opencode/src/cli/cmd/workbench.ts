import path from "path"
import { cmd } from "./cmd"

// `opencode workbench mcp`: the workbench tools for agents outside opencode, as a stdio MCP server that proxies to
// a running opencode server. Whoever spawns it passes the server and project; nothing is hardcoded.
const McpCommand = cmd({
  command: "mcp",
  describe:
    "serve the workbench tools (problems, check, doctor, debug_*) over MCP on stdio, backed by a running opencode server",
  builder: (yargs) =>
    yargs
      .option("url", {
        type: "string",
        describe: "opencode server URL (default: $OPENCODE_SERVER_URL)",
      })
      .option("directory", {
        type: "string",
        describe: "project directory (default: $OPENCODE_DIRECTORY, else the current directory)",
      }),
  async handler(args) {
    const url = args.url ?? process.env.OPENCODE_SERVER_URL
    if (!url) {
      // stdout belongs to the MCP protocol
      process.stderr.write("opencode workbench mcp: pass --url or set OPENCODE_SERVER_URL\n")
      process.exitCode = 1
      return
    }
    const { WorkbenchBridge } = await import("@/workbench/mcp/bridge")
    const { WorkbenchDebugBridge } = await import("@/workbench/mcp/debug") // spicy: debug_* tools (dap)
    // Credentials come from OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD, never from arguments.
    await WorkbenchBridge.serve(
      {
        url,
        directory: path.resolve(args.directory ?? process.env.OPENCODE_DIRECTORY ?? process.cwd()),
      },
      WorkbenchDebugBridge.tools(), // spicy: debug_* tools (dap)
    )
  },
})

export const WorkbenchCommand = cmd({
  command: "workbench",
  describe: "workbench tools for agents outside opencode",
  builder: (yargs) => yargs.command(McpCommand).demandCommand(),
  async handler() {},
})
