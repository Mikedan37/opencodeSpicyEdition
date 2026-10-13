import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import { SessionAutoApprove } from "@/workbench/auto-approve"
import { WorkbenchApprovals } from "@/workbench/approvals"
import { OpenCodeProvider } from "@/agenthq/providers/opencode"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      RuntimeFlags.node,
      Permission.node,
      WorkbenchApprovals.node,
    ]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const agents = Effect.gen(function* () {
  const list = yield* Agent.Service.use((svc) => svc.list())
  return (name: string) => list.find((agent) => agent.name === name)!
})
const action = (rules: PermissionV1.Ruleset, key: string, pattern = "/repo/src/app.ts") =>
  Permission.evaluate(key, pattern, rules).action
// An MCP tool's permission key is its tool name, e.g. a GitHub server's create_issue.
const MCP_TOOL = "github_create_issue"
const CHANGES = ["edit", "bash", MCP_TOOL, "some.future.tool"]

describe("SEC-01 permission defaults", () => {
  it.instance("running project code and touching a debuggee ask, memory access is denied", () =>
    Effect.gen(function* () {
      const list = yield* Agent.Service.use((svc) => svc.list())
      const agent = yield* agents
      // Plan mode starts from the main chat's ask-first rules too: a tool nobody listed asks.
      expect(action(agent("plan").permission, "some.future.tool")).toBe("ask")
      for (const key of ["verify.exec", "debug.launch", "debug.attach", "debug.evaluate", "debug.lldbCommand"])
        expect([key, action(agent("build").permission, key)]).toEqual([key, "ask"])
      expect(action(agent("build").permission, "debug.memory")).toBe("deny")
      // No built-in agent may run project code or touch a debuggee without a human.
      for (const item of list) {
        for (const key of ["verify.exec", "debug.launch", "debug.attach", "debug.evaluate", "debug.lldbCommand"])
          expect([item.name, key, action(item.permission, key)]).not.toEqual([item.name, key, "allow"])
        expect([item.name, action(item.permission, "debug.memory")]).toEqual([item.name, "deny"])
      }
    }),
  )
})

describe("the main chat asks before it changes anything", () => {
  it.instance("build and general ask for edits, bash and MCP tools; read-only tools run", () =>
    Effect.gen(function* () {
      const agent = yield* agents
      for (const name of ["build", "general"]) {
        const rules = agent(name).permission
        for (const key of CHANGES) expect([name, key, action(rules, key)]).toEqual([name, key, "ask"])
        for (const key of Agent.READ_ONLY_TOOLS.filter((tool) => !(name === "general" && tool === "todowrite")))
          expect([name, key, action(rules, key)]).toEqual([name, key, "allow"])
        // The rules after the ask-first block keep their precedence.
        expect(action(rules, "read", "/repo/.env")).toBe("ask")
        expect(action(rules, "external_directory", "/elsewhere/a.ts")).toBe("ask")
        expect(action(rules, "verify.exec")).toBe("ask")
        expect(action(rules, "custom_lint")).toBe("ask")
        expect(action(rules, "debug.memory")).toBe("deny")
      }
      expect(action(agent("build").permission, "question")).toBe("allow")
      // Starting a subagent asks too: explore runs bash, and a user's own agents may allow everything.
      expect(action(agent("build").permission, "task", "explore")).toBe("ask")
      expect(action(agent("build").permission, "task", "general")).toBe("ask")
      expect(action(agent("general").permission, "todowrite")).toBe("deny")
    }),
  )

  it.instance("plan mode and explore ask before shell commands; reads and their denies are unchanged", () =>
    Effect.gen(function* () {
      const agent = yield* agents
      const plan = agent("plan").permission
      expect(action(plan, "bash", "rm -rf build")).toBe("ask")
      expect(action(plan, "edit", "src/app.ts")).toBe("deny")
      expect(action(plan, "edit", ".opencode/plans/next.md")).toBe("allow")
      expect(action(plan, "task", "general")).toBe("deny")
      // MCP tools and the user's own subagents ask, as in the main chat.
      expect(action(plan, MCP_TOOL)).toBe("ask")
      expect(action(plan, "task", "custom")).toBe("ask")
      // Plan mode starts explore without asking, so explore's commands ask too.
      expect(action(plan, "task", "explore")).toBe("allow")
      const explore = agent("explore").permission
      expect(action(explore, "bash", "git log")).toBe("ask")
      expect(action(explore, "edit")).toBe("deny")
      expect(action(explore, MCP_TOOL)).toBe("deny")
      // Read-only investigation runs without asking.
      for (const rules of [plan, explore])
        for (const key of ["read", "glob", "grep", "list"]) expect([key, action(rules, key)]).toEqual([key, "allow"])
    }),
  )

  it.instance(
    "a user's explicit allow in the config still wins",
    () =>
      Effect.gen(function* () {
        const rules = (yield* agents)("build").permission
        expect(action(rules, "edit")).toBe("allow")
        expect(action(rules, "bash")).toBe("allow")
        expect(action(rules, MCP_TOOL)).toBe("ask")
      }),
    { config: { permission: { edit: "allow", bash: "allow" } } },
  )
})

