import { describe, expect } from "bun:test"
import path from "path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Cause, Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { WorkbenchCheckTool } from "@/workbench/tool/check"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchParse } from "@/workbench/verify/parse"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { TestInstance } from "../fixture/fixture"
import { write } from "../fixture/workbench/zoo"
import { testEffect } from "../lib/effect"

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
// Same checker, but declared as able to run project code.
const scripted: WorkbenchCheckers.Info = {
  ...marker,
  id: "scripted",
  extensions: [".exec"],
  plan: async (unit) => ({ ...(await marker.plan(unit, unit.root)), execClass: "exec" }) as WorkbenchCheckers.Plan,
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Ripgrep.node,
      WorkbenchVerify.node,
      WorkbenchProblems.node,
    ]),
    [[WorkbenchVerify.node, WorkbenchVerify.nodeFor([marker, scripted])]],
  ),
)

const context = (input: { messages?: SessionV1.WithParts[]; asked?: PermissionV1.Request[] } = {}): Tool.Context => ({
  sessionID: SessionID.make("ses_check"),
  messageID: MessageID.make("msg_check"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: input.messages ?? [],
  metadata: () => Effect.void,
  ask: (request) =>
    Effect.sync(() => {
      input.asked?.push(request as PermissionV1.Request)
    }),
})

const call = Effect.fn("CheckToolTest.call")(function* (args: unknown, ctx: Tool.Context = context()) {
  const info = yield* WorkbenchCheckTool.CheckTool
  const tool = yield* info.init()
  return yield* tool.execute(args as Tool.InferParameters<typeof WorkbenchCheckTool.CheckTool>, ctx)
})

describe("check tool", () => {
  it.instance("reports errors with location, code and tool, and carries the report as metadata", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, { "a.chk": "BROKEN\n", "b.chk": "ok\n" }))
      const result = yield* call({ files: ["a.chk"] })

      expect(result.output).toContain("0 passed, 1 failed")
      expect(result.output).toContain("a.chk:1:1 error [marker] broken marker")
      expect(result.output).toContain(`failed  marker  .  exit 1`)
      expect(result.output).toContain("Unverified: a.chk")
      expect(result.title).toBe("1 failed, 0 passed of 1 checks")
      expect(result.metadata.report).toMatchObject({ trigger: "agent", sessionID: "ses_check" })

      const verify = yield* WorkbenchVerify.Service
      expect(yield* verify.reports()).toEqual([result.metadata.report])
    }),
  )

  it.instance("with no arguments it checks the files changed since the user's last message", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, { "turn.chk": "BROKEN\n", "older.chk": "fine\n" }))
      const sessionID = SessionID.make("ses_check")
      const user = MessageID.ascending()
      const assistant = MessageID.ascending()
      const messages = [
        {
          info: {
            id: user,
            sessionID,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "test", modelID: "m" },
          },
          parts: [{ id: PartID.ascending(), sessionID, messageID: user, type: "text", text: "go" }],
        },
        {
          info: { id: assistant, sessionID, role: "assistant", parentID: user },
          parts: [
            {
              id: PartID.ascending(),
              sessionID,
              messageID: assistant,
              type: "patch",
              hash: "h",
              files: [path.join(dir, "turn.chk")],
            },
          ],
        },
      ] as unknown as SessionV1.WithParts[]

      const result = yield* call({}, context({ messages }))
      expect(result.metadata.report.changedFiles).toEqual([path.join(dir, "turn.chk")])
      expect(result.output).toContain("Errors in the checked files (1):")
    }),
  )

  it.instance("unit checks every source file under a folder", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() =>
        write(dir, { "pkg/a.chk": "BROKEN\n", "pkg/sub/b.chk": "ok\n", "pkg/notes.md": "not checked\n" }),
      )
      const result = yield* call({ unit: "pkg" })

      expect(result.metadata.report.changedFiles.toSorted()).toEqual([
        path.join(dir, "pkg/a.chk"),
        path.join(dir, "pkg/sub/b.chk"),
      ])
      expect(
        result.metadata.report.checks.map((check) => [path.relative(dir, check.run.unit), check.run.status]).toSorted(),
      ).toEqual([
        ["pkg", "failed"],
        ["pkg/sub", "passed"],
      ])
    }),
  )

  it.instance("VER-06 exec-class checks ask verify.exec before running", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, { "pkg/x.exec": "ok\n" }))
      const asked: PermissionV1.Request[] = []
      const result = yield* call({ files: ["pkg/x.exec"] }, context({ asked }))

      expect(asked).toMatchObject([{ permission: "verify.exec", patterns: [path.join(dir, "pkg")] }])
      expect(result.metadata.report.checks.map((check) => [check.run.execClass, check.run.status])).toEqual([
        ["exec", "passed"],
      ])
    }),
  )

  it.instance("VER-12 a call cannot create or edit a report", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => write(dir, { "a.chk": "BROKEN\n" }))
      const forged = {
        id: "vr_forged",
        trigger: "agent",
        changedFiles: [],
        checks: [],
        summary: { passed: 1, failed: 0, skipped: 0, unavailable: 0, timedOut: 0 },
        unverifiedFiles: [],
        completedAt: 0,
      }
      for (const args of [
        { files: ["a.chk"], report: forged },
        { files: ["a.chk"], status: "passed" },
      ]) {
        const exit = yield* Effect.exit(call(args))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("invalid arguments")
      }

      const verify = yield* WorkbenchVerify.Service
      expect(yield* verify.reports()).toEqual([])

      // A real run's verdict comes from the checker, whatever the model claims.
      const result = yield* call({ files: ["a.chk"] })
      expect(result.metadata.report.id).not.toBe("vr_forged")
      expect(result.metadata.report.summary.failed).toBe(1)
    }),
  )
})
