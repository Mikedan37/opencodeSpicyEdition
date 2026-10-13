// Created tools ask on every call by default: the agents' defaults start with "*": "allow", and "custom_*": "ask"
// comes after it, so it wins (the last matching rule decides). The user can still allow one explicitly.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"

const defaults = testEffect(LayerNode.compile(Agent.node, [[Config.node, TestConfig.layer()]]))
const allowed = testEffect(
  LayerNode.compile(Agent.node, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ permission: { custom_hello: "allow" } }) })],
  ]),
)

describe("tool creator permissions", () => {
  defaults.instance('custom_* asks although the defaults allow "*"', () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      for (const agent of [yield* agents.defaultInfo(), (yield* agents.get("general"))!]) {
        const rules = agent.permission
        const everything = rules.findIndex((rule) => rule.permission === "*" && rule.action === "allow")
        expect(everything).toBeGreaterThanOrEqual(0)
        expect(rules.findIndex((rule) => rule.permission === "custom_*")).toBeGreaterThan(everything)
        expect(Permission.evaluate("custom_hello", "*", rules).action).toBe("ask")
        expect(Permission.evaluate("some_plugin_tool", "*", rules).action).toBe("allow")
      }
    }),
  )

  allowed.instance("an explicit rule for one created tool still wins", () =>
    Effect.gen(function* () {
      const rules = (yield* (yield* Agent.Service).defaultInfo()).permission
      expect(Permission.evaluate("custom_hello", "*", rules).action).toBe("allow")
      expect(Permission.evaluate("custom_other", "*", rules).action).toBe("ask")
    }),
  )
})
