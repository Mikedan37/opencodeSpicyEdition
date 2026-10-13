// The main chat's per-session switches: in this session, edits and/or shell commands run without asking. Each switch is
// one rule in the session's own permission ruleset, under a key no tool asks for, so it lasts as long as the session and
// never reaches another one (a subagent's session inherits only its parent's denies). They are not "allow" rules for
// edit and bash: session rules override the agent's, so those would also lift plan mode's edit deny. Instead `ruleset`
// turns the agent's blanket asks for edit or bash into allows where they stand. Every deny, every rule for specific
// files or commands, and every rule of the session itself (Agent HQ's guard) still applies after them. Edits under
// .git/ keep asking: an edited .git/config (core.fsmonitor) or hook would turn harmless git commands into code
// execution. The same lift, for one ask, lets the shell tool's harmless commands run (tool/shell.ts).
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Permission } from "@/permission"
import { WorkbenchApprovals } from "./approvals"

const KEY = "session.auto_approve"
const PATTERN = { edits: "edit", commands: "bash" } as const
export type Switches = { edits: boolean; commands: boolean }

const isSwitch = (rule: PermissionV1.Rule) => rule.permission === KEY && rule.action === "allow"

/** The session's switches. The single switch from before (pattern "*") counts as both. */
export function state(session: PermissionV1.Ruleset): Switches {
  const on = (pattern: string) =>
    session.some((rule) => isSwitch(rule) && (rule.pattern === pattern || rule.pattern === "*"))
  return { edits: on(PATTERN.edits), commands: on(PATTERN.commands) }
}

/** The session's rules with these switches; its other rules keep their order. */
export function apply(session: PermissionV1.Ruleset, next: Switches): PermissionV1.Rule[] {
  return [
    ...session.filter((rule) => !isSwitch(rule)),
    ...(["edits", "commands"] as const)
      .filter((name) => next[name])
      .map((name): PermissionV1.Rule => ({ permission: KEY, pattern: PATTERN[name], action: "allow" })),
  ]
}

/** The ask being checked; `metadata.harmless` is the shell tool's verdict on its command. */
export type Request = Pick<PermissionV1.Request, "permission" | "patterns" | "metadata">

/**
 * What a request in this session is checked against: the agent's rules, then the session's, as upstream merges them.
 * A switch that is on (or a harmless shell command, for its bash ask) lifts the agent's blanket asks (pattern "*")
 * for that permission: each is followed by an allow, and the permission starts allowed.
 */
export function ruleset(
  agent: PermissionV1.Ruleset,
  session: PermissionV1.Ruleset,
  request?: Request,
): PermissionV1.Rule[] {
  const on = state(session)
  const keys = [
    ...(on.edits && !(request?.permission === "edit" && request.patterns.some(WorkbenchApprovals.gitPath))
      ? ["edit"]
      : []),
    ...(on.commands || (request?.permission === "bash" && request.metadata?.harmless === true) ? ["bash"] : []),
  ]
  if (!keys.length) return Permission.merge(agent, session)
  const allow = (permission: string): PermissionV1.Rule => ({ permission, pattern: "*", action: "allow" })
  const lifted = [
    ...keys.map(allow),
    ...agent.flatMap((rule) =>
      rule.action === "ask" && rule.pattern === "*"
        ? [rule, ...keys.filter((key) => Wildcard.match(key, rule.permission)).map(allow)]
        : [rule],
    ),
  ]
  return Permission.merge(lifted, session)
}

export * as SessionAutoApprove from "./auto-approve"
