// spicy: the IDE's project search (GET /workbench/search). ripgrep lists the matching lines, gitignore-aware; every
// file comes with the sha256 of its bytes as read right after, so a replace (PUT /workbench/file with that baseHash)
// only lands on the file as it was searched. Where in a line the query matches is the client's to work out: it matches
// each line in JavaScript, the same way it replaces (packages/app/src/workbench/search.ts).
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"
import { WorkbenchEditorFile } from "./editor-file"

// Lines are sent until they hold this many matches; the rest are only counted.
export const MAX_MATCHES = 2_000
// Characters of a line sent; matches further right are not listed.
export const MAX_LINE = 2_000

export type Input = {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  word?: boolean
  // Comma-separated globs or paths.
  include?: string
  exclude?: string
}

export type Line = { line: number; text: string }
export type File = { path: string; hash?: string; lines: Line[] }
// `listed`: ripgrep's matches in the lines sent. `total`: all of them.
export type Result = { files: File[]; listed: number; total: number }

// A pattern or glob ripgrep refuses, with its message.
export class InvalidQuery extends Schema.TaggedErrorClass<InvalidQuery>()("WorkbenchSearch.InvalidQuery", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly search: (input: Input) => Effect.Effect<Result, InvalidQuery>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchSearch") {}

// "src", "src/app" or "*.ts, docs/**": a plain path also stands for everything under it, at any depth when it has no
// slash, like VS Code's "files to include". Commas inside braces belong to their glob.
export function globs(text = "") {
  return text
    .split(/,(?![^{]*\})/)
    .map((entry) => entry.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean)
    .flatMap((entry) =>
      /[*?[{]/.test(entry) ? [entry] : entry.includes("/") ? [entry, `${entry}/**`] : [entry, `**/${entry}/**`],
    )
}

export function args(input: Input, output: "--json" | "--count-matches") {
  return [
    "--no-config",
    output,
    ...(output === "--count-matches" ? ["--no-filename"] : []),
    "--hidden",
    "--no-messages",
    // auto: PCRE2 when the pattern needs it (look-around, backreferences), as JavaScript allows them.
    input.regex ? "--engine=auto" : "--fixed-strings",
    input.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ...(input.word ? ["--word-regexp"] : []),
    ...globs(input.include).map((glob) => `--glob=${glob}`),
    ...globs(input.exclude).map((glob) => `--glob=!${glob}`),
    "--glob=!**/.git/**",
    "--",
    input.query,
    ".",
  ]
}

type Row = { path: string; line: number; text: string; matches: number }

// One `--json` record; undefined for the other kinds and for paths or lines that are not UTF-8.
function parse(record: string): Row | undefined {
  const value = (() => {
    try {
      return JSON.parse(record) as {
        type?: string
        data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: unknown[] }
      }
    } catch {
      return undefined
    }
  })()
  const data = value?.type === "match" ? value.data : undefined
  const file = data?.path?.text
  const text = data?.lines?.text
  if (file === undefined || text === undefined || typeof data?.line_number !== "number") return undefined
  const line = text.replace(/\n$/, "")
  return {
    path: file.replaceAll("\\", "/").replace(/^\.\//, ""),
    line: data.line_number,
    text: line.length > MAX_LINE ? line.slice(0, MAX_LINE).replace(/[\uD800-\uDBFF]$/, "") : line,
    matches: data.submatches?.length ?? 0,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const search = Effect.fn("WorkbenchSearch.search")(function* (input: Input) {
      const ctx = yield* InstanceState.context
      const rg = yield* binary.filepath.pipe(Effect.orDie)
      const command = (output: "--json" | "--count-matches") =>
        ChildProcess.make(rg, args(input, output), { cwd: ctx.directory, extendEnv: true, stdin: "ignore" })

      const files = new Map<string, Line[]>()
      let listed = 0
      yield* proc.runStream(command("--json"), { okExitCodes: [0, 1] }).pipe(
        // Records are kept by the predicate itself: streams run in chunks, so a later stage would see the cap late.
        Stream.takeWhile((record) => {
          if (listed >= MAX_MATCHES) return false
          const row = parse(record)
          if (!row) return true
          listed += row.matches
          const line = { line: row.line, text: row.text }
          const lines = files.get(row.path)
          if (lines) lines.push(line)
          else files.set(row.path, [line])
          return true
        }),
        Stream.runDrain,
        Effect.catchTag("AppProcessError", (error) => {
          if (error.exitCode !== 2) return Effect.die(error)
          // Exit 2 with a message: a pattern or glob ripgrep refuses (--no-messages keeps unreadable files quiet; those
          // also exit 2, and the rest of the results still count).
          const message = error.stderr?.trim()
          return message ? Effect.fail(new InvalidQuery({ message })) : Effect.void
        }),
      )
      // Past the cap, the matches are counted in a second, cheaper pass.
      const total =
        listed < MAX_MATCHES
          ? listed
          : yield* proc.run(command("--count-matches")).pipe(
              Effect.map((result) =>
                result.stdout
                  .toString("utf8")
                  .split("\n")
                  .reduce((sum, count) => sum + (Number(count) || 0), 0),
              ),
              Effect.map((counted) => Math.max(counted, listed)),
              Effect.orDie,
            )

      const result: File[] = []
      for (const [path, lines] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const file = yield* Effect.promise(() => WorkbenchEditorFile.read(ctx, path))
        result.push(WorkbenchEditorFile.isFailure(file) ? { path, lines } : { path, hash: file.hash, lines })
      }
      return { files: result, listed, total }
    })

    return Service.of({ search })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [AppProcess.node, RipgrepBinary.node] })

export * as WorkbenchSearch from "./search"