describe("per-session auto-approve", () => {
  const BOTH = { edits: true, commands: true }
  const edit = (file: string) => ({ permission: "edit", patterns: [file], metadata: {} })

  it.instance("turns asks for edit and bash into allows in that session only, and never lifts a deny", () =>
    Effect.gen(function* () {
      const agent = yield* agents
      const on = SessionAutoApprove.apply([], BOTH)
      const build = SessionAutoApprove.ruleset(agent("build").permission, on)
      expect(action(build, "edit")).toBe("allow")
      expect(action(build, "bash", "rm -rf build")).toBe("allow")
      for (const key of [MCP_TOOL, "task", "doom_loop", "verify.exec", "custom_lint", "some.future.tool"])
        expect([key, action(build, key)]).toEqual([key, "ask"])
      expect(action(build, "external_directory", "/elsewhere/a.ts")).toBe("ask")
      expect(action(build, "read", "/repo/.env")).toBe("ask")
      expect(action(build, "debug.memory")).toBe("deny")
      // Another session (no switch) still asks; the switch alone changes nothing for a session without it.
      expect(action(SessionAutoApprove.ruleset(agent("build").permission, []), "edit")).toBe("ask")
      // Plan mode in the same session stays read-only outside its plan files and sees the same tools.
      const plan = SessionAutoApprove.ruleset(agent("plan").permission, on)
      expect(action(plan, "edit", "src/app.ts")).toBe("deny")
      expect(action(plan, "edit", ".opencode/plans/next.md")).toBe("allow")
      const tools = ["edit", "write", "apply_patch", "bash", "read"]
      expect(Permission.disabled(tools, plan)).toEqual(Permission.disabled(tools, agent("plan").permission))
      // A session's own deny wins over its switch.
      const denied = SessionAutoApprove.apply([{ permission: "bash", pattern: "*", action: "deny" }], BOTH)
      expect(action(SessionAutoApprove.ruleset(agent("build").permission, denied), "bash")).toBe("deny")
    }),
  )

  it.instance("each switch lifts its own asks", () =>
    Effect.gen(function* () {
      const build = (yield* agents)("build").permission
      const edits = SessionAutoApprove.ruleset(build, SessionAutoApprove.apply([], { edits: true, commands: false }))
      expect([action(edits, "edit"), action(edits, "bash", "ls")]).toEqual(["allow", "ask"])
      const commands = SessionAutoApprove.ruleset(build, SessionAutoApprove.apply([], { edits: false, commands: true }))
      expect([action(commands, "edit"), action(commands, "bash", "ls")]).toEqual(["ask", "allow"])
    }),
  )

  it.instance("edits under .git keep asking with edits on, in any case and at any depth", () =>
    Effect.gen(function* () {
      const build = (yield* agents)("build").permission
      const on = SessionAutoApprove.apply([], BOTH)
      for (const file of [".git/config", ".GIT/hooks/pre-commit", "sub/.git/config", ".git", "vendor/lib/.Git"])
        expect([file, action(SessionAutoApprove.ruleset(build, on, edit(file)), "edit", file)]).toEqual([file, "ask"])
      for (const file of ["src/app.ts", ".github/workflows/ci.yml", ".gitignore", "notes.git/x"])
        expect([file, action(SessionAutoApprove.ruleset(build, on, edit(file)), "edit", file)]).toEqual([file, "allow"])
    }),
  )

  it.instance("an Agent HQ session's guard keeps asking with the switches on", () =>
    Effect.gen(function* () {
      const build = (yield* agents)("build").permission
      const guarded = SessionAutoApprove.apply(OpenCodeProvider.guard(build), BOTH)
      const rules = SessionAutoApprove.ruleset(build, guarded, edit("src/app.ts"))
      expect([action(rules, "edit"), action(rules, "bash", "ls")]).toEqual(["ask", "ask"])
    }),
  )

  it.instance(
    "a user's deny for some files and ask for some commands still apply with the switch on",
    () =>
      Effect.gen(function* () {
        const build = SessionAutoApprove.ruleset(
          (yield* agents)("build").permission,
          SessionAutoApprove.apply([], BOTH),
        )
        expect(action(build, "edit", "bun.lock")).toBe("deny")
        expect(action(build, "edit", "src/app.ts")).toBe("allow")
        expect(action(build, "bash", "git push origin main")).toBe("ask")
        expect(action(build, "bash", "git status")).toBe("allow")
      }),
    { config: { permission: { edit: { "*.lock": "deny" }, bash: { "git push*": "ask" } } } },
  )

  it.instance("switching removes only the switches, and the old single switch counts as both", () =>
    Effect.gen(function* () {
      const other: PermissionV1.Rule[] = [
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
      ]
      const on = SessionAutoApprove.apply(other, BOTH)
      expect(SessionAutoApprove.state(on)).toEqual(BOTH)
      expect(SessionAutoApprove.state(other)).toEqual({ edits: false, commands: false })
      expect(SessionAutoApprove.apply(on, BOTH)).toEqual(on)
      expect(SessionAutoApprove.apply(on, { edits: false, commands: false })).toEqual(other)
      const old: PermissionV1.Rule = { permission: "session.auto_approve", pattern: "*", action: "allow" }
      expect(SessionAutoApprove.state([old])).toEqual(BOTH)
      // Without a switch the ruleset is exactly upstream's merge, so ordinary session rules keep their meaning.
      expect(SessionAutoApprove.ruleset(other, other)).toEqual(Permission.merge(other, other))
    }),
  )
})

