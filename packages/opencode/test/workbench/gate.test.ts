import { describe, expect } from "bun:test"
import path from "path"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer, Stream } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchGate } from "@/workbench/verify/gate"
import { WorkbenchParse } from "@/workbench/verify/parse"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { TestInstance } from "../fixture/fixture"
import { write } from "../fixture/workbench/zoo"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// VER-08..11 drive the real prompt loop with the fake model server. The checker is a stand-in that
// reports every *.chk file containing BROKEN in its folder, so results do not depend on installed tools.
const marker: WorkbenchCheckers.Info = {
  id: "marker",
  kind: "typecheck",
  extensions: [".chk"],
  unit: async (file) => path.dirname(file),
  plan: async (unit) => ({
    command: [process.execPath, path.join(__dirname, "../fixture/workbench/marker-check.js"), unit.root],
    cwd: unit.root,
    execClass: "inert",
  }),
  parse: (output) => WorkbenchParse.located(output.stdout, output.cwd),
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
const lsp = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
  diagnosticEvents: () => Stream.empty,
})
const mcp = Layer.mock(MCP.Service, {
  status: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  tools: () => Effect.succeed({}),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
})

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  WorkbenchVerify.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const build = (mode: "off" | "report-only" | "fix") =>
  testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [WorkbenchVerify.node, WorkbenchVerify.nodeFor([marker])],
      [WorkbenchGate.flagsNode, WorkbenchGate.Flags.configLayer({ mode })],
    ]),
  )
const it = build("fix")
const reportOnly = build("report-only")

const providerConfig = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "test/test-model",
})

// Opens a session whose user message asks for work, with every permission allowed.
const start = Effect.fn("GateTest.start")(function* (files: Record<string, string> = {}) {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  yield* Effect.promise(() => write(dir, { ...files, "opencode.json": JSON.stringify(providerConfig(llm.url)) }))
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "gate",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "change the files" }],
  })
  return { dir, llm, prompt, session }
})

const repairs = (messages: SessionV1.WithParts[]) =>
  messages.filter(
    (message) =>
      message.info.role === "user" &&
      message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.verify_gate),
  )

const text = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

describe("workbench turn-end gate", () => {
  it.instance("VER-08 an error in a changed file adds one repair message and the loop continues", () =>
    Effect.gen(function* () {
      const { llm, prompt, session } = yield* start()
      yield* llm.tool("write", { filePath: "a.chk", content: "BROKEN\n" })
      yield* llm.text("done")
      yield* llm.tool("write", { filePath: "a.chk", content: "fixed\n" })
      yield* llm.text("fixed it")

      const result = yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      expect(repairs(messages)).toHaveLength(1)
      expect(text(repairs(messages)[0])).toContain("a.chk:1:1 error [marker] broken marker")
      expect(repairs(messages)[0].parts[0]).toMatchObject({ metadata: { verify_gate: { attempt: 1 } } })
      expect(text(result)).toBe("fixed it")
      expect(yield* llm.pending).toBe(0)

      const verify = yield* WorkbenchVerify.Service
      const reports = yield* verify.reports()
      expect(reports.map((report) => [report.trigger, report.summary.failed, report.summary.passed])).toEqual([
        ["turn-end", 1, 0],
        ["turn-end", 0, 1],
      ])
      expect(reports[0].checks[0].newErrors).toBe(1)
    }),
  )

  it.instance("VER-09 still failing after two repairs: the gate stops and the report says failed", () =>
    Effect.gen(function* () {
      const { llm, prompt, session } = yield* start()
      for (const _ of [1, 2, 3]) {
        yield* llm.tool("write", { filePath: "a.chk", content: "BROKEN again\n" })
        yield* llm.text("done")
      }

      yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      expect(repairs(messages)).toHaveLength(WorkbenchGate.MAX_REPAIRS)
      expect(repairs(messages).map((message) => message.parts[0])).toMatchObject([
        { metadata: { verify_gate: { attempt: 1 } } },
        { metadata: { verify_gate: { attempt: 2 } } },
      ])
      expect(yield* llm.pending).toBe(0)
      const verify = yield* WorkbenchVerify.Service
      const reports = yield* verify.reports()
      expect(reports).toHaveLength(3)
      expect(reports.at(-1)?.summary).toMatchObject({ failed: 1, passed: 0 })
    }),
  )

  it.instance("VER-10 an error only in an unchanged file is reported without a retry", () =>
    Effect.gen(function* () {
      const { llm, prompt, session } = yield* start({ "old.chk": "BROKEN before this turn\n" })
      yield* llm.tool("write", { filePath: "new.chk", content: "fine\n" })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      expect(repairs(messages)).toHaveLength(0)
      const verify = yield* WorkbenchVerify.Service
      const reports = yield* verify.reports()
      expect(reports.map((report) => report.checks.map((check) => [check.newErrors, check.otherErrors]))).toEqual([
        [[0, 1]],
      ])
    }),
  )

  it.instance("VER-11 a turn without file changes does nothing", () =>
    Effect.gen(function* () {
      const { llm, prompt, session } = yield* start({ "old.chk": "BROKEN\n" })
      yield* llm.text("nothing to change")

      yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      expect(repairs(messages)).toHaveLength(0)
      const verify = yield* WorkbenchVerify.Service
      expect(yield* verify.reports()).toEqual([])
    }),
  )

  reportOnly.instance("report-only mode checks and reports but never adds a repair message", () =>
    Effect.gen(function* () {
      const { llm, prompt, session } = yield* start()
      yield* llm.tool("write", { filePath: "a.chk", content: "BROKEN\n" })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      expect(repairs(messages)).toHaveLength(0)
      const verify = yield* WorkbenchVerify.Service
      const reports = yield* verify.reports()
      expect(reports.map((report) => report.summary.failed)).toEqual([1])
    }),
  )
})
