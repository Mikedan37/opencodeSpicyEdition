export * as WorkbenchGit from "./workbench-git"

// Spicy git panel contract: the routes in packages/opencode/src/server/routes/instance/httpapi/groups/workbench-git.ts
// and the app's commit area (packages/app/src/workbench/git.ts). Paths are relative to the repository root, `/`.

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

export const FileState = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typechange",
  "untracked",
  "conflicted",
])
export type FileState = typeof FileState.Type

export const File = Schema.Struct({
  path: Schema.String,
  state: FileState,
  from: optional(Schema.String), // the old path of a rename or copy
}).annotate({ identifier: "WorkbenchGitFile" })
export interface File extends Schema.Schema.Type<typeof File> {}

export const Status = Schema.Struct({
  branch: optional(Schema.String), // missing on a detached HEAD
  head: optional(Schema.String), // the commit HEAD points at; missing before the first commit
  upstream: optional(Schema.String), // e.g. origin/main
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  remotes: Schema.Array(Schema.String),
  staged: Schema.Array(File),
  unstaged: Schema.Array(File), // tracked changes not staged, and conflicts
  untracked: Schema.Array(File),
  // Commit message generation needs the config's small_model; nothing else is ever picked.
  generate: Schema.Struct({
    available: Schema.Boolean,
    model: optional(Schema.String),
    reason: optional(Schema.String),
  }),
}).annotate({ identifier: "WorkbenchGitStatus" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const Branch = Schema.Struct({
  name: Schema.String,
  upstream: optional(Schema.String),
  current: Schema.Boolean,
}).annotate({ identifier: "WorkbenchGitBranch" })
export interface Branch extends Schema.Schema.Type<typeof Branch> {}

export const Branches = Schema.Struct({
  current: optional(Schema.String),
  branches: Schema.Array(Branch),
}).annotate({ identifier: "WorkbenchGitBranches" })
export interface Branches extends Schema.Schema.Type<typeof Branches> {}

export const Paths = Schema.Struct({ paths: Schema.Array(Schema.String) }).annotate({
  identifier: "WorkbenchGitPaths",
})

export const CommitInput = Schema.Struct({ message: Schema.String }).annotate({ identifier: "WorkbenchGitCommitInput" })
export const Commit = Schema.Struct({ sha: Schema.String, subject: Schema.String }).annotate({
  identifier: "WorkbenchGitCommit",
})
export interface Commit extends Schema.Schema.Type<typeof Commit> {}

// Push never forces. A branch without an upstream is pushed only with setUpstream: true (the user's explicit choice).
export const PushInput = Schema.Struct({
  setUpstream: optional(Schema.Boolean),
  remote: optional(Schema.String), // for setUpstream; default origin, else the only remote
}).annotate({ identifier: "WorkbenchGitPushInput" })
export const Push = Schema.Struct({
  branch: Schema.String,
  upstream: Schema.String,
  output: Schema.String, // what git printed
}).annotate({ identifier: "WorkbenchGitPush" })
export interface Push extends Schema.Schema.Type<typeof Push> {}

export const BranchInput = Schema.Struct({
  name: Schema.String,
  switch: optional(Schema.Boolean), // also switch to it (the working tree stays as it is)
}).annotate({ identifier: "WorkbenchGitBranchInput" })
export const SwitchInput = Schema.Struct({ name: Schema.String }).annotate({ identifier: "WorkbenchGitSwitchInput" })

// `gh pr create --fill` without a title, else with the title and body given.
export const PullRequestInput = Schema.Struct({
  title: optional(Schema.String),
  body: optional(Schema.String),
}).annotate({ identifier: "WorkbenchGitPullRequestInput" })
export const PullRequest = Schema.Struct({ url: Schema.String, output: Schema.String }).annotate({
  identifier: "WorkbenchGitPullRequest",
})
export interface PullRequest extends Schema.Schema.Type<typeof PullRequest> {}

export const Message = Schema.Struct({ message: Schema.String, model: Schema.String }).annotate({
  identifier: "WorkbenchGitMessage",
})
export interface Message extends Schema.Schema.Type<typeof Message> {}
