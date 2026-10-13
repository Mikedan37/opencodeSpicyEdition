// "Always allow in this project": allow rules the human saved from a permission ask. They are kept per project in
// Storage (workbench/approvals/<projectID>), cached in memory, and Permission.ask checks them after the ruleset's
// explicit denies, so they apply to every session of the project, subagents included, and never lift a deny. Edits
// under .git/ are never approved this way: an edited .git/config (core.fsmonitor) or hook would turn the git commands
// that run without asking into code execution.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Storage } from "@/storage/storage"

export const Rule = Schema.Struct({
  permission: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  pattern: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
}).annotate({ identifier: "WorkbenchApprovalRule" })
export type Rule = typeof Rule.Type

const decode = Schema.decodeUnknownOption(Rule)

/** Whether a path pattern is in a .git directory, or is a .git file (a linked worktree's pointer), in any case. */
export function gitPath(pattern: string) {
  return pattern
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part.toLowerCase() === ".git")
}

/** Whether a saved or remembered "always" may approve this request's pattern. */
export function approvable(permission: string, pattern: string) {
  return !(permission === "edit" && gitPath(pattern))
}

export interface Interface {
  /** The project's saved rules. */
  readonly list: () => Effect.Effect<readonly Rule[]>
  /** Adds rules (duplicates are kept once) and returns them all. */
  readonly save: (rules: readonly Rule[]) => Effect.Effect<readonly Rule[]>
  /** Removes one rule and returns the rest. */
  readonly remove: (rule: Rule) => Effect.Effect<readonly Rule[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchApprovals") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    // ponytail: one lock for every project's read-modify-write; per-project locks if saves ever contend.
    const lock = Semaphore.makeUnsafe(1)
    const cache = new Map<string, readonly Rule[]>()
    const key = (projectID: string) => ["workbench", "approvals", projectID]

    const load = Effect.fnUntraced(function* (projectID: string) {
      const cached = cache.get(projectID)
      if (cached) return cached
      const stored = yield* storage.read<unknown>(key(projectID)).pipe(Effect.orElseSucceed(() => []))
      // Only well-formed allow rules come back from disk; anything else is dropped.
      const rules = (Array.isArray(stored) ? stored : []).flatMap((item) => {
        const rule = decode(item)
        return rule._tag === "Some" ? [{ permission: rule.value.permission, pattern: rule.value.pattern }] : []
      })
      cache.set(projectID, rules)
      return rules
    })
    const write = Effect.fnUntraced(function* (projectID: string, rules: readonly Rule[]) {
      yield* storage.write(key(projectID), rules).pipe(Effect.orDie)
      cache.set(projectID, rules)
      return rules
    })
    const project = InstanceState.context.pipe(Effect.map((ctx) => ctx.project.id))
    const same = (a: Rule) => (b: Rule) => a.permission === b.permission && a.pattern === b.pattern

    return Service.of({
      list: () => project.pipe(Effect.flatMap(load)),
      save: (rules) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const projectID = yield* project
            const current = yield* load(projectID)
            const added = rules.filter(
              (rule, index) => !current.some(same(rule)) && rules.findIndex(same(rule)) === index,
            )
            return added.length ? yield* write(projectID, [...current, ...added]) : current
          }),
        ),
      remove: (rule) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const projectID = yield* project
            const current = yield* load(projectID)
            const rest = current.filter((item) => !same(rule)(item))
            return rest.length === current.length ? current : yield* write(projectID, rest)
          }),
        ),
    })
  }),
)

/** The saved rules as allow rules, for Permission.ask. */
export function allows(rules: readonly Rule[]): PermissionV1.Rule[] {
  return rules.map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: "allow" }))
}

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node] })

export * as WorkbenchApprovals from "./approvals"
