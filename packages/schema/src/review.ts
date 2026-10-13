export * as Review from "./review"

// Spicy review contract: the changes an agent session made to the working tree, which the human
// accepts or rejects per hunk, per file or all at once. Server: packages/opencode/src/review.
// Paths are relative to the worktree root with "/" separators (like FileDiff.file).

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"

// One changeset per owning session: "chg_" + the owner's session id.
export const ChangeSetID = Schema.String.check(Schema.isPattern(/^chg_[A-Za-z0-9_-]+$/)).pipe(
  Schema.brand("ReviewChangeSetID"),
)
export type ChangeSetID = typeof ChangeSetID.Type

export const Owner = Schema.Struct({
  kind: Schema.Literals(["opencode-session", "agenthq-session"]),
  id: Schema.String, // opencode session id ("ses_…") or Agent HQ session id ("ags_…")
})
export interface Owner extends Schema.Schema.Type<typeof Owner> {}

// Line numbers follow unified diff: 1-based; a side with 0 lines names the line before the change.
export const Hunk = Schema.Struct({
  id: Schema.String, // stable while the change itself is unchanged (hash of path and changed lines)
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  patch: Schema.String, // "@@ -a,b +c,d @@" header plus "-"/"+" lines, no context; "" for binary files
})
export interface Hunk extends Schema.Schema.Type<typeof Hunk> {}

// pending: hunks left, none decided. partial: some hunks decided and some left, or all decided with both outcomes
// (File.accepted kept, File.rejected reverted). accepted / rejected: all decided one way.
export const FileState = Schema.Literals(["pending", "partial", "accepted", "rejected"])
export type FileState = typeof FileState.Type

// A hunk as it was when the human decided it (positions refer to the file at that moment).
export const DecidedHunk = Schema.Struct({
  ...Hunk.fields,
  state: Schema.Literals(["accepted", "rejected"]),
  at: Schema.Finite,
})
export interface DecidedHunk extends Schema.Schema.Type<typeof DecidedHunk> {}

export const File = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted"]),
  // Not line-diffable (binary, not UTF-8, or over 1 MB): one whole-file hunk with an empty patch.
  binary: Schema.Boolean,
  additions: NonNegativeInt, // pending lines
  deletions: NonNegativeInt,
  hunks: Schema.Array(Hunk), // pending hunks only
  state: FileState,
  undoable: Schema.Boolean, // POST .../undo can restore the content before this file's last reject
  accepted: NonNegativeInt, // hunks of this file decided so far
  rejected: NonNegativeInt,
  decided: Schema.Array(DecidedHunk), // the latest decided hunks (at most 50), oldest first; undo drops its rejects
})
export interface File extends Schema.Schema.Type<typeof File> {}

export const Counts = Schema.Struct({
  files: NonNegativeInt, // files with pending hunks
  pending: NonNegativeInt, // hunks
  accepted: NonNegativeInt,
  rejected: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
})
export interface Counts extends Schema.Schema.Type<typeof Counts> {}

export const ChangeSet = Schema.Struct({
  id: ChangeSetID,
  owner: Owner,
  agentID: optional(Schema.String), // Agent HQ identity, for agenthq-session owners
  files: Schema.Array(File),
  counts: Counts,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "ReviewChangeSet" })
export interface ChangeSet extends Schema.Schema.Type<typeof ChangeSet> {}

// GET .../content: both sides of a file with pending hunks, read together with those hunks, byte-exact text (unlike
// the trimmed /file/content). Sides are omitted when the file did not exist (before) or no longer exists (after), and
// for binary files.
export const Content = Schema.Struct({
  path: Schema.String,
  binary: Schema.Boolean,
  before: optional(Schema.String),
  after: optional(Schema.String),
  hunks: Schema.Array(Hunk), // pending hunks, positions relative to before/after
}).annotate({ identifier: "ReviewContent" })
export interface Content extends Schema.Schema.Type<typeof Content> {}

export const Action = Schema.Literals(["accept", "reject"])
export type Action = typeof Action.Type

// ---------------------------------------------------------------- events

const ChangeSetUpdated = define({ type: "review.changeset.updated", schema: { changeset: ChangeSet } })
const ChangeSetRemoved = define({ type: "review.changeset.removed", schema: { id: ChangeSetID } })

export const Event = {
  ChangeSetUpdated,
  ChangeSetRemoved,
  Definitions: inventory(ChangeSetUpdated, ChangeSetRemoved),
}
