// spicy: shells an agent starts (its bash tool) get AgentProvider.agentEnv(): not the Terminal.app window opencode came
// from, so macOS saves no "session restore" files for them, and still without the server's credentials. Every shell
// here runs with HOME and ZDOTDIR in a temp folder and a fake session id: the real home is never touched.
import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AgentProvider } from "@/agenthq/provider"

const apple = process.platform === "darwin" && existsSync("/etc/zshrc_Apple_Terminal")
const shells = ["/bin/zsh", "/bin/bash"].filter((shell) => existsSync(shell))
const TERMINAL = {
  TERM_PROGRAM: "Apple_Terminal",
  TERM_PROGRAM_VERSION: "455",
  TERM_SESSION_ID: "FAKE-0000-SPICY-AGENT",
}

async function home() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agent-home-")))
  await fs.writeFile(path.join(dir, ".zshrc"), "")
  return dir
}

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

/** An interactive login shell (what reads /etc/zshrc and /etc/bashrc) with exactly `env`. */
async function shell(file: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([file, "-i", "-l", "-c", 'echo "home=$HOME"'], {
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    cwd: env.HOME,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = await new Response(child.stdout).text()
  await child.exited
  return out
}

async function withParent<A>(vars: Record<string, string | undefined>, body: () => Promise<A>) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
  set(vars)
  return body().finally(() => set(saved))
}

describe("agent environment: not the Terminal.app window", () => {
  test("agentEnv names opencode as the terminal, drops the session id and still drops the credentials", () =>
    withParent({ ...TERMINAL, OPENCODE_SERVER_PASSWORD: "probe", SHELL_SESSIONS_DISABLE: undefined }, async () => {
      const env = AgentProvider.agentEnv()
      expect(env).toMatchObject({ TERM_PROGRAM: "opencode", SHELL_SESSIONS_DISABLE: "1" })
      expect(env.TERM_SESSION_ID).toBeUndefined()
      expect(env.TERM_PROGRAM_VERSION).toBeUndefined()
      expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    }))

  test.skipIf(!apple)("a shell started with agentEnv saves no macOS session files", () =>
    withParent({ ...TERMINAL, SHELL_SESSIONS_DISABLE: undefined }, async () => {
      for (const file of shells) {
        const dir = await home()
        const out = await shell(file, { ...AgentProvider.agentEnv(), HOME: dir, ZDOTDIR: dir })
        expect(out).toContain(`home=${dir}`)
        expect([file, await sessions(dir)]).toEqual([file, []])
        await fs.rm(dir, { recursive: true, force: true })
      }
    }),
  )

  test.skipIf(!apple)("control: the same shell with Terminal.app's environment does save them (in the temp home)", () =>
    Promise.resolve().then(async () => {
      for (const file of shells) {
        const dir = await home()
        const out = await shell(file, {
          ...process.env,
          ...TERMINAL,
          HOME: dir,
          ZDOTDIR: dir,
          SHELL_SESSIONS_DISABLE: undefined,
        })
        expect(out).toContain(`home=${dir}`)
        expect((await sessions(dir)).some((name) => name.includes(TERMINAL.TERM_SESSION_ID))).toBe(true)
        await fs.rm(dir, { recursive: true, force: true })
      }
    }),
  )
})
