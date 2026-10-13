// spicy: tool_create, the built-in tool agents draft tools with. It only writes a draft (asking like an edit) and
// returns; the user approves it in the IDE before anything in it runs.
import path from "path"
import { createTwoFilesPatch } from "diff"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "@/tool/tool"
import DESCRIPTION from "./create.txt"
import { WorkbenchTools } from "./tools"

export const ToolCreateTool = Tool.define(
  "tool_create",
  Effect.gen(function* () {
    const tools = yield* WorkbenchTools.Service
    return {
      description: DESCRIPTION,
      parameters: Workbench.CustomToolDraft,
      execute: (args: Workbench.CustomToolDraft, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = path.join(WorkbenchTools.folder(instance.directory), "tool-drafts", `${args.name}.ts`)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, file)],
            always: ["*"],
            metadata: { filepath: file, diff: createTwoFilesPatch(file, file, "", args.source) },
          })
          const tool = yield* tools.draft(args, { by: "agent", sessionID: ctx.sessionID, agent: ctx.agent })
          return {
            title: tool.id,
            output:
              tool.status === "invalid"
                ? `Draft saved, but it cannot be approved: ${tool.reason}. Fix it and call tool_create again with the same name.`
                : `Draft created, waiting for the human's approval in the IDE. Once approved it is available as ${tool.id}; nothing in it runs before that.`,
            metadata: { tool },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
