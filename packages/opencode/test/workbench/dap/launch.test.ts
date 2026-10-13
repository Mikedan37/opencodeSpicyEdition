import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Debugpy } from "../../../src/workbench/dap/adapters/debugpy"
import { DebugLaunch } from "../../../src/workbench/dap/launch"

const ok = (input: DebugLaunch.StartInput, directory: string) =>
  Effect.runPromise(DebugLaunch.resolve(input, { directory }))
const fail = (input: DebugLaunch.StartInput, directory: string) =>
  Effect.runPromise(DebugLaunch.resolve(input, { directory }).pipe(Effect.flip)).then((error) => error.message)

async function project(launch?: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-launch-"))
  if (launch) await Bun.write(path.join(directory, ".vscode", "launch.json"), launch)
  return directory
}

describe("launch specs", () => {
  test("variables: workspaceFolder, file, env; unknown or missing ones are errors", () => {
    process.env.OPENCODE_LAUNCH_TEST = "from-env"
    expect(
      DebugLaunch.substitute(
        {
          program: "${workspaceFolder}/a.py",
          args: ["${file}", "${env:OPENCODE_LAUNCH_TEST}", "${env:OPENCODE_UNSET_X}"],
        },
        { workspaceFolder: "/repo", file: "/repo/b.py" },
      ),
    ).toEqual({ program: "/repo/a.py", args: ["/repo/b.py", "from-env", ""] })
    expect(DebugLaunch.substitute({ program: "${file}" }, { workspaceFolder: "/repo" })).toBe(
      "${file} needs the file parameter",
    )
    expect(DebugLaunch.substitute({ pid: "${command:pickProcess}" }, {})).toBe(
      "unsupported variable ${command:pickProcess}",
    )
  })

  test("SEC-04 environment variables are expanded only through an explicit ${env:NAME}", () => {
    process.env.OPENCODE_LAUNCH_CANARY = "canary-secret"
    const resolved = DebugLaunch.substitute(
      { program: "${workspaceFolder}/a.py", args: ["$OPENCODE_LAUNCH_CANARY", "%OPENCODE_LAUNCH_CANARY%"] },
      { workspaceFolder: "/repo" },
    )
    expect(resolved).toEqual({ program: "/repo/a.py", args: ["$OPENCODE_LAUNCH_CANARY", "%OPENCODE_LAUNCH_CANARY%"] })
    expect(JSON.stringify(resolved)).not.toContain("canary-secret")
    // A bare ${NAME} is not an environment lookup: it is refused, not expanded.
    expect(DebugLaunch.substitute({ args: ["${OPENCODE_LAUNCH_CANARY}"] }, {})).toBe(
      "unsupported variable ${OPENCODE_LAUNCH_CANARY}",
    )
    expect(DebugLaunch.substitute({ args: ["${env:OPENCODE_LAUNCH_CANARY}"] }, {})).toEqual({ args: ["canary-secret"] })
  })

  // The security review's repro (spicy-security, 2a8d2d441), inverted: ${env:NAME} expanded any server variable into
  // the program's arguments, whose output reaches the model unredacted.
  test("SECURITY ${env:NAME} never passes a secret: the start fails naming it; ordinary variables still expand", async () => {
    const vars = { workspaceFolder: "/proj", userHome: "/home/u", pathSeparator: "/" }
    process.env.SPICY_SECURITY_PROBE_SECRET = "super-secret-pw-123"
    try {
      const out = DebugLaunch.substitute({ type: "python", args: ["${env:SPICY_SECURITY_PROBE_SECRET}"] }, vars)
      expect(out).toBe("${env:SPICY_SECURITY_PROBE_SECRET} names a secret and is not passed to the program")
      expect(JSON.stringify(out)).not.toContain("super-secret-pw-123")
    } finally {
      delete process.env.SPICY_SECURITY_PROBE_SECRET
    }
    // Refused by name, set or not: the server's credentials and provider keys never reach a program.
    for (const name of [
      "OPENCODE_SERVER_PASSWORD",
      "OPENCODE_SERVER_USERNAME",
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SESSION_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "DB_PASSWORD",
      "STRIPE_KEY",
    ])
      expect(DebugLaunch.substitute({ env: { X: `\${env:${name}}` } }, vars)).toBe(
        `\${env:${name}} names a secret and is not passed to the program`,
      )
    expect(
      DebugLaunch.substitute({ args: ["${env:HOME}"], env: { PATH: "${env:PATH}", ME: "${env:USER}" } }, vars),
    ).toEqual({ args: [process.env.HOME ?? ""], env: { PATH: process.env.PATH ?? "", ME: process.env.USER ?? "" } })
    // Through launch.json, the start is refused with that error.
    const directory = await project(
      JSON.stringify({
        configurations: [
          {
            name: "leak",
            type: "python",
            request: "launch",
            program: "app.py",
            args: ["${env:OPENCODE_SERVER_PASSWORD}"],
          },
        ],
      }),
    )
    expect(await fail({ configuration: "leak" }, directory)).toBe(
      "${env:OPENCODE_SERVER_PASSWORD} names a secret and is not passed to the program",
    )
  })

  test("plain programs pick the adapter by type", async () => {
    const directory = await project()
    const py = await ok(
      { program: "app.py", args: ["--n", "2"], breakpoints: [{ file: "app.py", line: 3 }] },
      directory,
    )
    expect(py).toMatchObject({
      adapter: "debugpy",
      program: path.join(directory, "app.py"),
      arguments: {
        program: path.join(directory, "app.py"),
        args: ["--n", "2"],
        console: "internalConsole",
        justMyCode: true,
      },
      breakpoints: [{ file: path.join(directory, "app.py"), line: 3 }],
      exceptions: ["uncaught"],
    })
    const native = await ok({ program: "build/avg" }, directory)
    expect(native).toMatchObject({
      adapter: "lldb-dap",
      arguments: { runInTerminal: false, console: "internalConsole", commandEscapePrefix: "`" },
      exceptions: [],
    })
    const test = await ok({ preset: "python-test", program: "tests/test_avg.py" }, directory)
    expect(test).toMatchObject({
      adapter: "debugpy",
      arguments: { module: "pytest", args: [path.join(directory, "tests/test_avg.py")] },
      exceptions: ["uncaught", "userUnhandled"],
    })
    const none = await fail({}, directory)
    expect(none).toBe("give a program, a launch.json configuration or a preset")
  })

  test("launch.json: JSONC, named configurations, preLaunchTask is noted, unsupported types refused", async () => {
    const directory = await project(`{
      // comments and trailing commas are fine
      "configurations": [
        { "name": "run", "type": "python", "request": "launch", "program": "\${workspaceFolder}/main.py", "preLaunchTask": "build", },
        { "name": "node", "type": "node", "request": "launch", "program": "x.js" },
      ],
    }`)
    const run = await ok({ configuration: "run", args: ["x"] }, directory)
    expect(run).toMatchObject({
      adapter: "debugpy",
      name: "run",
      program: path.join(directory, "main.py"),
      arguments: { args: ["x"], program: path.join(directory, "main.py") },
      notes: ['preLaunchTask "build" was not run'],
    })
    const node = await fail({ configuration: "node" }, directory)
    expect(node).toContain('type "node" is not supported')
    const missing = await fail({ configuration: "nope" }, directory)
    expect(missing).toBe('no configuration named "nope" (have: run, node)')
  })

  test("attach: debugpy only by port on 127.0.0.1, lldb-dap by pid", async () => {
    const debugpy = await Effect.runPromise(
      DebugLaunch.attach({ adapter: "debugpy", port: 5678 }, { directory: "/repo" }),
    )
    expect(debugpy.arguments).toMatchObject({ request: "attach", connect: { host: "127.0.0.1", port: 5678 } })
    const pid = await Effect.runPromise(
      DebugLaunch.attach({ adapter: "debugpy", pid: 42 }, { directory: "/repo" }).pipe(Effect.flip),
    )
    expect(pid.message).toContain("python -m debugpy --listen 127.0.0.1:PORT")
    const lldb = await Effect.runPromise(DebugLaunch.attach({ adapter: "lldb-dap", pid: 42 }, { directory: "/repo" }))
    expect(lldb).toMatchObject({ request: "attach", arguments: { pid: 42 } })
  })
})

