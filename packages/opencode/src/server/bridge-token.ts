// spicy: the Workbench MCP bridge's own credential. Agent HQ gives each bridge it starts a random token instead of the
// server password (agenthq/workbench.ts). A request that carries one (`Authorization: Bearer <token>`) reaches only
// the endpoints the bridge calls (ROUTES), always as an agent: checks run with trigger "agent", and agent tools run
// only in the one opencode session the token made for itself. Tokens live in this process's memory, are never written
// anywhere, and end with the Agent HQ session that got them.
import { randomBytes } from "crypto"

export * as BridgeToken from "./bridge-token"

/** What a live token holds: the opencode session it made through POST /workbench/session, once it has. */
export interface Grant {
  session?: string
}

const live = new Map<string, Grant>()

/**
 * The endpoints a token reaches, as `<HttpApi group>.<endpoint>`: everything `opencode workbench mcp` calls. Any other
 * endpoint answers 403; routes outside the instance API do not know tokens and answer 401.
 */
export const ROUTES: ReadonlySet<string> = new Set([
  "workbench.problems", // GET  /workbench/problems
  "workbench.check", // POST /workbench/check, always as trigger "agent"
  "workbench.doctor", // GET  /workbench/doctor
  "workbench.session", // POST /workbench/session, the token's one opencode session
  "workbench-debug.agent", // POST /workbench/debug/agent, in that session only
  "workbench-tools.list", // GET  /workbench/tools
  "workbench-tools.agent", // POST /workbench/tools/agent, in that session only
])

/** A new token, valid until `revoke`. */
export function mint() {
  const token = randomBytes(32).toString("base64url")
  live.set(token, {})
  return token
}

export function revoke(token: string | undefined) {
  if (token) live.delete(token)
}

/** The grant of the live token a request carries, if it carries one. */
export function of(request: { readonly headers: Readonly<Record<string, string | undefined>> }) {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1]
  return token === undefined ? undefined : live.get(token)
}
