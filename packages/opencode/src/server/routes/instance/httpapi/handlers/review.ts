import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ReviewChanges } from "@/review/changes"
import { InstanceHttpApi } from "../api"
import { ConflictError, notFound } from "../errors"

// Domain errors stay free of HttpApi types; translate them once here.
function http(error: ReviewChanges.NotFoundError | ReviewChanges.ConflictError) {
  if (error._tag === "Review.NotFoundError") return notFound(error.message)
  return new ConflictError({ message: error.message, ...(error.path ? { resource: error.path } : {}) })
}

export const reviewHandlers = HttpApiBuilder.group(InstanceHttpApi, "review", (handlers) =>
  Effect.gen(function* () {
    const review = yield* ReviewChanges.Service

    return handlers
      .handle("changesets", (ctx) =>
        review.list({ ownerKind: ctx.query.ownerKind, ownerID: ctx.query.ownerID, agentID: ctx.query.agentID }),
      )
      .handle("changeset", (ctx) =>
        review.get(ctx.params.changesetID).pipe(Effect.mapError((error) => notFound(error.message))),
      )
      .handle("content", (ctx) =>
        review
          .content(ctx.params.changesetID, ctx.query.path)
          .pipe(Effect.mapError((error) => notFound(error.message))),
      )
      .handle("hunk", (ctx) =>
        review.hunk(ctx.params.changesetID, ctx.params.hunkID, ctx.payload.action).pipe(Effect.mapError(http)),
      )
      .handle("file", (ctx) =>
        review.file(ctx.params.changesetID, ctx.payload.path, ctx.payload.action).pipe(Effect.mapError(http)),
      )
      .handle("all", (ctx) => review.all(ctx.params.changesetID, ctx.payload.action).pipe(Effect.mapError(http)))
      .handle("undo", (ctx) => review.undo(ctx.params.changesetID, ctx.payload.path).pipe(Effect.mapError(http)))
  }),
)
