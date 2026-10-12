// lldb-dap: only initialize and disconnect are ever sent here. Launching or attaching while macOS
// Developer Mode is off pops an admin password prompt, so launch tests skip until it is on.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Process } from "../../../src/util/process"
import { Lldb } from "../../../src/workbench/dap/adapters/lldb"
import { DapClient } from "../../../src/workbench/dap/client"
import { WorkbenchDebug } from "../../../src/workbench/dap/service"
import { DapTransport } from "../../../src/workbench/dap/transport"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { lldbDap } from "../fixture/dap-profiles"

const found = await Lldb.resolve()
const missing = "error" in found ? found.error : undefined
const developer = await Lldb.developerMode()
const it = testEffect(LayerNode.compile(WorkbenchDebug.node))

afterEach(async () => {
  await disposeAllInstances()
})

describe("lldb-dap (real)", () => {
  test.skipIf(!!missing)(
    `DAP-02 initialize only: capabilities match the captured profile${missing ? ` [skipped: ${missing}]` : ""}`,
    async () => {
      if ("error" in found) return
      const child = Process.spawn(Lldb.command(found.binary), { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      const caps = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* DapClient.make({
            open: (handlers) => DapTransport.stream(child.stdout!, child.stdin!, handlers),
            onEvent: () => {},
            onRequest: async () => ({}),
            onClose: () => {},
          })
          const body = yield* client.request("initialize", {
            clientID: "opencode",
            adapterID: "lldb-dap",
            linesStartAt1: true,
            columnsStartAt1: true,
            pathFormat: "path",
          })
          yield* client.request("disconnect", { terminateDebuggee: true }, 2_000).pipe(Effect.ignore)
          client.close()
          return body
        }).pipe(Effect.ensuring(Effect.sync(() => child.kill("SIGKILL")))),
      )
      const reported = Object.entries(caps)
        .filter((entry) => entry[1] === true)
        .map((entry) => entry[0])
      expect(reported.toSorted()).toEqual(lldbDap.capabilities.toSorted())
      const filters = (caps.exceptionBreakpointFilters as { filter: string; supportsCondition?: boolean }[]).map(
        (item) => item.filter,
      )
      expect(filters.toSorted()).toEqual(lldbDap.filters.toSorted())
    },
    30_000,
  )

  it.instance("launch is refused with a clear message while Developer Mode is off", () =>
    Effect.gen(function* () {
      if (developer) return
      const test = yield* TestInstance
      const debug = yield* WorkbenchDebug.Service
      const spec = yield* debug.prepare({ program: path.join(test.directory, "avg"), adapter: "lldb-dap" })
      const error = yield* debug.start(spec, { by: "agent", sessionID: "ses_lldb" }).pipe(Effect.flip)
      expect(error.kind).toBe("unavailable")
      expect(error.message).toBe("Developer Mode off — run sudo DevToolsSecurity -enable")
      expect(yield* debug.list()).toEqual([])
    }),
  )

  // Only ever runs with Developer Mode on, where launching does not prompt.
  const launch = !developer || missing ? it.instance.skip : it.instance
  launch(
    `DAP-18 lldb-dap launch of a C fixture stops with frames and locals${
      !developer ? " [skipped: Developer Mode off]" : missing ? ` [skipped: ${missing}]` : ""
    }`,
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "avg.c"),
            '#include <stdio.h>\nint main(void) {\n  int n = 0;\n  printf("alice 15\\n");\n  return 10 / n;\n}\n',
          ),
        )
        const built = yield* Effect.promise(() =>
          Process.run(["cc", "-g", "-O0", "-o", "avg", "avg.c"], { cwd: test.directory, nothrow: true }),
        )
        expect(built.code).toBe(0)
        const debug = yield* WorkbenchDebug.Service
        const spec = yield* debug.prepare({ program: "avg", breakpoints: [{ file: "avg.c", line: 5 }] })
        const { result } = yield* debug.start(spec, { by: "agent", sessionID: "ses_lldb" })
        expect(result.info.stop?.frames[0]?.name).toContain("main")
        expect(result.info.stop?.locals.map((item) => item.name)).toContain("n")
      }),
    60_000,
  )
})
