// spicy: git panel routes (commit, push, branches, pull requests) for the IDE's Files Changed panel. They act on the
// instance's repository as the user; push and pull requests reach the network, so the UI confirms each one first.
import { WorkbenchGit } from "@opencode-ai/schema/workbench-git"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, ConflictError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workbench/git"
export const WorkbenchGitPaths = {
  status: `${root}/status`,
  stage: `${root}/stage`,
  unstage: `${root}/unstage`,
  commit: `${root}/commit`,
  push: `${root}/push`,
  branches: `${root}/branches`,
  switch: `${root}/switch`,
  pullRequest: `${root}/pr`,
  message: `${root}/message`,
} as const

const errors = [ApiNotFoundError, InvalidRequestError, ConflictError]
const op = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const WorkbenchGitApi = HttpApi.make("workbench-git")
  .add(
    HttpApiGroup.make("workbench-git")
      .add(
        HttpApiEndpoint.get("status", WorkbenchGitPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(WorkbenchGit.Status, "Branch, upstream and the staged, unstaged and untracked files"),
          error: errors,
        }).annotateMerge(op("workbench.git.status", "Git status", "The repository as the commit area shows it.")),
        HttpApiEndpoint.post("stage", WorkbenchGitPaths.stage, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.Paths,
          success: described(WorkbenchGit.Status, "The status after staging"),
          error: errors,
        }).annotateMerge(op("workbench.git.stage", "Stage files", "git add, for files inside the repository.")),
        HttpApiEndpoint.post("unstage", WorkbenchGitPaths.unstage, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.Paths,
          success: described(WorkbenchGit.Status, "The status after unstaging"),
          error: errors,
        }).annotateMerge(op("workbench.git.unstage", "Unstage files", "Take files out of the index.")),
        HttpApiEndpoint.post("commit", WorkbenchGitPaths.commit, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.CommitInput,
          success: described(WorkbenchGit.Commit, "The new commit"),
          error: errors,
        }).annotateMerge(op("workbench.git.commit", "Commit", "Commit the staged files with the message.")),
        HttpApiEndpoint.post("push", WorkbenchGitPaths.push, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.PushInput,
          success: described(WorkbenchGit.Push, "What was pushed"),
          error: errors,
        }).annotateMerge(
          op(
            "workbench.git.push",
            "Push",
            "Push the current branch to its upstream, never forced; without one, only with setUpstream.",
          ),
        ),
        HttpApiEndpoint.get("branches", WorkbenchGitPaths.branches, {
          query: WorkspaceRoutingQuery,
          success: described(WorkbenchGit.Branches, "Local branches"),
          error: errors,
        }).annotateMerge(op("workbench.git.branches", "Branches", "Local branches and the current one.")),
        HttpApiEndpoint.post("createBranch", WorkbenchGitPaths.branches, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.BranchInput,
          success: described(WorkbenchGit.Branches, "The branches after creating it"),
          error: errors,
        }).annotateMerge(op("workbench.git.branch.create", "Create a branch", "A new branch at HEAD.")),
        HttpApiEndpoint.post("switch", WorkbenchGitPaths.switch, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.SwitchInput,
          success: described(WorkbenchGit.Branches, "The branches after switching"),
          error: errors,
        }).annotateMerge(
          op("workbench.git.switch", "Switch branch", "Refused while tracked files have uncommitted changes."),
        ),
        HttpApiEndpoint.post("pullRequest", WorkbenchGitPaths.pullRequest, {
          query: WorkspaceRoutingQuery,
          payload: WorkbenchGit.PullRequestInput,
          success: described(WorkbenchGit.PullRequest, "The pull request"),
          error: errors,
        }).annotateMerge(
          op("workbench.git.pr", "Create a pull request", "gh pr create for the pushed branch (--fill, or a title)."),
        ),
        HttpApiEndpoint.post("message", WorkbenchGitPaths.message, {
          query: WorkspaceRoutingQuery,
          success: described(WorkbenchGit.Message, "A commit message for the staged diff"),
          error: errors,
        }).annotateMerge(
          op("workbench.git.message", "Generate a commit message", "Only with the config's small_model."),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "workbench-git", description: "Git panel routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(OpenApi.annotations({ title: "opencode HttpApi", version: "0.0.1", description: "Git panel routes." }))
