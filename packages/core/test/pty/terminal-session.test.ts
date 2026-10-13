// spicy: shells in opencode's PTYs must not write the macOS Terminal "session restore" files of the Terminal.app window
// opencode was started from (~/.zsh_sessions/<TERM_SESSION_ID>.*, ~/.bash_sessions/<id>.*). Every shell here runs with
// HOME and ZDOTDIR in a temp folder and a fake session id: the real home and the real window are never touched.
import { describe, expect } from "bun:test"
import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawn } from "bun-pty"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
    ],
  ]),
)
// Only macOS has the per-Terminal rc files; without them there is nothing to protect.
const apple = process.platform === "darwin" && existsSync("/etc/zshrc_Apple_Terminal")
const shells = ["/bin/zsh", "/bin/bash"].filter((shell) => existsSync(shell))
const macOS = apple ? it.live : it.live.skip
const TERMINAL = { TERM_PROGRAM: "Apple_Terminal", TERM_SESSION_ID: "FAKE-0000-SPICY-TEST" }

/** A temp home with an empty .zshrc (so zsh's new-user menu stays away). */
async function home() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-shell-home-")))
  await fs.writeFile(path.join(dir, ".zshrc"), "")
  return dir
}

/** What macOS saved for a Terminal session under `dir`. */
async function sessions(dir: string) {
  const lists = await Promise.all(
    [".zsh_sessions", ".bash_sessions"].map((folder) =>
      fs.readdir(path.join(dir, folder)).then(
        (files) => [folder, ...files.map((file) => `${folder}/${file}`)],
        () => [],
      ),
    ),
  )
  return lists.flat()
}

/** Runs one command in an interactive login shell, then exits; resolves with what it printed. */
function run(shell: string, env: Record<string, string>, cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const pty = spawn(shell, ["-l"], { name: "xterm-256color", cwd, env })
    let out = ""
    const timer = setTimeout(() => {
      pty.kill()
      reject(new Error(`${shell} did not exit: ${out}`))
    }, 15_000)
    pty.onData((data) => (out += data))
    pty.onExit(() => {
      clearTimeout(timer)
      resolve(out)
    })
    pty.write('echo "home=$HOME"\nexit\n')
  })
}

function withParent<A>(vars: Record<string, string | undefined>, body: () => Promise<A>) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
  set(vars)
  return body().finally(() => set(saved))
}

describe("pty: not the Terminal.app window opencode came from", () => {
  macOS("a shell in an opencode PTY saves no macOS session files, even under Terminal.app", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      for (const shell of shells) {
        const dir = yield* Effect.promise(home)
        // The parent looks like a Terminal.app window: its program and a session id.
        yield* Effect.promise(() =>
          withParent({ ...TERMINAL, SHELL_SESSIONS_DISABLE: undefined }, () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const info = yield* pty.create({ command: shell, cwd: dir, env: { HOME: dir, ZDOTDIR: dir } })
                let printed = ""
                const attachment = yield* pty.attach(info.id, {
                  onData: (chunk) => (printed += chunk),
                  onEnd: () => {},
                })
                attachment.activate()
                yield* pty.write(
                  info.id,
                  'echo "home=$HOME sid=${TERM_SESSION_ID-unset} tp=$TERM_PROGRAM ssd=$SHELL_SESSIONS_DISABLE"\nexit\n',
                )
                yield* Effect.promise(async () => {
                  const deadline = Date.now() + 15_000
                  while (Date.now() < deadline) {
                    if ((await Effect.runPromise(pty.get(info.id))).status === "exited") return
                    await new Promise((resolve) => setTimeout(resolve, 50))
                  }
                  throw new Error(`${shell} did not exit: ${printed}`)
                })
                yield* pty.remove(info.id).pipe(Effect.ignore)
                // The shell ran with the temp home, so the check below looks where macOS would have written.
                expect(printed).toContain(`home=${dir} sid=unset tp=opencode ssd=1`)
              }),
            ),
          ),
        )
        expect([shell, yield* Effect.promise(() => sessions(dir))]).toEqual([shell, []])
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  macOS("control: the same shell with Terminal.app's environment does save them (in the temp home)", () =>
    Effect.promise(async () => {
      for (const shell of shells) {
        const dir = await home()
        // SHELL_SESSIONS_DISABLE=0 explicitly: the test process may have it set, and the child would inherit it.
        const env = { ...process.env, ...TERMINAL, HOME: dir, ZDOTDIR: dir, SHELL_SESSIONS_DISABLE: "0" } as Record<
          string,
          string
        >
        const printed = await run(shell, env, dir)
        expect(printed).toContain(`home=${dir}`)
        expect((await sessions(dir)).some((file) => file.includes(TERMINAL.TERM_SESSION_ID))).toBe(true)
        await fs.rm(dir, { recursive: true, force: true })
      }
    }),
  )

  it.live("a variable left out of the environment is not inherited from this process's own environment", () =>
    Effect.promise(async () => {
      if (process.platform === "win32") return
      // A child Bun process holds the variables in its real environment (not just process.env), as a server started
      // from Terminal.app or by the desktop app does; its PTY leaves them out.
      const backend = path.join(import.meta.dir, "../../src/pty/pty.bun.ts")
      const script = `const { spawn } = await import(${JSON.stringify(backend)})
const env = { ...process.env }
delete env.SPICY_SECRET
delete env.TERM_SESSION_ID
const pty = spawn("/bin/sh", ["-c", 'echo "secret=\${SPICY_SECRET-unset} sid=\${TERM_SESSION_ID-unset} kept=\${SPICY_KEPT-unset}"'], { name: "xterm", cwd: "/tmp", env })
let out = ""
pty.onData((data) => (out += data))
pty.onExit(() => { process.stdout.write(out); process.exit(0) })`
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, SPICY_SECRET: "hunter2", TERM_SESSION_ID: TERMINAL.TERM_SESSION_ID, SPICY_KEPT: "yes" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const out = await new Response(child.stdout).text()
      await child.exited
      expect(out).toContain("secret=unset sid=unset kept=yes")
    }),
  )

  macOS("ownTerminal: no session id or Terminal version, opencode as the program, sessions disabled", () =>
    Effect.sync(() => {
      const env = Pty.ownTerminal({ ...TERMINAL, TERM_PROGRAM_VERSION: "455", PATH: "/usr/bin" })
      expect(env).toEqual({ TERM_PROGRAM: "opencode", SHELL_SESSIONS_DISABLE: "1", PATH: "/usr/bin" })
    }),
  )
})
