import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"

// REG-07 (audit, tool/registry.ts): plugin tools can't stream progress. A plugin's `context.metadata(...)` is
// typed `void` but receives the host's Effect-returning `metadata`, so the progress Effect is built and never run.
// Still open: `test.failing` passes while the progress is dropped. When it is fixed this goes red: make it `test`.
const layer = LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
  [
    Config.node,
    TestConfig.layer({
      directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
    }),
  ],
  [RuntimeFlags.node, RuntimeFlags.layer()],
])

afterEach(async () => {
  await disposeAllInstances()
})

describe("plugin tool progress (REG-07)", () => {
  test.failing("a plugin tool's context.metadata reaches the host as progress", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const tools = path.join(dir, ".opencode", "tools")
      const plugin = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "progress.ts"),
          [
            `import { tool } from ${JSON.stringify(plugin)}`,
            "export default tool({",
            "  description: 'reports progress',",
            "  args: {},",
            "  execute: async (_args, context) => {",
            "    context.metadata({ title: 'halfway', metadata: { step: 1 } })",
            "    return 'done'",
            "  },",
            "})",
            "",
          ].join("\n"),
        ),
      )
      const loaded = (yield* (yield* ToolRegistry.Service).all()).find((item) => item.id === "progress")
      const agents = yield* Agent.Service
      const progress: unknown[] = []
      const result = loaded
        ? yield* loaded.execute({}, {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: (yield* agents.defaultInfo()).name,
            abort: new AbortController().signal,
            messages: [],
            metadata: (input) => Effect.sync(() => void progress.push(input)),
            ask: () => Effect.void,
          } satisfies Tool.Context)
        : undefined
      // A broken setup must not count as the expected failure: only the progress assertion may throw.
      if (result?.output !== "done") return
      expect(progress).toEqual([{ title: "halfway", metadata: { step: 1 } }])
    }).pipe(withTmpdirInstance(), Effect.scoped, Effect.provide(layer), Effect.runPromise),
  )
})
