// A real opencode listener with a password, the way the desktop app runs the server. While it runs, `Server.url`
// is set, so Agent HQ gives external agents the Workbench MCP server pointed at it.
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import net from "node:net"
import { Server } from "../../../src/server/server"
import { disposeAllInstances } from "../fixture"

export const auth = { username: "opencode", password: "ahq-bridge-secret" }

// An explicit free port: port 0 would try 4096 first, which a developer's own opencode may be using.
export const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })

export const listener = Effect.acquireRelease(
  Effect.promise(async () => {
    const saved = {
      flag: [Flag.OPENCODE_SERVER_USERNAME, Flag.OPENCODE_SERVER_PASSWORD],
      env: [process.env.OPENCODE_SERVER_USERNAME, process.env.OPENCODE_SERVER_PASSWORD],
    }
    Flag.OPENCODE_SERVER_USERNAME = process.env.OPENCODE_SERVER_USERNAME = auth.username
    Flag.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD = auth.password
    return { saved, server: await Server.listen({ hostname: "127.0.0.1", port: await freePort() }) }
  }),
  ({ saved, server }) =>
    Effect.promise(async () => {
      await server.stop(true)
      await disposeAllInstances()
      ;[Flag.OPENCODE_SERVER_USERNAME, Flag.OPENCODE_SERVER_PASSWORD] = saved.flag
      const [username, password] = saved.env
      if (username === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = username
      if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = password
    }),
)
