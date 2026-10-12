// DAP client: numbered requests matched to responses, events, and reverse requests
// (adapter → client, e.g. runInTerminal) that are always answered, success or not.
import { Effect, Schema } from "effect"
import type { DapTransport } from "./transport"

export const ErrorKind = Schema.Literals([
  "not_found",
  "invalid",
  "unsupported",
  "not_owner",
  "limit",
  "unavailable",
  "adapter",
  "timeout",
])
export type ErrorKind = typeof ErrorKind.Type

export class DebugError extends Schema.TaggedErrorClass<DebugError>()("WorkbenchDebugError", {
  kind: ErrorKind,
  message: Schema.String,
}) {}

export type Body = { readonly [key: string]: unknown }

export interface Client {
  readonly request: <T = Body>(command: string, args?: object, timeout?: number) => Effect.Effect<T, DebugError>
  readonly close: () => void
}

export type Input = {
  readonly open: (handlers: DapTransport.Handlers) => DapTransport.Wire | Promise<DapTransport.Wire>
  readonly onEvent: (event: string, body: Body) => void
  // Reverse request from the adapter. Resolve with the response body; reject to refuse it.
  readonly onRequest: (command: string, args: Body) => Promise<object>
  readonly onClose: (reason: string) => void
}

export const DEFAULT_TIMEOUT = 10_000

export function make(input: Input) {
  const pending = new Map<number, (response: DapTransport.Message) => void>()
  const state = { seq: 1, closed: undefined as string | undefined, protocol: undefined as string | undefined }
  const holder: { wire?: DapTransport.Wire } = {}

  const send = (message: object) => holder.wire?.send({ seq: state.seq++, ...message })

  const handlers: DapTransport.Handlers = {
    onMessage: (message) => {
      if (message.type === "response") return pending.get(Number(message.request_seq))?.(message)
      if (message.type === "event") return input.onEvent(String(message.event), body(message.body))
      const command = String(message.command)
      const reply = { type: "response", request_seq: message.seq, command }
      input.onRequest(command, body(message.arguments)).then(
        (result) => send({ ...reply, success: true, body: result }),
        (error: unknown) =>
          send({ ...reply, success: false, message: error instanceof Error ? error.message : String(error) }),
      )
    },
    onError: (error) => {
      state.protocol = error.message
    },
    onClose: () => {
      if (state.closed) return
      state.closed = state.protocol ?? "debug adapter closed the connection"
      for (const resolve of pending.values())
        resolve({ seq: 0, type: "response", success: false, message: state.closed })
      pending.clear()
      input.onClose(state.closed)
    },
  }

  const request = <T = Body>(command: string, args?: object, timeout = DEFAULT_TIMEOUT) =>
    Effect.callback<T, DebugError>((resume) => {
      if (state.closed) return resume(Effect.fail(new DebugError({ kind: "adapter", message: state.closed })))
      const seq = state.seq++
      pending.set(seq, (response) => {
        pending.delete(seq)
        if (response.success) return resume(Effect.succeed(body(response.body) as T))
        resume(Effect.fail(new DebugError({ kind: "adapter", message: `${command} failed: ${failure(response)}` })))
      })
      holder.wire?.send({ seq, type: "request", command, ...(args ? { arguments: args } : {}) })
      return Effect.sync(() => pending.delete(seq))
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new DebugError({ kind: "timeout", message: `${command} timed out after ${timeout} ms` })),
      }),
    )

  return Effect.tryPromise({
    try: () => Promise.resolve(input.open(handlers)),
    catch: (error) =>
      new DebugError({ kind: "adapter", message: `cannot connect to the debug adapter: ${String(error)}` }),
  }).pipe(
    Effect.map((wire): Client => {
      holder.wire = wire
      return { request, close: () => wire.close() }
    }),
  )
}

function body(value: unknown): Body {
  return typeof value === "object" && value !== null ? (value as Body) : {}
}

function failure(response: DapTransport.Message) {
  if (typeof response.message === "string" && response.message) return response.message
  const error = body(response.body).error
  return typeof error === "object" && error !== null && "format" in error ? String(error.format) : "no reason given"
}

export * as DapClient from "./client"
