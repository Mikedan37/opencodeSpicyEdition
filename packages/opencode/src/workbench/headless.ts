// A headless run (`opencode run` without --auto, `opencode github run`) has nobody to answer a permission ask: the ask
// is rejected, and this line says what needed approval and how to give it without a person there. A CI run's session
// starts with both auto-approve switches on, so the GitHub agent edits and runs commands out of the box; what still
// asks (MCP tools, subagents, other directories, .git/) is rejected with that line, and denies still apply.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect } from "effect"
import type { Permission } from "@/permission"
import { SessionAutoApprove } from "./auto-approve"

export function needsApproval(ask: { permission: string; patterns: readonly string[] }, how: string) {
  return `${ask.permission} needs approval (${ask.patterns.join(", ")}); ${how}`
}

/** Rejects every permission ask as soon as it is made and reports it, so a run without a person fails fast. */
export function rejectAsks(
  events: EventV2.Interface,
  permission: Permission.Interface,
  how: string,
  report: (message: string) => void,
) {
  return events.listen((event) => {
    if (event.type !== PermissionV1.Event.Asked.type) return Effect.void
    const ask = event.data as PermissionV1.Request
    report(needsApproval(ask, how))
    return permission.reply({ requestID: ask.id, reply: "reject" }).pipe(Effect.ignore)
  })
}

/** The session rules of a CI run: no questions (nobody answers), edits and shell commands auto-approved. */
export function ciPermission(): PermissionV1.Rule[] {
  return [
    { permission: "question", pattern: "*", action: "deny" },
    ...SessionAutoApprove.apply([], { edits: true, commands: true }),
  ]
}

export * as Headless from "./headless"
