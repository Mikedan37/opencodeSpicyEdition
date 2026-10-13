// spicy: the tool creator in the Workbench MCP bridge. tool_create drafts a tool for the user to approve, and each
// tool they enabled is listed as custom_<name> with the JSON Schema of its args, looked up on every tools/list.
// Calls are POST /workbench/tools/agent as the bridge's opencode session, so the asks (custom_*, and the draft's
// edit) appear in the IDE. Approving, enabling and test runs stay in the IDE: they are not tools here.
import { Workbench } from "@opencode-ai/schema/workbench"
import { Schema } from "effect"
import DESCRIPTION from "../tools/create.txt"
import { WorkbenchBridge } from "./bridge"
import { WorkbenchBridgeSession } from "./session"

const decodeResult = Schema.decodeUnknownSync(Schema.toCodecJson(Workbench.CustomToolResult))
const decodeList = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Workbench.CustomTool)))

/** tool_create plus the enabled created tools, for `WorkbenchBridge.create`'s `extra`. */
export function tools(session = WorkbenchBridgeSession.agentSession()) {
  const run = (tool: string) => async (args: unknown, api: WorkbenchBridge.Api) => {
    const result = decodeResult(await api.post("/workbench/tools/agent", { sessionID: await session(api), tool, args }))
    return { text: result.output, data: result.metadata }
  }
  const create = WorkbenchBridge.define({
    name: "tool_create",
    title: "Create a tool",
    description: DESCRIPTION,
    input: Workbench.CustomToolDraft,
    run: run("tool_create"),
  })
  return async (api: WorkbenchBridge.Api): Promise<WorkbenchBridge.Tool[]> => {
    // A server that cannot list them leaves just tool_create; the next tools/list asks again.
    const listed = await api
      .get("/workbench/tools")
      .then(decodeList)
      .catch(() => [])
    return [
      create,
      ...listed
        .filter((tool) => tool.status === "enabled")
        .map((tool) =>
          WorkbenchBridge.define({
            name: tool.id,
            title: tool.id,
            description: tool.description,
            input: Schema.Record(Schema.String, Schema.Unknown), // the server checks the args against the tool's schema
            jsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
            run: run(tool.id),
          }),
        ),
    ]
  }
}

export * as WorkbenchToolsBridge from "./tools"
