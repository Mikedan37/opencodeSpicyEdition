// spicy: the opencode session the Workbench MCP bridge acts in for agent tools (debug_*, tool_create, custom_*). One
// per bridge process, created on first use; the outside agent's asks appear there in the IDE.
import { Schema } from "effect"
import type { WorkbenchBridge } from "./bridge"

const decode = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))

export type Session = (api: WorkbenchBridge.Api) => Promise<string>

export function agentSession(): Session {
  const state: { id?: Promise<string> } = {}
  return (api) => {
    state.id ??= api
      .post("/session", { title: "Workbench MCP" })
      .then((body) => decode(body).id)
      .catch((error: unknown) => {
        state.id = undefined
        throw error
      })
    return state.id
  }
}

export * as WorkbenchBridgeSession from "./session"
