import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return

  const id = sessionTreeIDs(session, sessionID).find((id) => request[id]?.some(include))
  if (!id) return
  return request[id]?.find(include)
}

// spicy: the session and its subagents' sessions, parents first (sessionTreeRequest's walk, shared with the queue below)
function sessionTreeIDs(session: Session[], sessionID: string) {
  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    if (!list) acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID])
  const ids = [sessionID]
  for (const id of ids) {
    const list = map.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }
  return ids
}

// spicy: every pending permission request in the tree, in the order the dock shows them (the approval card's "2 of 3")
export function sessionPermissionRequests(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include: (item: PermissionRequest) => boolean = () => true,
) {
  if (!sessionID) return []
  return sessionTreeIDs(session, sessionID).flatMap((id) => (request[id] ?? []).filter(include))
}

export function sessionPermissionRequest(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionQuestionRequest(
  session: Session[],
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}
