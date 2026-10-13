// The main chat's per-session switch: in this session, edits and shell commands run without asking. The switch is one
// rule in the session's own permission ruleset, a key no tool asks for, so it lasts as long as the session and never
// reaches another one (a subagent's session inherits only its parent's denies). It is not an "allow" rule for edit and
// bash: session rules override the agent's, so that would also lift plan mode's edit deny. Instead `ruleset` turns the
// blanket asks for edit and bash into allows where they stand, and every deny still applies.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Permission } from "@/permission"

export const SWITCH: PermissionV1.Rule = { permission: "session.auto_approve", pattern: "*", action: "allow" }
const KEYS = ["edit", "bash"]

const isSwitch = (rule: PermissionV1.Rule) =>
  rule.permission === SWITCH.permission && rule.pattern === SWITCH.pattern && rule.action === SWITCH.action

/** Whether a session's rules hold the switch. */
export function enabled(session: PermissionV1.Ruleset) {
  return session.some(isSwitch)
}

/** The session's rules with the switch on or off; its other rules keep their order. */
export function apply(session: PermissionV1.Ruleset, on: boolean): PermissionV1.Rule[] {
  return [...session.filter((rule) => !isSwitch(rule)), ...(on ? [SWITCH] : [])]
}

/**
 * What a request in this session is checked against: the agent's rules, then the session's, as upstream merges them.
 * With the switch on, every blanket ask (pattern "*") that covers edit or bash is followed by an allow for them, and
 * both start allowed (later rules still override that), so only those asks change: plan mode's deny, a user's deny or
 * ask for some files or commands (bash "git push*": "ask") and a session's deny keep applying, and MCP tools,
 * subagents and edits outside the project still ask.
 */
export function ruleset(agent: PermissionV1.Ruleset, session: PermissionV1.Ruleset): PermissionV1.Rule[] {
  const rules = Permission.merge(agent, session)
  if (!enabled(session)) return rules
  const allow = (permission: string, pattern: string): PermissionV1.Rule => ({ permission, pattern, action: "allow" })
  return [
    ...KEYS.map((key) => allow(key, "*")),
    ...rules.flatMap((rule) =>
      rule.action === "ask" && rule.pattern === "*"
        ? [rule, ...KEYS.filter((key) => Wildcard.match(key, rule.permission)).map((key) => allow(key, "*"))]
        : [rule],
    ),
  ]
}

export * as SessionAutoApprove from "./auto-approve"
