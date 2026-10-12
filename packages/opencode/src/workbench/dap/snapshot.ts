// What the agent reads after each stop. Built from stackTrace, scopes, variables and
// exceptionInfo requests only: reading program state never runs code in the program.
import path from "path"
import { Effect } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { Redact } from "../redact"
import type { DapClient } from "./client"

export const LIMITS = { depth: 2, children: 50, chars: 512, frames: 20, bytes: 2048, expand: 10 }

type Request = DapClient.Client["request"]
type DapFrame = { id: number; name: string; line?: number; column?: number; source?: { path?: string; name?: string } }
type DapScope = { name: string; variablesReference: number; expensive?: boolean }
type DapVariable = {
  name: string
  value?: string
  type?: string
  variablesReference?: number
  presentationHint?: { kind?: string }
}

export type View = typeof Workbench.VariableView.Type
export type Tree = View & { readonly children?: Tree[] }

export function view(variable: DapVariable): View {
  return {
    name: variable.name,
    ...(variable.type ? { type: variable.type } : {}),
    value: cap(Redact.value(variable.name, variable.value ?? ""), LIMITS.chars),
    variablesReference: Math.max(0, variable.variablesReference ?? 0),
  }
}

/** One page (50) of a variable's children, redacted and capped. Adapter-synthesized groups are dropped. */
export const variables = Effect.fnUntraced(function* (request: Request, ref: number, start = 0) {
  const body = yield* request<{ variables?: DapVariable[] }>("variables", { variablesReference: ref })
  return (body.variables ?? [])
    .filter((item) => item.presentationHint?.kind !== "virtual")
    .slice(start, start + LIMITS.children)
    .map(view)
})

/** Children expanded to `depth` levels; only the first few expandable items of a level are opened. */
export const tree = (
  request: Request,
  ref: number,
  depth = LIMITS.depth,
  start = 0,
): Effect.Effect<Tree[], DapClient.DebugError> =>
  Effect.gen(function* () {
    const items = yield* variables(request, ref, start)
    if (depth <= 1) return items
    const open = new Set(items.filter((item) => item.variablesReference > 0).slice(0, LIMITS.expand))
    return yield* Effect.forEach(items, (item) =>
      open.has(item)
        ? tree(request, item.variablesReference, depth - 1).pipe(Effect.map((children) => ({ ...item, children })))
        : Effect.succeed(item),
    )
  })

export const build = Effect.fnUntraced(function* (
  request: Request,
  input: {
    readonly threadID?: number
    readonly reason: string
    readonly description?: string
    readonly exceptionInfo: boolean
  },
) {
  const threadID = input.threadID ?? (yield* request<{ threads?: { id: number }[] }>("threads")).threads?.[0]?.id ?? 1
  const trace = yield* request<{ stackFrames?: DapFrame[] }>("stackTrace", {
    threadId: threadID,
    startFrame: 0,
    levels: LIMITS.frames,
  })
  const frames = trace.stackFrames ?? []
  const top = frames[0]
  const scopes = top ? ((yield* request<{ scopes?: DapScope[] }>("scopes", { frameId: top.id })).scopes ?? []) : []
  const scope = scopes.find((item) => !item.expensive && item.variablesReference > 0)
  const locals = scope ? yield* variables(request, scope.variablesReference) : []
  const exception =
    input.reason === "exception" && input.exceptionInfo
      ? yield* request<{ exceptionId?: string; description?: string }>("exceptionInfo", { threadId: threadID }).pipe(
          Effect.map((body) => ({
            // debugpy appends notes to the id ("ZeroDivisionError   (note: ...)"); class names have no spaces.
            ...(body.exceptionId ? { id: body.exceptionId.trim().split(/\s/)[0] } : {}),
            ...(body.description ? { description: Redact.text(body.description) } : {}),
          })),
          Effect.orElseSucceed(() => (input.description ? { description: Redact.text(input.description) } : {})),
        )
      : undefined
  return fit({
    reason: input.reason,
    ...(input.description ? { description: Redact.text(input.description) } : {}),
    threadID,
    frames: frames.map((item): Workbench.StopSnapshot["frames"][number] => ({
      id: item.id,
      name: item.name,
      ...(item.source?.path ? { file: item.source.path } : {}),
      ...(item.line !== undefined && item.line >= 0 ? { line: item.line } : {}),
      ...(item.column !== undefined && item.column >= 0 ? { column: item.column } : {}),
    })),
    locals,
    ...(exception ? { exception } : {}),
    at: Date.now(),
  })
})

/** Shrinks a snapshot until its JSON is about 2 KB: fewer frames, fewer locals, shorter values. */
export function fit(snapshot: Workbench.StopSnapshot): Workbench.StopSnapshot {
  const steps = [
    [LIMITS.frames, LIMITS.children, LIMITS.chars],
    [10, 25, 160],
    [6, 15, 80],
    [3, 8, 40],
    [1, 4, 24],
  ] as const
  const shrink = ([frames, locals, chars]: (typeof steps)[number]) => ({
    ...snapshot,
    frames: snapshot.frames.slice(0, frames),
    locals: snapshot.locals.slice(0, locals).map((item) => ({ ...item, value: cap(item.value, chars) })),
  })
  return (
    steps.map(shrink).find((item) => JSON.stringify(item).length <= LIMITS.bytes) ?? shrink(steps[steps.length - 1])
  )
}

export function text(input: {
  readonly snapshot: Workbench.StopSnapshot
  readonly directory: string
  readonly owner?: Workbench.Owner
}) {
  const snapshot = input.snapshot
  const where = (frame: Workbench.StopSnapshot["frames"][number]) =>
    frame.file ? `${relative(input.directory, frame.file)}:${frame.line ?? "?"}` : "no source"
  const top = snapshot.frames[0]
  return [
    `stopped   ${snapshot.reason}${snapshot.description ? ` (${snapshot.description})` : ""} · thread ${snapshot.threadID}`,
    ...(snapshot.exception
      ? [`exception ${[snapshot.exception.id, snapshot.exception.description].filter(Boolean).join(": ")}`]
      : []),
    ...(top ? [`at        ${where(top)} in ${top.name}`] : []),
    ...(snapshot.frames.length > 1
      ? [`frames    ${snapshot.frames.map((frame) => `${frame.name} (${where(frame)})`).join(" <- ")}`]
      : []),
    `locals    ${snapshot.locals.length ? snapshot.locals.map(line).join(" · ") : "(none)"}`,
    ...(input.owner ? [`owner     ${input.owner}`] : []),
  ].join("\n")
}

export function treeText(items: Tree[], indent = ""): string {
  return items
    .map((item) => [`${indent}${line(item)}`, ...(item.children ? [treeText(item.children, indent + "  ")] : [])])
    .flat()
    .filter(Boolean)
    .join("\n")
}

function line(item: View) {
  return `${item.name}${item.type ? `: ${item.type}` : ""} = ${item.value}${item.variablesReference > 0 ? ` [ref ${item.variablesReference}]` : ""}`
}

function relative(directory: string, file: string) {
  const result = path.relative(directory, file)
  return result.startsWith("..") || path.isAbsolute(result) ? file : result
}

export function cap(value: string, chars: number) {
  return value.length <= chars ? value : value.slice(0, chars - 1) + "…"
}

export * as DebugSnapshot from "./snapshot"
