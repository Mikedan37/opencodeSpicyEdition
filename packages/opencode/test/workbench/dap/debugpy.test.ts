// Real debugpy sessions through the Workbench debug service. Skipped, with the reason in the
// title, when no runnable Python with debugpy (installed or VS Code's bundle) exists.
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Debugpy } from "../../../src/workbench/dap/adapters/debugpy"
import { WorkbenchDebug } from "../../../src/workbench/dap/service"
import { DebugSession } from "../../../src/workbench/dap/session"
import { DebugSnapshot } from "../../../src/workbench/dap/snapshot"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(WorkbenchDebug.node))
const found = await Debugpy.resolve({ directory: process.cwd() })
const reason = "error" in found ? found.error : undefined
const real = reason ? it.instance.skip : it.instance
const name = (title: string) => (reason ? `${title} [skipped: ${reason}]` : title)
const agent = { by: "agent" as const, sessionID: "ses_debugpy" }

afterEach(async () => {
  await disposeAllInstances()
})

const AVG = `def average(xs):
    total = sum(xs)
    return total / len(xs)


orders = {"alice": [10, 20], "bob": []}
for name, xs in orders.items():
    print(name, average(xs))
`

const write = (file: string, text: string) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(test.directory, file), text))
    return test.directory
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("debugpy (real)", () => {
  real(
    name("DAP-05/06, CON-02/04: conditional breakpoint, evaluate, completions, exception, output"),
    () =>
      Effect.gen(function* () {
        const directory = yield* write("avg.py", AVG)
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({
          program: "avg.py",
          breakpoints: [{ file: "avg.py", line: 3, condition: "len(xs) == 0" }],
        })
        const { session, result } = yield* debug.start(spec, agent)
        expect(result.outcome).toBe("stopped")
        const stop = result.info.stop!
        expect(stop.reason).toBe("breakpoint")
        expect(stop.frames[0]).toMatchObject({ name: "average", line: 3, file: path.join(directory, "avg.py") })
        expect(stop.locals.map((item) => `${item.name}: ${item.type} = ${item.value}`).toSorted()).toEqual([
          "total: int = 0",
          "xs: list = []",
        ])
        expect(JSON.stringify(stop).length).toBeLessThanOrEqual(DebugSnapshot.LIMITS.bytes)
        // alice's call ran without stopping: the condition held only for bob.
        const stdout = () =>
          session
            .output()
            .filter((row) => row.kind === "stdout")
            .map((row) => row.text)
            .join("")
        yield* pollWithTimeout(
          Effect.sync(() => (stdout() === "alice 15.0\n" ? true : undefined)),
          stdout(),
        )

        const evaluated = yield* session.evaluate({ expression: "len(xs), sum(xs)" }, agent)
        expect(evaluated).toMatchObject({ kind: "result", by: "agent", text: "(0, 0)" })
        const dict = yield* session.evaluate({ expression: "{'n': len(xs), 'orders': orders}" }, agent)
        expect(dict.variablesReference).toBeGreaterThan(0)
        const children = yield* session.variables(dict.variablesReference!, agent)
        expect(children.map((item) => item.name)).toEqual(expect.arrayContaining(["'n'", "'orders'"]))

        const complete = (text: string) =>
          session.completions({ text }, agent).pipe(Effect.map((items) => items.map((item) => item.label)))
        expect(yield* complete("x")).toContain("xs")
        expect(yield* complete("xs.ap")).toContain("append")
        expect(yield* complete("tot")).toContain("total")

        const exception = yield* session.control("continue", agent)
        expect(exception.outcome).toBe("stopped")
        expect(exception.info.stop?.reason).toBe("exception")
        expect(exception.info.stop?.exception).toEqual({ id: "ZeroDivisionError", description: "division by zero" })
        expect(DebugSnapshot.text({ snapshot: exception.info.stop!, directory })).toContain(
          "exception ZeroDivisionError: division by zero",
        )

        const rows = session.output()
        expect(new Set(rows.filter((row) => row.by === "program").map((row) => row.kind))).toEqual(new Set(["stdout"]))
        expect(rows.some((row) => row.text.includes("telemetry") || row.text.includes("ptvsd"))).toBe(false)
        expect(rows.some((row) => row.kind === "exception" && row.text.includes("ZeroDivisionError"))).toBe(true)

        const ended = yield* session.control("continue", agent)
        expect(ended.outcome).toBe("terminated")
        expect(ended.exitCode).toBe(1)
      }),
    60_000,
  )

  real(
    name("DAP-07 step over, into and out update the snapshot"),
    () =>
      Effect.gen(function* () {
        yield* write(
          "steps.py",
          `def inner(x):
    y = x * 2
    return y


def outer(x):
    z = inner(x)
    return z + 1


print(outer(5))
`,
        )
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ program: "steps.py", breakpoints: [{ file: "steps.py", line: 7 }] })
        const { session, result } = yield* debug.start(spec, agent)
        const at = (step: DebugSession.Result) =>
          `${step.info.stop?.frames[0]?.name}:${step.info.stop?.frames[0]?.line}`
        expect(at(result)).toBe("outer:7")
        const into = yield* session.control("stepIn", agent)
        expect(at(into)).toBe("inner:2")
        const over = yield* session.control("next", agent)
        expect(at(over)).toBe("inner:3")
        expect(over.info.stop?.locals.find((item) => item.name === "y")?.value).toBe("10")
        const out = yield* session.control("stepOut", agent)
        expect(out.info.stop?.frames[0]?.name).toBe("outer")
        expect(session.steps).toBe(3)
      }),
    60_000,
  )

  real(
    name("DAP-08 Z-HANG: continue into an endless loop returns paused at the loop"),
    () =>
      Effect.gen(function* () {
        yield* write("hang.py", "n = 0\nwhile True:\n    n += 1\n")
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ program: "hang.py", stopOnEntry: true })
        const { session, result } = yield* debug.start(spec, agent, { limits: { stepWaitMs: 2_000 } })
        expect(result.info.stop?.reason).toBe("entry")
        const step = yield* session.control("continue", agent)
        expect(step.outcome).toBe("stopped")
        expect(step.note).toContain("paused")
        expect(step.info.stop?.reason).toBe("pause")
        expect([2, 3]).toContain(step.info.stop?.frames[0]?.line ?? 0)
      }),
    60_000,
  )

  real(
    name("DAP-13 Z-FORK: stop kills the whole tree, no orphans"),
    () =>
      Effect.gen(function* () {
        yield* write(
          "fork.py",
          `import subprocess
child = subprocess.Popen(["sleep", "60"])
print("child", child.pid, flush=True)
x = 1
`,
        )
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ program: "fork.py", breakpoints: [{ file: "fork.py", line: 4 }] })
        const { session, result } = yield* debug.start(spec, agent)
        expect(result.outcome).toBe("stopped")
        const child = Number(
          /child (\d+)/.exec(
            session
              .output()
              .map((row) => row.text)
              .join(""),
          )?.[1],
        )
        expect(alive(child)).toBe(true)
        const tree = yield* Effect.promise(() => DebugSession.tree(session.processes.map((item) => item.pid)))
        expect(tree).toContain(child)
        yield* session.stop(agent)
        yield* pollWithTimeout(
          Effect.sync(() => (tree.some(alive) ? undefined : true)),
          `still alive: ${tree.filter(alive).join(", ")}`,
          "3 seconds",
        )
      }),
    60_000,
  )

  real(
    name("CON-08 Z-SPAM: output is capped at 256 KB with a truncation row"),
    () =>
      Effect.gen(function* () {
        yield* write(
          "spam.py",
          `import sys
for i in range(160):
    sys.stdout.write(str(i).zfill(4) + "x" * 8000 + "\\n")
    sys.stdout.flush()
print("END", flush=True)
`,
        )
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ program: "spam.py" })
        const { session, result } = yield* debug.start(spec, agent)
        expect(result.outcome).toBe("terminated")
        const rows = session.output()
        expect(rows[0]).toMatchObject({ kind: "system", by: "system" })
        expect(rows[0].text).toContain("256 KB output cap")
        const bytes = rows.slice(1).reduce((sum, row) => sum + Buffer.byteLength(row.text), 0)
        expect(bytes).toBeLessThanOrEqual(256 * 1024)
        expect(rows.some((row) => row.text.includes("END"))).toBe(true)
      }),
    60_000,
  )

  real(
    name("DAP-15 runInTerminal: the program runs in a PTY and output before a crash survives"),
    () =>
      Effect.gen(function* () {
        const directory = yield* write("crash.py", 'import os\nprint("alice 15.0")\nos.abort()\n')
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, ".vscode", "launch.json"),
            `{
  // JSONC with comments and a trailing comma
  "configurations": [
    { "name": "crash", "type": "python", "request": "launch", "program": "\${workspaceFolder}/crash.py", "console": "integratedTerminal", },
  ],
}`,
          ),
        )
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ configuration: "crash" })
        const { session } = yield* debug.start(spec, agent)
        yield* pollWithTimeout(
          Effect.sync(() => (session.output().some((row) => row.text.includes("alice 15.0")) ? true : undefined)),
          "terminal output never arrived",
        )
        expect(session.processes.some((item) => item.command.startsWith("terminal:"))).toBe(true)
      }),
    60_000,
  )

  real(
    name("SEC-03 Z-SECRET: secrets are redacted in snapshots, inspect, evaluate and output"),
    () =>
      Effect.gen(function* () {
        const directory = yield* write(
          "secret.py",
          `import os
api_key = "sk-live-0123456789abcdefghijkl"
aws = os.environ.get("AWS_ACCESS_KEY_ID")
pem = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----"
print("key", api_key, aws, flush=True)
x = 1
`,
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, ".vscode", "launch.json"),
            JSON.stringify({
              configurations: [
                {
                  name: "secret",
                  type: "python",
                  request: "launch",
                  program: "${workspaceFolder}/secret.py",
                  env: { AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP" },
                },
              ],
            }),
          ),
        )
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ configuration: "secret", breakpoints: [{ file: "secret.py", line: 6 }] })
        const { session, result } = yield* debug.start(spec, agent)
        // print() may arrive as several output events, after the stop.
        const printed = () =>
          session
            .output()
            .filter((row) => row.by === "program")
            .map((row) => row.text)
            .join("")
        yield* pollWithTimeout(
          Effect.sync(() => (printed().includes("\n") ? true : undefined)),
          "no program output",
        )
        const inspect = DebugSnapshot.treeText(yield* session.inspect({}, agent))
        const evaluated = yield* session.evaluate({ expression: "api_key + ' ' + aws" }, agent)
        const seen = [
          JSON.stringify(result.info),
          inspect,
          evaluated.text,
          ...session.output().map((row) => row.text),
        ].join("\n")
        expect(seen).not.toContain("sk-live-0123456789")
        expect(seen).not.toContain("AKIAABCDEFGHIJKLMNOP")
        expect(seen).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC")
        expect(result.info.stop?.locals.find((item) => item.name === "api_key")?.value).toBe("[REDACTED]")
        expect(printed()).toBe("key [REDACTED] [REDACTED]\n")
      }),
    60_000,
  )

  real(
    name("python test preset: failing test stops on the exception with the cause in locals"),
    () =>
      Effect.gen(function* () {
        yield* write(
          "test_avg.py",
          `import unittest


def average(xs):
    total = sum(xs)
    return total / len(xs)


class AverageTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(average([]), 0)
`,
        )
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ preset: "python-test", program: "test_avg.py" })
        const { result } = yield* debug.start(spec, agent)
        expect(result.outcome).toBe("stopped")
        expect(result.info.stop?.reason).toBe("exception")
        expect(result.info.stop?.exception?.id).toBe("ZeroDivisionError")
        expect(result.info.stop?.frames[0]?.name).toBe("average")
        expect(result.info.stop?.locals.find((item) => item.name === "xs")?.value).toBe("[]")
      }),
    60_000,
  )
})
