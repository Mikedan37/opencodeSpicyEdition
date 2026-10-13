// spicy: project search route handler (src/workbench/search.ts).
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkbenchSearch } from "@/workbench/search"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"
import type { SearchQuery } from "../groups/workbench-search"

export const workbenchSearchHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-search", (handlers) =>
  Effect.gen(function* () {
    const search = yield* WorkbenchSearch.Service
    return handlers.handle("search", (ctx: { query: typeof SearchQuery.Type }) =>
      search
        .search({
          query: ctx.query.query,
          regex: ctx.query.regex === "true",
          caseSensitive: ctx.query.case === "true",
          word: ctx.query.word === "true",
          include: ctx.query.include,
          exclude: ctx.query.exclude,
        })
        .pipe(
          Effect.catchTag("WorkbenchSearch.InvalidQuery", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message, kind: "invalid_query" })),
          ),
        ),
    )
  }),
)
