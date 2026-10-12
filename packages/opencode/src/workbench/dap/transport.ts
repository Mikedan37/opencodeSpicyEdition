// Debug Adapter Protocol framing: `Content-Length: N\r\n\r\n` followed by N bytes of UTF-8 JSON.
// N counts bytes, not characters, and stream chunks may split or merge frames anywhere.
import { Option, Schema } from "effect"
import net from "net"
import type { Readable, Writable } from "stream"

export type Message = {
  seq: number
  type: "request" | "response" | "event"
  [key: string]: unknown
}

export interface Wire {
  readonly send: (message: object) => void
  readonly close: () => void
}

export type Handlers = {
  readonly onMessage: (message: Message) => void
  // A protocol error ends the stream: after it nothing more is decoded.
  readonly onError: (error: Error) => void
  readonly onClose: () => void
}

const MAX_HEADER = 1024
const MAX_BODY = 16 * 1024 * 1024

export function encode(message: object) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

export function decoder(handlers: Pick<Handlers, "onMessage" | "onError">) {
  let pending = Buffer.alloc(0)
  let failed = false
  const fail = (message: string) => {
    failed = true
    pending = Buffer.alloc(0)
    handlers.onError(new Error(message))
  }
  return (chunk: Uint8Array) => {
    if (failed) return
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
    while (!failed) {
      const end = pending.indexOf("\r\n\r\n")
      if (end === -1) {
        if (pending.length > MAX_HEADER) fail("DAP protocol error: header too long")
        return
      }
      const header = pending.subarray(0, end).toString("ascii")
      const length = Number(/(?:^|\r\n)content-length:[ \t]*(\d+)[ \t]*(?:\r\n|$)/i.exec(header)?.[1])
      if (!Number.isSafeInteger(length) || length > MAX_BODY) return fail(`DAP protocol error: bad header "${header}"`)
      if (pending.length < end + 4 + length) return
      const body = pending.subarray(end + 4, end + 4 + length).toString("utf8")
      pending = pending.subarray(end + 4 + length)
      const message = parse(body)
      if (!message) return fail("DAP protocol error: malformed message body")
      handlers.onMessage(message)
    }
  }
}

export function stream(input: Readable, output: Writable, handlers: Handlers): Wire {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    handlers.onClose()
  }
  const decode = decoder({
    onMessage: handlers.onMessage,
    onError: (error) => {
      handlers.onError(error)
      close()
    },
  })
  input.on("data", decode)
  input.on("close", close)
  input.on("error", close)
  output.on("error", close)
  return {
    send: (message) => {
      if (closed) return
      output.write(encode(message))
    },
    close: () => {
      input.off("data", decode)
      output.end()
      input.destroy()
      close()
    },
  }
}

/** Connects to an adapter that serves DAP over TCP. Only loopback is ever used. */
export function tcp(port: number, handlers: Handlers) {
  return new Promise<Wire>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.once("error", reject)
    socket.once("connect", () => {
      socket.off("error", reject)
      resolve(stream(socket, socket, handlers))
    })
  })
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const isMessage = Schema.is(
  Schema.Struct({ seq: Schema.Number, type: Schema.Literals(["request", "response", "event"]) }),
)

function parse(body: string) {
  const value = Option.getOrUndefined(decodeJson(body))
  return isMessage(value) ? (value as Message) : undefined
}

export * as DapTransport from "./transport"