describe("debugpy interpreter selection", () => {
  test("Apple's Pythons are recognized by path", () => {
    expect(Debugpy.apple("/usr/bin/python3")).toBe(true)
    expect(Debugpy.apple("/Applications/Xcode.app/Contents/Developer/usr/bin/python3")).toBe(true)
    expect(Debugpy.apple("/Applications/Xcode-beta.app/Contents/Developer/usr/bin/python3")).toBe(true)
    expect(Debugpy.apple("/Library/Developer/CommandLineTools/usr/bin/python3")).toBe(true)
    expect(Debugpy.apple("/System/Library/Frameworks/Python.framework/Versions/2.7/bin/python")).toBe(true)
    expect(Debugpy.apple("/opt/homebrew/bin/python3")).toBe(false)
    expect(Debugpy.apple("/repo/.venv/bin/python")).toBe(false)
  })

  test("order: launch.json python, project venvs, Homebrew, then PATH; never an Apple Python", async () => {
    const directory = await project()
    const list = Debugpy.candidates(directory, "/custom/python")
    expect(list.slice(0, 3)).toEqual([
      "/custom/python",
      path.join(directory, ".venv", "bin", "python"),
      path.join(directory, "venv", "bin", "python"),
    ])
    expect(list.indexOf("/opt/homebrew/bin/python3")).toBeLessThan(
      list.indexOf("/usr/bin/python3") === -1 ? Infinity : list.indexOf("/usr/bin/python3"),
    )
    // A project venv that points at Apple's Python is skipped without being run.
    await fs.mkdir(path.join(directory, ".venv", "bin"), { recursive: true })
    await fs.symlink("/usr/bin/python3", path.join(directory, ".venv", "bin", "python"))
    const chosen = await Debugpy.resolve({ directory })
    if ("error" in chosen) return expect(chosen.error).toContain("not used for debugging")
    expect(chosen.python).not.toBe(path.join(directory, ".venv", "bin", "python"))
    expect(Debugpy.apple(await fs.realpath(chosen.python))).toBe(false)
  })
})
