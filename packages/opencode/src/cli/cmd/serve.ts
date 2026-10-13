import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

// spicy: how long a signal waits for the server to stop before it ends the process anyway
const SIGNAL_STOP_MS = 8_000

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // spicy: SIGTERM or SIGINT stops the server first, which disposes its instances, so language servers get
    // `shutdown` and `exit` instead of being orphaned (clangd aborts when it outlives its pipes, leaving a crash
    // report). Then the same signal ends the process as before; a second one ends it at once.
    const stop = (signal: NodeJS.Signals) => {
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
      const end = () => process.kill(process.pid, signal)
      setTimeout(end, SIGNAL_STOP_MS).unref()
      void server.stop(true).finally(end)
    }
    process.on("SIGTERM", stop)
    process.on("SIGINT", stop)

    yield* Effect.never
  }),
})
