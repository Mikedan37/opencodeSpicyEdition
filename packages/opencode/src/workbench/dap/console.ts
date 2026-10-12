// Debug console backend: one bounded row list per session (program output, evaluations,
// stops, system notes), batched for events, plus evaluate and completions.
import { Effect } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { Redact } from "../redact"
import { DebugError, type DapClient } from "./client"
import { DebugSnapshot } from "./snapshot"

export const LIMITS = { bytes: 256 * 1024, row: 16 * 1024, flushMs: 32, completions: 50 }

type Row = Workbench.ConsoleRow
type NewRow = Omit<Row, "seq" | "at">

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

export function make(input: { readonly publish: (rows: Row[]) => void; readonly bytes?: number }) {
  const limit = input.bytes ?? LIMITS.bytes
  const rows: Row[] = []
  const state = {
    seq: 0,
    bytes: 0,
    dropped: 0,
    pending: [] as Row[],
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }

  const flush = () => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    if (state.pending.length) input.publish(state.pending.splice(0))
  }

  const push = (row: NewRow) => {
    const next: Row = {
      ...row,
      text: DebugSnapshot.cap(Redact.text(row.text), LIMITS.row),
      seq: ++state.seq,
      at: Date.now(),
    }
    rows.push(next)
    state.bytes += Buffer.byteLength(next.text)
    while (state.bytes > limit && rows.length > 1) {
      state.bytes -= Buffer.byteLength(rows.shift()!.text)
      state.dropped++
    }
    state.pending.push(next)
    if (!state.timer) state.timer = setTimeout(flush, LIMITS.flushMs)
    return next
  }

  return {
    push,
    flush,
    system: (text: string) => push({ kind: "system", by: "system", text }),
    /** Maps a DAP output event. Telemetry is dropped; program output keeps its stream. */
    output: (body: DapClient.Body) => {
      const category = typeof body.category === "string" ? body.category : "console"
      if (category === "telemetry") return
      const kind = category === "stdout" || category === "stderr" ? category : "console"
      const source = body.source as { path?: string } | undefined
      push({
        kind,
        by: kind === "console" ? "adapter" : "program",
        text: String(body.output ?? ""),
        ...(typeof body.variablesReference === "number" && body.variablesReference > 0
          ? { variablesReference: body.variablesReference }
          : {}),
        ...(source?.path && typeof body.line === "number" ? { location: { file: source.path, line: body.line } } : {}),
      })
    },
    /** Raw terminal output (runInTerminal through the PTY): escapes stripped, line endings normalized. */
    terminal: (chunk: string) =>
      push({ kind: "stdout", by: "program", text: chunk.replace(ANSI, "").replace(/\r\n?/g, "\n") }),
    /** Rows after `after`, led by a truncation row when the 256 KB cap dropped older output. */
    list: (after = 0): Row[] => {
      const items = rows.filter((row) => row.seq > after)
      const first = rows[0]
      if (!state.dropped || !first || after >= first.seq) return items
      return [
        {
          seq: first.seq - 1,
          at: first.at,
          kind: "system",
          by: "system",
          text: `… ${state.dropped} earlier rows dropped (${Math.round(limit / 1024)} KB output cap)`,
        },
        ...items,
      ]
    },
  }
}

export type Console = ReturnType<typeof make>

/** Runs an expression in a frame. This executes code inside the program; callers ask permission first. */
export const evaluate = Effect.fnUntraced(function* (input: {
  readonly request: DapClient.Client["request"]
  readonly console: Console
  readonly adapter: string
  readonly expression: string
  readonly frameID?: number
  readonly by: "agent" | "human"
  readonly timeout?: number
}) {
  // lldb-dap runs raw LLDB commands (platform shell, script) behind its escape prefix. Agents only get expressions.
  if (input.by === "agent" && input.adapter === "lldb-dap" && input.expression.trimStart().startsWith("`"))
    return yield* new DebugError({ kind: "unsupported", message: "LLDB command mode is not available to the agent" })
  input.console.push({ kind: "eval", by: input.by, text: input.expression })
  return yield* input
    .request<{
      result?: string
      type?: string
      variablesReference?: number
    }>(
      "evaluate",
      {
        expression: input.expression,
        ...(input.frameID !== undefined ? { frameId: input.frameID } : {}),
        context: "repl",
      },
      input.timeout,
    )
    .pipe(
      Effect.map((body) =>
        input.console.push({
          kind: "result",
          by: input.by,
          text: `${body.result ?? ""}`,
          ...(body.variablesReference ? { variablesReference: body.variablesReference } : {}),
        }),
      ),
      Effect.catchIf(
        (error) => error.kind === "adapter" || error.kind === "timeout",
        (error) =>
          Effect.succeed(
            input.console.push({
              kind: "exception",
              by: input.by,
              text:
                error.kind === "timeout"
                  ? `${error.message}; an adapter that cannot cancel requests stays busy until the session is stopped`
                  : error.message.replace(/^evaluate failed: /, ""),
            }),
          ),
      ),
    )
})

export const completions = Effect.fnUntraced(function* (input: {
  readonly request: DapClient.Client["request"]
  readonly text: string
  readonly column?: number
  readonly frameID?: number
}) {
  const body = yield* input.request<{
    targets?: { label: string; text?: string; type?: string; start?: number; length?: number }[]
  }>("completions", {
    text: input.text,
    column: input.column ?? input.text.length + 1,
    ...(input.frameID !== undefined ? { frameId: input.frameID } : {}),
  })
  return (body.targets ?? []).slice(0, LIMITS.completions).map((item) => ({
    label: item.label,
    ...(item.text !== undefined ? { text: item.text } : {}),
    ...(item.type ? { type: item.type } : {}),
    ...(item.start !== undefined ? { start: item.start } : {}),
    ...(item.length !== undefined ? { length: item.length } : {}),
  }))
})

export * as DebugConsole from "./console"
