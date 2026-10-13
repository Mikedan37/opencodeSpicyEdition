import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
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

// SEC-01: the built-in agents default to "*": "allow", so the Workbench keys need explicit rules that beat it.
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("SEC-01 permission defaults", () => {
  it.instance("running project code and touching a debuggee ask, memory access is denied, under '*': 'allow'", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service.use((svc) => svc.list())
      const action = (agent: Agent.Info, key: string) =>
        Permission.evaluate(key, "/repo/app.py", agent.permission).action
      const build = agents.find((agent) => agent.name === "build")!
      // The default the explicit keys must beat.
      expect(action(build, "some.future.tool")).toBe("allow")
      for (const key of ["verify.exec", "debug.launch", "debug.attach", "debug.evaluate", "debug.lldbCommand"])
        expect([key, action(build, key)]).toEqual([key, "ask"])
      expect(action(build, "debug.memory")).toBe("deny")
      // No built-in agent may run project code or touch a debuggee without a human.
      for (const agent of agents) {
        for (const key of ["verify.exec", "debug.launch", "debug.attach", "debug.evaluate", "debug.lldbCommand"])
          expect([agent.name, key, action(agent, key)]).not.toEqual([agent.name, key, "allow"])
        expect([agent.name, action(agent, "debug.memory")]).toEqual([agent.name, "deny"])
      }
    }),
  )
})