// An edit ask the way the edit tool makes it: "always" covers every file.
const edit = (sessionID: string, file: string, ruleset: PermissionV1.Ruleset) =>
  Permission.Service.use((svc) =>
    svc.ask({
      sessionID: SessionID.make(sessionID),
      permission: "edit",
      patterns: [file],
      always: ["*"],
      metadata: {},
      ruleset,
    }),
  )
const pending = Effect.gen(function* () {
  while (true) {
    const list = yield* Permission.Service.use((svc) => svc.list())
    if (list.length) return list
    yield* Effect.sleep("10 millis")
  }
}).pipe(Effect.timeout("2 seconds"))
const answer = (reply: "always" | "reject") =>
  Effect.gen(function* () {
    const [asked] = yield* pending
    yield* Permission.Service.use((svc) => svc.reply({ requestID: asked.id, reply }))
    return asked
  })
const denied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.DeniedError),
  )
// Asks, and the test answers like a person who says no: the ask's request, for assertions.
const asks = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkScoped)
    const asked = yield* answer("reject")
    yield* Fiber.await(fiber)
    return asked
  })

describe('"Allow always" is remembered for its session and never beats a deny', () => {
  const alwaysForEdits = (sessionID: string, ruleset: PermissionV1.Ruleset) =>
    Effect.gen(function* () {
      const first = yield* edit(sessionID, "src/a.ts", ruleset).pipe(Effect.forkScoped)
      yield* answer("always")
      yield* Fiber.join(first)
    })

  it.instance("an always in one session does not approve the same edit in another", () =>
    Effect.gen(function* () {
      const build = (yield* agents)("build").permission
      yield* alwaysForEdits("ses_a", build)
      // The same session: no ask.
      yield* edit("ses_a", "src/b.ts", build)
      expect(yield* Permission.Service.use((svc) => svc.list())).toEqual([])
      // Another session asks for the same edit.
      const other = yield* edit("ses_b", "src/b.ts", build).pipe(Effect.forkScoped)
      expect((yield* answer("reject")).sessionID).toBe(SessionID.make("ses_b"))
      expect(Exit.isFailure(yield* Fiber.await(other))).toBe(true)
    }),
  )

  it.instance("an always does not lift plan mode's edit deny in the same session", () =>
    Effect.gen(function* () {
      const agent = yield* agents
      yield* alwaysForEdits("ses_a", agent("build").permission)
      // The session switches to plan mode: its deny still applies, its plan files still write.
      const denied = yield* edit("ses_a", "src/app.ts", agent("plan").permission).pipe(Effect.exit)
      expect(Exit.isFailure(denied) && Cause.squash(denied.cause) instanceof PermissionV1.DeniedError).toBe(true)
      yield* edit("ses_a", ".opencode/plans/next.md", agent("plan").permission)
      expect(yield* Permission.Service.use((svc) => svc.list())).toEqual([])
    }),
  )

  it.instance(
    "an always does not lift a user's deny for some files",
    () =>
      Effect.gen(function* () {
        const build = (yield* agents)("build").permission
        yield* alwaysForEdits("ses_a", build)
        const denied = yield* edit("ses_a", "bun.lock", build).pipe(Effect.exit)
        expect(Exit.isFailure(denied) && Cause.squash(denied.cause) instanceof PermissionV1.DeniedError).toBe(true)
        yield* edit("ses_a", "src/b.ts", build)
      }),
    { config: { permission: { edit: { "*.lock": "deny" } } } },
  )
})

