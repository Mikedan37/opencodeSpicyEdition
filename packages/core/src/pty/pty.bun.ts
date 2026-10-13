import { spawn as create } from "bun-pty"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  // spicy: bun-pty starts the child with this process's own environment plus `opts.env`, so a variable left out of
  // `opts.env` (the server's credentials, TERM_SESSION_ID) would still be inherited. /usr/bin/env -u drops those
  // first (names only, no values on the command line). node-pty takes `opts.env` as the whole environment.
  const env = opts.env
  const dropped = env && process.platform !== "win32" ? Object.keys(process.env).filter((key) => !(key in env)) : []
  const pty = dropped.length
    ? create("/usr/bin/env", [...dropped.flatMap((key) => ["-u", key]), file, ...args], opts)
    : create(file, args, opts)
  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener) {
      return pty.onExit(listener)
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      pty.kill(signal)
    },
  }
}
