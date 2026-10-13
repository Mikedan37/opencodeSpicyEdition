import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
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
  it.instance("running project code and touching a debuggee ask, memory access is denied, under '*': 'allow'", () =>
    Effect.gen(function* () {
      const list = yield* Agent.Service.use((svc) => svc.list())
      const agent = yield* agents
      // The default the explicit keys must beat: agents other than the main chat still start from "*": "allow".
      expect(action(agent("plan").permission, "some.future.tool")).toBe("allow")
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

  it.instance("plan and explore keep their rules", () =>
    Effect.gen(function* () {
      const agent = yield* agents
      const plan = agent("plan").permission
      expect(action(plan, "edit", "src/app.ts")).toBe("deny")
      expect(action(plan, "edit", ".opencode/plans/next.md")).toBe("allow")
      expect(action(plan, "bash")).toBe("allow")
      expect(action(plan, MCP_TOOL)).toBe("allow")
      const explore = agent("explore").permission
      expect(action(explore, "edit")).toBe("deny")
      expect(action(explore, "bash")).toBe("allow")
      expect(action(explore, MCP_TOOL)).toBe("deny")
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
