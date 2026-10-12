import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// spicy: REG-08. A real LSP client (the fake server pushes an error for the opened file, an error for
// other.repro and a warning for third.repro) feeds the real tools; metadata must not carry the whole map.

const ctx = {
  sessionID: SessionID.make("ses_test-diagnostics-metadata"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const config = {
  config: {
    lsp: {
      fake: {
        command: [process.execPath, path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")],
        extensions: [".repro"],
        env: { FAKE_LSP_PUBLISH_ON_OPEN: "1" },
      },
    },
  },
}

const counts = { error: 2, warning: 1, info: 0, hint: 0 }

describe("tool diagnostics metadata (REG-08)", () => {
  it.instance(
    "write keeps the written file and the other files it reports",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "main.repro")
        const tool = yield* (yield* WriteTool).init()
        const result = yield* tool.execute({ filePath: file, content: "x\n" }, ctx)
        expect(Object.keys(result.metadata.diagnostics).sort()).toEqual([file, path.join(dir, "other.repro")])
        expect(result.metadata.diagnostics[file]?.[0]?.message).toBe("opened file error")
        expect(result.metadata.diagnosticCounts).toEqual(counts)
        expect(result.output).toContain("ERROR [1:1] fake: opened file error")
      }),
    config,
  )

  it.instance(
    "edit keeps only the edited file",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "main.repro")
        yield* Effect.promise(() => Bun.write(file, "old\n"))
        const tool = yield* (yield* EditTool).init()
        const result = yield* tool.execute({ filePath: file, oldString: "old", newString: "new" }, ctx)
        expect(Object.keys(result.metadata.diagnostics)).toEqual([file])
        expect(result.metadata.diagnosticCounts).toEqual(counts)
      }),
    config,
  )

  it.instance(
    "apply_patch keeps only the patched files",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const tool = yield* (yield* ApplyPatchTool).init()
        const result = yield* tool.execute(
          { patchText: "*** Begin Patch\n*** Add File: main.repro\n+created\n*** End Patch" },
          ctx,
        )
        expect(Object.keys(result.metadata.diagnostics)).toEqual([path.join(dir, "main.repro")])
        expect(result.metadata.diagnosticCounts).toEqual(counts)
      }),
    config,
  )
})
