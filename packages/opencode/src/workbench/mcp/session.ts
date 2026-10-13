// spicy: the opencode session the Workbench MCP bridge acts in for agent tools (debug_*, tool_create, custom_*). One
// per bridge process, from POST /workbench/session on first use; the outside agent's asks appear there in the IDE. A
// bridge token can act in no other session.
import { Schema } from "effect"
import type { WorkbenchBridge } from "./bridge"

const decode = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))

export type Session = (api: WorkbenchBridge.Api) => Promise<string>

export function agentSession(): Session {
  const state: { id?: Promise<string> } = {}
  return (api) => {
    state.id ??= api
      .post("/workbench/session", {})
      .then((body) => decode(body).id)
      .catch((error: unknown) => {
        state.id = undefined
        throw error
      })
    return state.id
  }
}

export * as WorkbenchBridgeSession from "./session"
