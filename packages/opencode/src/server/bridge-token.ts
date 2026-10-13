// spicy: the Workbench MCP bridge's own credential. Agent HQ gives each bridge it starts a random token instead of the
// server password (agenthq/workbench.ts), minted for the one project directory the bridge serves: the session's working
// directory, a task's worktree when the task is isolated. A request that carries one (`Authorization: Bearer <token>`)
// reaches only the endpoints the bridge calls (ROUTES), only in that directory, and always as an agent: checks run with
// trigger "agent", and agent tools run only in the one opencode session the token made for itself. Tokens live in this
// process's memory, are never written anywhere, and end with the Agent HQ session that got them.
import { randomBytes } from "crypto"
import { realpathSync } from "fs"
import path from "path"

export * as BridgeToken from "./bridge-token"

/** What a live token holds: its directory (resolved), and the opencode session it made through POST /workbench/session. */
export interface Grant {
  readonly directory: string
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

/** The real path, or undefined when there is none. */
function real(file: string) {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

/** A new token for `directory`, valid until `revoke`. */
export function mint(directory: string) {
  const token = randomBytes(32).toString("base64url")
  live.set(token, { directory: real(directory) ?? path.resolve(directory) })
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

/**
 * Whether a token's request may run: one of ROUTES, aimed at the token's directory. The directory is picked as
 * workspace routing and the instance context pick it (`?directory=`, else `x-opencode-directory`, else this process's
 * working directory; URI-decoded) and resolved; another workspace (`?workspace=`) is never the token's.
 */
export function reaches(
  grant: Grant,
  request: { readonly url: string; readonly headers: Readonly<Record<string, string | undefined>> },
  endpoint: string,
) {
  if (!ROUTES.has(endpoint)) return false
  const url = new URL(request.url, "http://localhost")
  if (url.searchParams.has("workspace")) return false
  const asked = url.searchParams.get("directory") || request.headers["x-opencode-directory"] || process.cwd()
  return real(decode(asked)) === grant.directory
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}
