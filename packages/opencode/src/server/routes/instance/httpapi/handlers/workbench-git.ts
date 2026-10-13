// spicy: git panel route handlers (src/workbench/git/panel.ts does the work).
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GitPanel } from "@/workbench/git/panel"
import { InstanceHttpApi } from "../api"
import { ConflictError, InvalidRequestError, notFound } from "../errors"

function toApi(error: GitPanel.GitPanelError) {
  if (error.kind === "not_found") return notFound(error.message)
  if (error.kind === "conflict") return new ConflictError({ message: error.message, resource: "git" })
  return new InvalidRequestError({ message: error.message, kind: "invalid_git" })
}

export const workbenchGitHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-git", (handlers) =>
  Effect.gen(function* () {
    const panel = yield* GitPanel.Service
    return handlers
      .handle("status", () => panel.status().pipe(Effect.mapError(toApi)))
      .handle("stage", (ctx) => panel.stage(ctx.payload.paths).pipe(Effect.mapError(toApi)))
      .handle("unstage", (ctx) => panel.unstage(ctx.payload.paths).pipe(Effect.mapError(toApi)))
      .handle("commit", (ctx) => panel.commit(ctx.payload.message).pipe(Effect.mapError(toApi)))
      .handle("push", (ctx) => panel.push(ctx.payload).pipe(Effect.mapError(toApi)))
      .handle("branches", () => panel.branches().pipe(Effect.mapError(toApi)))
      .handle("createBranch", (ctx) => panel.create(ctx.payload).pipe(Effect.mapError(toApi)))
      .handle("switch", (ctx) => panel.switch(ctx.payload.name).pipe(Effect.mapError(toApi)))
      .handle("pullRequest", (ctx) => panel.pullRequest(ctx.payload).pipe(Effect.mapError(toApi)))
      .handle("message", () => panel.message().pipe(Effect.mapError(toApi)))
  }),
)
