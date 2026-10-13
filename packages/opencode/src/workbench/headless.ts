// A headless run (`opencode run` without --auto, `opencode github run`) has nobody to answer a permission ask: the ask
// is rejected, and this line says what needed approval and how to give it without a person there.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect } from "effect"
import type { Permission } from "@/permission"

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

export * as Headless from "./headless"
