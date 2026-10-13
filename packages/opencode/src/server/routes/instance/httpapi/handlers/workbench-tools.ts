// spicy: tool creator route handlers. Every change to a created tool refreshes this instance's tool registry, so it
// is live (or gone) without a restart.
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { errorMessage } from "@/util/error"
import { WorkbenchTools } from "@/workbench/tools/tools"
import { InstanceHttpApi } from "../api"
import { ConflictError, InvalidRequestError, notFound } from "../errors"
import { WorkbenchAgent } from "./workbench-agent"

function toApi(error: WorkbenchTools.ToolError) {
  if (error.kind === "not_found") return notFound(error.message)
  if (error.kind === "conflict") return new ConflictError({ message: error.message, resource: "tool" })
  return new InvalidRequestError({ message: error.message, kind: "invalid_tool" })
}

export const workbenchToolsHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-tools", (handlers) =>
  Effect.gen(function* () {
    const tools = yield* WorkbenchTools.Service
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const asAgent = yield* WorkbenchAgent.runner

    // An enabled tool as the registry loaded it: its description and input schema come from the code.
    const loaded = Effect.fnUntraced(function* (list: readonly Workbench.CustomTool[]) {
      const defs = new Map((yield* registry.all()).map((def) => [def.id, def]))
      return list.map((tool): Workbench.CustomTool => {
        if (tool.status !== "enabled") return tool
        const def = defs.get(tool.id)
        if (!def) return { ...tool, status: "invalid", reason: "it did not load; see the opencode log" }
        const schema = ToolJsonSchema.fromTool(def)
        return { ...tool, description: def.description, args: summary(schema), inputSchema: { ...schema } }
      })
    })
    const one = (tool: Workbench.CustomTool) => loaded([tool]).pipe(Effect.map((list) => list[0]))
    const live = Effect.fnUntraced(function* (id: string) {
      const def = (yield* registry.all()).find((item) => item.id === id)
      if (!def || !id.startsWith("custom_")) return yield* Effect.fail(notFound(`no enabled tool ${id}`))
      return def
    })
    // Created tools get the arguments their schema accepts, like the model's calls.
    const call = (def: Tool.Def, args: unknown, ctx: Tool.Context) =>
      Schema.decodeUnknownEffect(def.parameters)(args).pipe(
        Effect.mapError((error) => new InvalidRequestError({ message: `invalid arguments: ${errorMessage(error)}` })),
        Effect.flatMap((decoded) => def.execute(decoded, ctx)),
        Effect.map((result) => ({ title: result.title, output: result.output, metadata: result.metadata })),
      )
    const changed = <A>(effect: Effect.Effect<A, WorkbenchTools.ToolError>) =>
      effect.pipe(
        Effect.mapError(toApi),
        Effect.tap(() => registry.refresh()),
      )

    return handlers
      .handle("list", () => tools.list().pipe(Effect.flatMap(loaded)))
      .handle("draft", (ctx) => tools.draft(ctx.payload, { by: "user" }).pipe(Effect.mapError(toApi)))
      .handle("approve", (ctx) =>
        Effect.gen(function* () {
          // Another config folder or a plugin may already provide the name.
          if ((yield* registry.ids()).includes(`custom_${ctx.params.name}`))
            return yield* new ConflictError({ message: `custom_${ctx.params.name} already exists`, resource: "tool" })
          return yield* one(yield* changed(tools.approve(ctx.params.name, ctx.payload.hash)))
        }),
      )
      .handle("reject", (ctx) => tools.reject(ctx.params.name).pipe(Effect.mapError(toApi), Effect.as(true)))
      .handle("disable", (ctx) => changed(tools.disable(ctx.params.name)))
      .handle("enable", (ctx) => changed(tools.enable(ctx.params.name, ctx.payload.hash)).pipe(Effect.flatMap(one)))
      .handle("remove", (ctx) => changed(tools.remove(ctx.params.name)).pipe(Effect.as(true)))
      .handle("run", (ctx) =>
        // The user's test run: they started it, so nothing is asked.
        Effect.gen(function* () {
          const def = yield* live(`custom_${ctx.params.name}`)
          const agent = yield* agents.defaultInfo()
          return yield* call(def, ctx.payload.args, {
            sessionID: SessionID.descending(),
            messageID: MessageID.ascending(),
            agent: agent.name,
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }).pipe(
            Effect.catchDefect((cause) =>
              Effect.fail(
                new InvalidRequestError({ message: `the tool failed: ${errorMessage(cause)}`, kind: "tool_failed" }),
              ),
            ),
          )
        }),
      )
      .handle("agent", (ctx) =>
        Effect.gen(function* () {
          const name = ctx.payload.tool
          if (name !== "tool_create" && !name.startsWith("custom_"))
            return yield* new InvalidRequestError({ message: "only tool_create and created tools (custom_*) run here" })
          const def =
            name === "tool_create" ? (yield* registry.all()).find((item) => item.id === name)! : yield* live(name)
          return yield* asAgent(ctx.payload.sessionID, (context) => call(def, ctx.payload.args, context)).pipe(
            Effect.catchDefect((cause) =>
              WorkbenchAgent.defect(cause, (item) =>
                item instanceof WorkbenchTools.ToolError ? toApi(item) : undefined,
              ),
            ),
          )
        }),
      )
  }),
)

function summary(schema: JSONSchema7): Workbench.CustomToolArg[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, value]) => {
    const property = typeof value === "object" ? value : {}
    const type = typeof property.type === "string" ? property.type : property.enum ? "enum" : undefined
    return {
      name,
      ...(type ? { type } : {}),
      ...(property.description ? { description: property.description } : {}),
      required: required.has(name),
    }
  })
}
