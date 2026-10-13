// The supervisor: a pure, deterministic function from (investigation, new event, time) to a
// decision. No model is involved; the rules only read what the server recorded.
import type { Workbench } from "@opencode-ai/schema/workbench"

export type Attempt = {
  readonly n: number
  readonly patchHash: string
  readonly errorFingerprints: readonly string[]
  readonly errorCount: number
  readonly checkIDs: readonly string[]
  // Unset until a check closes the attempt.
  readonly passed?: boolean
  readonly at: number
}

export type Input = {
  readonly policy: Workbench.RecoveryPolicy
  readonly attempts: readonly Attempt[]
  readonly steps: number
  readonly crashes: number
  // Budget window start: creation, or the last resume by the user.
  readonly since: number
}

export type Trigger = "patch" | "check" | "crash" | "permission" | "steps" | "other"

export type Decision = {
  readonly rule: Workbench.SupervisorRule
  readonly status: "blocked" | "needs_human" | "failed"
  readonly reason: string // a sentence, without the rule or run ids
  readonly runIDs?: readonly Workbench.RunID[] // the check runs it refers to
}

export function supervise(input: Input, trigger: Trigger, now: number, detail?: string): Decision | undefined {
  const policy = input.policy
  if (trigger === "crash" && input.crashes >= 2)
    return { rule: "S8", status: "failed", reason: "debugger unstable: the debug adapter crashed twice" }
  if (trigger === "permission" && policy.stopOnPermissionDenial)
    return { rule: "S7", status: "needs_human", reason: `permission denied${detail ? `: ${detail}` : ""}` }
  if (input.steps >= policy.maxDebugSteps)
    return {
      rule: "S5",
      status: "needs_human",
      reason: `debug step budget of ${policy.maxDebugSteps} used; the program stays paused`,
    }
  if (now - input.since >= policy.maxInvestigationDurationMs)
    return {
      rule: "S6",
      status: "needs_human",
      reason: `investigation reached its ${Math.round(policy.maxInvestigationDurationMs / 60_000)} minute limit`,
    }
  if (!policy.stopOnRepeatedFailures) return undefined
  const latest = input.attempts.at(-1)
  if (trigger === "patch" && latest && input.attempts.slice(0, -1).some((item) => item.patchHash === latest.patchHash))
    return { rule: "S3", status: "blocked", reason: "repeated identical patch" }
  if (trigger !== "check") return undefined
  const closed = input.attempts.filter((item) => item.passed !== undefined)
  const last = closed.at(-1)
  const previous = closed.at(-2)
  if (!last || last.passed) return undefined
  if (previous && !previous.passed && last.errorFingerprints.some((item) => previous.errorFingerprints.includes(item)))
    return {
      rule: "S2",
      status: "blocked",
      reason: "no progress: same error after 2 patches",
      runIDs: [...previous.checkIDs, ...last.checkIDs] as Workbench.RunID[],
    }
  if (previous && last.errorCount > previous.errorCount)
    return {
      rule: "S4",
      status: "blocked",
      reason: `each fix adds errors (${previous.errorCount} → ${last.errorCount})`,
    }
  if (closed.filter((item) => !item.passed).length >= policy.maxRepairAttempts)
    return {
      rule: "S1",
      status: "blocked",
      reason: "repair attempts used up",
      runIDs: closed.flatMap((item) => item.checkIDs) as Workbench.RunID[],
    }
  return undefined
}

/** Error identity for S2: tool, code, file and message with numbers normalized. */
export function fingerprint(problem: {
  readonly tool: string
  readonly code?: string | number
  readonly file?: string
  readonly message: string
}) {
  const message = problem.message.replace(/\d+/g, "#").replace(/\s+/g, " ").trim()
  return [problem.tool, problem.code ?? "", problem.file ?? "", message].join("|")
}

export * as Supervisor from "./supervisor"
