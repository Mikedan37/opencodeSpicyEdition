import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { SessionAutoApprove } from "@/workbench/auto-approve"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Headless } from "@/workbench/headless"
import { disposeAllInstances } from "../fixture/fixture"
import { cliIt } from "../lib/cli-process"
import { testEffect } from "../lib/effect"

// Nobody can answer a permission ask in a headless run: the ask is rejected and one line says what needed approval.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("headless runs", () => {
  cliIt.concurrent(
    "opencode run: a rejected ask says what needs approval and how to give it",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        // The rejected ask ends the turn, so the model is asked once.
        yield* llm.tool("write", { filePath: "a.txt", content: "x" })
        // run takes its directory from PWD, which the harness inherits from the test runner: point it at the tmpdir.
        const result = yield* opencode.run("write a.txt", { env: { PWD: home } })
        expect(result.stderr).toContain("edit needs approval (")
        expect(result.stderr).toContain("a.txt); rerun with --auto or allow it in opencode.json")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "a.txt")).exists())).toBe(false)
        // The way out the line names: with --auto the same write lands (and shows the check above looks in the right place).
        yield* llm.tool("write", { filePath: "a.txt", content: "x" })
        yield* llm.text("done")
        opencode.expectExit(yield* opencode.run("write a.txt", { env: { PWD: home }, extraArgs: ["--auto"] }), 0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "a.txt")).text())).toBe("x")
      }),
    60_000,
  )

  it.instance("github run: every ask is rejected at once and reported, so CI fails fast instead of waiting", () =>
    Effect.gen(function* () {
      const reported: string[] = []
      const permission = yield* Permission.Service
      yield* Headless.rejectAsks(
        yield* EventV2Bridge.Service,
        permission,
        "CI can't answer asks; allow it in opencode.json",
        (message) => reported.push(message),
      )
      const exit = yield* permission
        .ask({
          sessionID: SessionID.make("ses_ci"),
          permission: "bash",
          patterns: ["npm publish"],
          always: [],
          metadata: {},
          ruleset: [],
        })
        .pipe(Effect.timeout("2 seconds"), Effect.exit)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.RejectedError).toBe(true)
      expect(reported).toEqual(["bash needs approval (npm publish); CI can't answer asks; allow it in opencode.json"])
      expect(yield* permission.list()).toEqual([])
    }),
  )
})

const agentIt = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
  ),
)

describe("the GitHub agent's CI session", () => {
  afterEach(() => disposeAllInstances())

  agentIt.instance(
    "edits and shell commands run; .git, MCP tools, subagents and other directories still ask; denies apply",
    () =>
      Effect.gen(function* () {
        const build = (yield* Agent.Service.use((svc) => svc.defaultInfo())).permission
        const ci = Headless.ciPermission()
        const action = (key: string, pattern = "src/app.ts") =>
          Permission.evaluate(
            key,
            pattern,
            SessionAutoApprove.ruleset(build, ci, { permission: key, patterns: [pattern], metadata: {} }),
          ).action
        expect(action("edit")).toBe("allow")
        expect(action("bash", "npm test")).toBe("allow")
        expect(action("edit", ".git/config")).toBe("ask")
        expect(action("github_create_issue")).toBe("ask")
        expect(action("task", "general")).toBe("ask")
        expect(action("external_directory", "/elsewhere/*")).toBe("ask")
        expect(action("question")).toBe("deny")
        expect(action("bash", "rm -rf build")).toBe("deny")
        expect(action("debug.memory")).toBe("deny")
      }),
    { config: { permission: { bash: { "rm *": "deny" } } } },
  )
})
