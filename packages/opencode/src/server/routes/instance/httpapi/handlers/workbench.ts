import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { BridgeToken } from "@/server/bridge-token"
import { SessionShare } from "@/share/session"
import { Doctor } from "@/workbench/doctor"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchVerify } from "@/workbench/verify/verify"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { WorkbenchEditorFile } from "@/workbench/editor-file"
import { WorkbenchEditorLsp } from "@/workbench/editor-lsp"
import { SessionID } from "@/session/schema"
import { InstanceHttpApi } from "../api"
import { ConflictError, ForbiddenError, InvalidRequestError, notFound } from "../errors"
import { CheckPayload, FileQuery, FileWritePayload, LspQuery, ProblemsQuery } from "../groups/workbench"

export const workbenchHandlers = HttpApiBuilder.group(
  InstanceHttpApi,
  "workbench",
  (handlers) =>
    Effect.gen(function* () {
      const problems = yield* WorkbenchProblems.Service
      const verify = yield* WorkbenchVerify.Service
      const agents = yield* Agent.Service
      const config = yield* Config.Service
      const flags = yield* RuntimeFlags.Service
      const appProcess = yield* AppProcess.Service
      const lsp = yield* LSP.Service
      const events = yield* EventV2Bridge.Service
      const shares = yield* SessionShare.Service

      const refuse = (failure: WorkbenchEditorFile.Failure) => {
        if (failure.kind === "missing") return notFound(failure.message)
        if (failure.kind === "outside") return new ForbiddenError({ message: failure.message })
        return new InvalidRequestError({ message: failure.message })
      }

      const file = Effect.fn("WorkbenchHttpApi.file")(function* (ctx: { query: typeof FileQuery.Type }) {
        const instance = yield* InstanceState.context
        const result = yield* Effect.promise(() => WorkbenchEditorFile.read(instance, ctx.query.path))
        if (WorkbenchEditorFile.isFailure(result)) return yield* refuse(result)
        return result
      })

      const writeFile = Effect.fn("WorkbenchHttpApi.writeFile")(function* (ctx: {
        payload: typeof FileWritePayload.Type
      }) {
        const instance = yield* InstanceState.context
        const result = yield* Effect.promise(() => WorkbenchEditorFile.write(instance, ctx.payload))
        if (WorkbenchEditorFile.isFailure(result))
          return yield* result.kind === "conflict" ? new ConflictError({ message: result.message }) : refuse(result)
        // Not FileSystem.Event.Edited: that one records the agent's own edits (investigations).
        yield* events.publish(Watcher.Event.Updated, { file: result.file, event: result.created ? "add" : "change" })
        // The language servers re-read the file; their diagnostics reach Problems as usual. Not awaited: a server
        // may still be starting.
        yield* lsp.touchFile(result.file).pipe(Effect.forkDetach)
        return { hash: result.hash }
      })

      // A position in an existing project file, named as its language servers know it.
      const at = Effect.fn("WorkbenchHttpApi.lspAt")(function* (query: typeof LspQuery.Type) {
        const instance = yield* InstanceState.context
        const file = yield* Effect.promise(() => WorkbenchEditorFile.existing(instance, query.path))
        if (WorkbenchEditorFile.isFailure(file)) return yield* refuse(file)
        return { at: { file, line: query.line, character: query.character }, directory: instance.directory }
      })
      const lspHover = Effect.fn("WorkbenchHttpApi.lspHover")(function* (ctx: { query: typeof LspQuery.Type }) {
        return yield* WorkbenchEditorLsp.hover(lsp, (yield* at(ctx.query)).at)
      })
      const lspDefinition = Effect.fn("WorkbenchHttpApi.lspDefinition")(function* (ctx: {
        query: typeof LspQuery.Type
      }) {
        const place = yield* at(ctx.query)
        return yield* WorkbenchEditorLsp.definition(lsp, place.at, place.directory)
      })
      const lspReferences = Effect.fn("WorkbenchHttpApi.lspReferences")(function* (ctx: {
        query: typeof LspQuery.Type
      }) {
        const place = yield* at(ctx.query)
        return yield* WorkbenchEditorLsp.references(lsp, place.at, place.directory)
      })

      const list = Effect.fn("WorkbenchHttpApi.problems")(function* (ctx: { query: typeof ProblemsQuery.Type }) {
        return yield* problems.snapshot({
          severity: ctx.query.severity,
          source: ctx.query.source,
          file: ctx.query.file,
        })
      })

      const check = Effect.fn("WorkbenchHttpApi.check")(function* (ctx: { payload: typeof CheckPayload.Type }) {
        // Only a person (the server password, the IDE) starts checks as "user". A bridge token is an agent whatever
        // the body says.
        const bridge = BridgeToken.of(yield* HttpServerRequest.HttpServerRequest)
        const trigger = bridge ? "agent" : (ctx.payload.trigger ?? "user")
        // A person who starts a check in the IDE has approved it, so checks that run project code run. An agent
        // outside opencode (the MCP bridge) only gets what the permission rules already allow; nobody is asked.
        const rules = trigger === "agent" ? (yield* agents.defaultInfo()).permission : []
        const result = yield* verify.run({
          files: ctx.payload.files,
          unit: ctx.payload.unit,
          tests: ctx.payload.tests,
          trigger,
          budgetMs: ctx.payload.tests ? WorkbenchVerify.TEST_BUDGET_MS : undefined,
          approve: (units) =>
            Effect.succeed(
              trigger === "user"
                ? units
                : units.filter((unit) => Permission.evaluate("verify.exec", unit, rules).action === "allow"),
            ),
          approval: trigger === "agent" ? "needs approval in the IDE" : undefined,
        })
        return result.report
      })

      // The session the bridge's agent tools act in, as POST /session would make it. A bridge token gets one, made on
      // its first call and the only session it can act in (WorkbenchAgent.runner).
      const session = Effect.fn("WorkbenchHttpApi.session")(function* () {
        const grant = BridgeToken.of(yield* HttpServerRequest.HttpServerRequest)
        if (grant?.session) return { id: SessionID.make(grant.session) }
        const info = yield* shares.create({ title: "Workbench MCP" })
        if (grant) grant.session = info.id
        return { id: info.id }
      })

      const runs = Effect.fn("WorkbenchHttpApi.runs")(function* () {
        return yield* verify.runs()
      })

      const run = Effect.fn("WorkbenchHttpApi.run")(function* (ctx: { params: { runID: Workbench.RunID } }) {
        const record = yield* verify.record(ctx.params.runID)
        if (!record) return yield* notFound(`Run not found: ${ctx.params.runID}`)
        return record
      })

      const doctor = Effect.fn("WorkbenchHttpApi.doctor")(function* () {
        const directory = yield* InstanceState.directory
        const cfg = yield* config.get()
        const report = yield* Doctor.report({
          directory,
          lsp: cfg.lsp,
          experimentalLspTy: flags.experimentalLspTy,
        }).pipe(Effect.provideService(AppProcess.Service, appProcess))
        // repository checks are listed (located, never run) next to the built-in tools
        const checks = cfg.workbench?.checks
        if (!checks || !Object.keys(checks).length) return report
        const repo = yield* Effect.promise(() => WorkbenchCheckers.doctor(checks, directory))
        return { languages: [...report.languages, repo] }
      })

      return handlers
        .handle("problems", list)
        .handle("check", check)
        .handle("runs", runs)
        .handle("run", run)
        .handle("doctor", doctor)
        .handle("session", session)
        .handle("lspHover", lspHover)
        .handle("lspDefinition", lspDefinition)
        .handle("lspReferences", lspReferences)
        .handle("file", file)
        .handle("writeFile", writeFile)
    }),
  // The doctor spawns probes through AppProcess, a stateless process runner the app graph does not expose.
).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
