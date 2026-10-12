// Verification runs feed investigations: the real prompt loop with the fake model server, the turn-end gate and
// the check tool. Repeated identical errors block the investigation (supervisor S2) and stop the gate; a passing
// re-run after a patch is verified evidence, and a passing test run then resolves it.
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
import { which } from "@opencode-ai/core/util/which"
import { Workbench } from "@opencode-ai/schema/workbench"
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
import { WorkbenchInvestigation } from "@/workbench/investigation/investigation"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchGate } from "@/workbench/verify/gate"
import { WorkbenchParse } from "@/workbench/verify/parse"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { TestInstance } from "../../fixture/fixture"
import { write } from "../../fixture/workbench/zoo"
import { testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"

// Stand-in checker and test runner: every *.chk file containing BROKEN in the folder is an error.
const markerRun = (unit: WorkbenchCheckers.Unit) => ({
  command: [process.execPath, path.join(__dirname, "../../fixture/workbench/marker-check.js"), unit.root],
  cwd: unit.root,
})
const marker: WorkbenchCheckers.Info = {
  id: "marker",
  kind: "typecheck",
  extensions: [".chk"],
  unit: async (file) => path.dirname(file),
  plan: async (unit) => ({ ...markerRun(unit), execClass: "inert" }),
  parse: (output) => WorkbenchParse.located(output.stdout, output.cwd),
}
const markerTest: WorkbenchCheckers.Info = {
  ...marker,
  id: "marker-test",
  kind: "test",
  test: true,
  plan: async (unit) => ({ ...markerRun(unit), execClass: "exec" }),
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
  WorkbenchInvestigation.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const build = (checkers?: WorkbenchCheckers.Info[]) =>
  testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [WorkbenchVerify.node, checkers ? WorkbenchVerify.nodeFor(checkers) : WorkbenchVerify.node],
      [WorkbenchGate.flagsNode, WorkbenchGate.Flags.configLayer({ mode: "fix" })],
    ]),
  )
const it = build([marker, markerTest])
const real = build()
const goReal = which("go") ? real.instance : real.instance.skip

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

// A session with every permission allowed, whose investigation already saw the failure under the debugger.
const start = Effect.fn("VerificationTest.start")(function* (files: Record<string, string> = {}) {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  yield* Effect.promise(() => write(dir, { ...files, "opencode.json": JSON.stringify(providerConfig(llm.url)) }))
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "investigation",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "fix it" }],
  })
  const investigations = yield* WorkbenchInvestigation.Service
  const investigation = yield* investigations.open({ sessionID: session.id, title: "the check fails" })
  const debugSessionID = Workbench.DebugSessionID.make("dbg_verification")
  yield* investigations.record(investigation.id, { type: "debug.started", debugSessionID })
  yield* investigations.record(investigation.id, {
    type: "debug.stopped",
    debugSessionID,
    snapshot: {
      reason: "exception",
      threadID: 1,
      frames: [],
      locals: [],
      exception: { id: "Error", description: "broken" },
      at: 1,
    },
  })
  return { dir, llm, prompt, session, investigations, investigation }
})

const repairs = (messages: SessionV1.WithParts[]) =>
  messages.filter(
    (message) =>
      message.info.role === "user" &&
      message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.verify_gate),
  )

describe("verification feeds investigations", () => {
  it.instance("the same error after two patches blocks the investigation (S2) and the gate stops repairing", () =>
    Effect.gen(function* () {
      const { llm, prompt, session, investigations, investigation } = yield* start()
      for (const version of [1, 2, 3]) {
        yield* llm.tool("write", { filePath: "a.chk", content: `BROKEN v${version}\n` })
        yield* llm.text("done")
      }

      yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      // Without the investigation the gate would have asked for a second repair.
      expect(repairs(messages)).toHaveLength(1)
      expect(yield* llm.pending).toBe(2)
      const full = yield* investigations.full(investigation.id)
      expect(full.investigation.status).toBe("blocked")
      const verify = yield* WorkbenchVerify.Service
      const runs = (yield* verify.reports()).flatMap((report) => report.checks.map((check) => check.run.id))
      expect(full.investigation.checkpoints.at(-1)?.reason).toBe(
        `S2: no progress: same error after 2 patches (checks ${runs.join(", ")})`,
      )
      expect(full.investigation.attempts.map((attempt) => [attempt.n, attempt.passed])).toEqual([
        [1, false],
        [2, false],
      ])
      expect(full.evidence.filter((item) => item.kind === "check-run").map((item) => item.class)).toEqual([
        "observed",
        "observed",
      ])
      expect(yield* investigations.halted(session.id)).toContain("blocked")
    }),
  )

  it.instance("a passing re-run after a patch is verified evidence; a passing test run then resolves it", () =>
    Effect.gen(function* () {
      const { llm, prompt, session, investigations, investigation } = yield* start()
      yield* llm.tool("write", { filePath: "a.chk", content: "BROKEN\n" })
      yield* llm.text("done")
      yield* llm.tool("write", { filePath: "a.chk", content: "fixed\n" })
      yield* llm.tool("check", { files: ["a.chk"], tests: true })
      yield* llm.text("fixed it")

      yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)

      expect(repairs(messages)).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
      const full = yield* investigations.full(investigation.id)
      expect(full.investigation.status).toBe("resolved")
      expect(full.investigation.checkpoints.at(-1)?.reason).toBe(
        "the reproduction and the checks passed after the last patch",
      )
      expect(full.evidence.map((item) => [item.kind, item.class])).toEqual([
        ["exception", "observed"],
        ["patch", "observed"],
        ["check-run", "observed"],
        ["patch", "observed"],
        ["check-run", "verified"],
        ["repro-run", "verified"],
      ])
      expect(full.report).toContain("Verified")
    }),
  )

  goReal(
    `[go] the same go build error after two patches blocks the investigation and the gate stops${
      which("go") ? "" : " [skipped: go not found]"
    }`,
    () =>
      Effect.gen(function* () {
        const { llm, prompt, session, investigations, investigation } = yield* start({
          "go.mod": "module example.com/avg\n\ngo 1.22\n",
        })
        const broken = (comment: string) =>
          `package main\n\n// ${comment}\nfunc main() {\n\tvar n int = "zero"\n\t_ = n\n}\n`
        for (const comment of ["first try", "second try", "third try"]) {
          yield* llm.tool("write", { filePath: "main.go", content: broken(comment) })
          yield* llm.text("done")
        }

        yield* prompt.loop({ sessionID: session.id })
        const messages = yield* MessageV2.filterCompactedEffect(session.id)

        expect(repairs(messages)).toHaveLength(1)
        const record = yield* investigations.get(investigation.id)
        expect(record.status).toBe("blocked")
        expect(record.checkpoints.at(-1)?.reason).toStartWith("S2: no progress: same error after 2 patches")
        expect(record.attempts.map((attempt) => attempt.errorFingerprints)).toEqual([
          record.attempts[0].errorFingerprints,
          record.attempts[0].errorFingerprints,
        ])
        expect(record.attempts[0].errorFingerprints[0]).toContain("main.go")
      }),
    60_000,
  )
})
