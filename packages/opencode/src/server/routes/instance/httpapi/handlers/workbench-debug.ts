// spicy: Workbench debug route handlers. Requests here come from the user, so they act as "human" — except
// `agent`, which runs the agent's debug tool for an agent outside opencode, with its permission asks.
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { DebugError } from "@/workbench/dap/client"
import { WorkbenchDebug } from "@/workbench/dap/service"
import type { DebugSession } from "@/workbench/dap/session"
import { WorkbenchInvestigation } from "@/workbench/investigation/investigation"
import { DebugTool } from "@/workbench/tool/debug"
import { InstanceHttpApi } from "../api"
import type { AgentPayload } from "../groups/workbench-debug"
import { WorkbenchAgent } from "./workbench-agent"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  notFound,
  ServiceUnavailableError,
  TimeoutError,
  UpstreamError,
} from "../errors"

const human = { by: "human" as const }

function toApi(error: DebugError) {
  if (error.kind === "not_found") return notFound(error.message)
  if (error.kind === "not_owner" || error.kind === "limit")
    return new ConflictError({ message: error.message, resource: "debug-session" })
  if (error.kind === "unavailable")
    return new ServiceUnavailableError({ message: error.message, service: "debug-adapter" })
  if (error.kind === "adapter") return new UpstreamError({ message: error.message, service: "debug-adapter" })
  if (error.kind === "timeout") return new TimeoutError({ message: error.message, operation: "debug" })
  return new InvalidRequestError({ message: error.message, kind: error.kind })
}

export const workbenchDebugHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-debug", (handlers) =>
  Effect.gen(function* () {
    const debug = yield* WorkbenchDebug.Service
    const investigations = yield* WorkbenchInvestigation.Service
    const asAgent = yield* WorkbenchAgent.runner
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    const tool = yield* Tool.init(yield* DebugTool)
    const session = (id: string) => debug.get(id)

    // CON-07: lldb-dap runs anything after the ` escape as an LLDB command (platform shell, script). Agents are
    // refused outright (DebugConsole.evaluate); the human is asked debug.lldbCommand through the permission
    // service under the default agent's rules. The ask has a session of its own per debug session, so answering it
    // never touches an agent's pending asks; the console finds it by metadata.debugSessionID.
    const lldbCommand = (item: DebugSession.Session, expression: string) => {
      const command = expression.trimStart()
      // Only when it can run: otherwise evaluate fails as usual and nothing is asked.
      if (item.adapter !== "lldb-dap" || !command.startsWith("`") || item.info().state !== "stopped") return Effect.void
      return agents.defaultInfo().pipe(
        Effect.flatMap((info) =>
          permission.ask({
            sessionID: SessionID.make(`ses_${item.id}`),
            permission: "debug.lldbCommand",
            patterns: [command.slice(1).trim() || "*"],
            always: ["*"],
            metadata: { command: command.slice(1).trim(), debugSessionID: item.id },
            ruleset: info.permission,
          }),
        ),
        Effect.mapError(
          (error) => new ForbiddenError({ message: `debug.lldbCommand was not allowed: ${error.message}` }),
        ),
      )
    }

    // Exactly the in-process tool, acting as the agent of `sessionID`; a cancelled request ends the agent's debug
    // sessions, like aborting the in-process tool.
    const agent = Effect.fn("WorkbenchDebugHttpApi.agent")(function* (ctx: { payload: typeof AgentPayload.Type }) {
      const { sessionID, ...args } = ctx.payload
      const result = yield* asAgent(sessionID, (context) => tool.execute(args, context)).pipe(
        Effect.catchDefect((cause) =>
          WorkbenchAgent.defect(cause, (item) => (item instanceof DebugError ? toApi(item) : undefined)),
        ),
      )
      return { title: result.title, output: result.output, metadata: result.metadata }
    })

    return handlers
      .handle("list", () => debug.list())
      .handle("start", (ctx) =>
        debug.prepare(ctx.payload).pipe(
          Effect.flatMap((spec) => debug.start(spec, human)),
          Effect.map((started) => started.result.info),
          Effect.mapError(toApi),
        ),
      )
      .handle("control", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.control(ctx.payload.action, human, false)),
          Effect.map((result) => result.info),
          Effect.mapError(toApi),
        ),
      )
      .handle("breakpoints", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.breakpoints(ctx.payload, human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("variables", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.variables(ctx.query.ref, human, ctx.query.start ?? 0)),
          Effect.mapError(toApi),
        ),
      )
      .handle("scopes", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.scopes(ctx.query.frameID, human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("evaluate", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.mapError(toApi),
          Effect.tap((item) => lldbCommand(item, ctx.payload.expression)),
          Effect.flatMap((item) => item.evaluate(ctx.payload, human).pipe(Effect.mapError(toApi))),
        ),
      )
      .handle("completions", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) =>
            item.completions(
              {
                text: ctx.query.text,
                ...(ctx.query.column !== undefined ? { column: ctx.query.column } : {}),
                ...(ctx.query.frameID !== undefined ? { frameID: ctx.query.frameID } : {}),
              },
              human,
            ),
          ),
          Effect.mapError(toApi),
        ),
      )
      .handle("output", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.map((item) => item.output(ctx.query.after ?? 0)),
          Effect.mapError(toApi),
        ),
      )
      .handle("owner", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.setOwner(ctx.payload.owner, human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("stop", (ctx) =>
        session(ctx.params.debugSessionID).pipe(
          Effect.flatMap((item) => item.stop(human)),
          Effect.mapError(toApi),
        ),
      )
      .handle("agent", agent)
      .handle("investigations", () => investigations.list())
      .handle("investigation", (ctx) => investigations.full(ctx.params.investigationID).pipe(Effect.mapError(toApi)))
      .handle("resume", (ctx) =>
        investigations
          .resume(ctx.params.investigationID, human)
          .pipe(Effect.map(WorkbenchInvestigation.summary), Effect.mapError(toApi)),
      )
      .handle("cancel", (ctx) =>
        investigations
          .cancel(ctx.params.investigationID, "cancelled by the user")
          .pipe(Effect.map(WorkbenchInvestigation.summary), Effect.mapError(toApi)),
      )
  }),
)
