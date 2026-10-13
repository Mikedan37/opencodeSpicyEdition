// spicy: project search for the IDE's Search tab (src/workbench/search.ts). A person's route: Workbench bridge tokens
// do not reach it (server/bridge-token.ts).
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const Flag = Schema.optional(Schema.Literals(["true", "false"]))

export const SearchQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.NonEmptyString,
  regex: Flag.annotate({ description: "The query is a regular expression (default: literal text)" }),
  case: Flag.annotate({ description: "Match case (default: ignore case)" }),
  word: Flag.annotate({ description: "Whole words only" }),
  include: Schema.optional(Schema.String).annotate({ description: "Comma-separated globs or paths to search" }),
  exclude: Schema.optional(Schema.String).annotate({ description: "Comma-separated globs or paths to skip" }),
})

export const SearchResult = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.annotate({ description: "Relative to the directory" }),
      hash: Schema.optional(Schema.String).annotate({
        description:
          "sha256 of the file's bytes when it was searched: the baseHash of a replace. Absent for files the editor does not open (binary, not UTF-8, over 8 MB)",
      }),
      lines: Schema.Array(
        Schema.Struct({
          line: Schema.Int.annotate({ description: "1-based" }),
          text: Schema.String.annotate({ description: "The line without its newline, cut at 2,000 characters" }),
        }),
      ),
    }),
  ),
  listed: Schema.Int.annotate({ description: "Matches in the lines sent (they stop after 2,000)" }),
  total: Schema.Int.annotate({ description: "Matches in the project" }),
}).annotate({ identifier: "WorkbenchSearchResult" })

export const WorkbenchSearchApi = HttpApi.make("workbench-search")
  .add(
    HttpApiGroup.make("workbench-search")
      .add(
        HttpApiEndpoint.get("search", "/workbench/search", {
          query: SearchQuery,
          success: described(SearchResult, "Matching lines by file, with each file's hash"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workbench.search",
            summary: "Search the project",
            description:
              "Lines matching a literal or regular-expression query across the project (gitignore-aware, with hidden files, without .git), grouped by file in path order. A pattern or glob ripgrep refuses is a 400 with its message.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "workbench-search", description: "Project search routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "opencode HttpApi", version: "0.0.1", description: "Project search routes." }),
  )
