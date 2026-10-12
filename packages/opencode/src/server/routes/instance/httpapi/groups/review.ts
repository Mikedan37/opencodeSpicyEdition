import { Review } from "@opencode-ai/schema/review"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, ConflictError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/review/changesets"

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ownerKind: Schema.optional(Review.Owner.fields.kind),
  ownerID: Schema.optional(Schema.String),
  agentID: Schema.optional(Schema.String),
})
export const ActionPayload = Schema.Struct({ action: Review.Action })
export const FilePayload = Schema.Struct({ path: Schema.String, action: Review.Action })
export const UndoPayload = Schema.Struct({ path: Schema.String })

const params = { changesetID: Review.ChangeSetID }
const changeset = described(Review.ChangeSet, "The changeset after the decision")

function doc(identifier: string, summary: string) {
  return OpenApi.annotations({ identifier, summary })
}

export const ReviewApi = HttpApi.make("review").add(
  HttpApiGroup.make("review")
    .add(
      HttpApiEndpoint.get("changesets", root, {
        query: ListQuery,
        success: described(Schema.Array(Review.ChangeSet), "Changesets with pending or decided files, newest first"),
      }).annotateMerge(doc("review.changesets.list", "List review changesets")),
      HttpApiEndpoint.get("changeset", `${root}/:changesetID`, {
        params,
        query: WorkspaceRoutingQuery,
        success: described(Review.ChangeSet, "The changeset"),
        error: [ApiNotFoundError],
      }).annotateMerge(doc("review.changesets.get", "Get a review changeset")),
      HttpApiEndpoint.post("hunk", `${root}/:changesetID/hunks/:hunkID`, {
        params: { ...params, hunkID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: ActionPayload,
        success: changeset,
        error: [ApiNotFoundError, ConflictError],
      }).annotateMerge(doc("review.changesets.hunk", "Accept or reject one hunk")),
      HttpApiEndpoint.post("file", `${root}/:changesetID/files`, {
        params,
        query: WorkspaceRoutingQuery,
        payload: FilePayload,
        success: changeset,
        error: [ApiNotFoundError, ConflictError],
      }).annotateMerge(doc("review.changesets.file", "Accept or reject every pending hunk of a file")),
      HttpApiEndpoint.post("all", `${root}/:changesetID/all`, {
        params,
        query: WorkspaceRoutingQuery,
        payload: ActionPayload,
        success: changeset,
        error: [ApiNotFoundError, ConflictError],
      }).annotateMerge(doc("review.changesets.all", "Accept or reject every pending hunk")),
      HttpApiEndpoint.post("undo", `${root}/:changesetID/undo`, {
        params,
        query: WorkspaceRoutingQuery,
        payload: UndoPayload,
        success: changeset,
        error: [ApiNotFoundError, ConflictError],
      }).annotateMerge(doc("review.changesets.undo", "Undo the last reject of a file")),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "review", description: "Spicy review routes: accept or reject agent edits." }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