describe('"Always allow in this project": saved approvals', () => {
  const saved = (...rules: WorkbenchApprovals.Rule[]) => WorkbenchApprovals.Service.use((svc) => svc.save(rules))
  const unsaved = (rule: WorkbenchApprovals.Rule) => WorkbenchApprovals.Service.use((svc) => svc.remove(rule))

  test("only well-formed rules are kept: both strings non-empty, permission ≤ 200 and pattern ≤ 2000 characters", () => {
    expect(WorkbenchApprovals.valid({ permission: "bash", pattern: "git status *" })).toBe(true)
    expect(WorkbenchApprovals.valid({ permission: "bash", pattern: "x".repeat(2000) })).toBe(true)
    expect(WorkbenchApprovals.valid({ permission: "bash", pattern: "x".repeat(2001) })).toBe(false)
    expect(WorkbenchApprovals.valid({ permission: "b".repeat(201), pattern: "*" })).toBe(false)
    expect(WorkbenchApprovals.valid({ permission: "", pattern: "*" })).toBe(false)
    expect(WorkbenchApprovals.valid({ permission: "bash" })).toBe(false)
  })

  it.instance(
    "a saved rule skips the ask in every session of the project; removing it asks again",
    () =>
      Effect.gen(function* () {
        const build = (yield* agents)("build").permission
        expect(yield* saved({ permission: "edit", pattern: "*" })).toEqual([{ permission: "edit", pattern: "*" }])
        // Saving it again keeps one copy.
        expect(yield* saved({ permission: "edit", pattern: "*" })).toHaveLength(1)
        yield* edit("ses_a", "src/a.ts", build)
        yield* edit("ses_child", "src/b.ts", build)
        expect(yield* Permission.Service.use((svc) => svc.list())).toEqual([])
        expect(yield* unsaved({ permission: "edit", pattern: "*" })).toEqual([])
        expect((yield* asks(edit("ses_a", "src/c.ts", build))).patterns).toEqual(["src/c.ts"])
      }),
    { git: true },
  )

  it.instance(
    "a saved rule never lifts a deny, and never approves an edit under .git",
    () =>
      Effect.gen(function* () {
        const agent = yield* agents
        // A remembered "always" for every file still asks for .git.
        const first = yield* edit("ses_b", "src/a.ts", []).pipe(Effect.forkScoped)
        yield* answer("always")
        yield* Fiber.join(first)
        expect((yield* asks(edit("ses_b", ".git/hooks/pre-commit", []))).patterns).toEqual([".git/hooks/pre-commit"])
        // So does a saved one, and denies hold.
        yield* saved({ permission: "edit", pattern: "*" })
        expect(yield* denied(edit("ses_a", "src/app.ts", agent("plan").permission))).toBe(true)
        expect(yield* denied(edit("ses_a", "bun.lock", agent("build").permission))).toBe(true)
        expect((yield* asks(edit("ses_a", ".git/config", agent("build").permission))).patterns).toEqual([".git/config"])
      }),
    { git: true, config: { permission: { edit: { "*.lock": "deny" } } } },
  )
})
