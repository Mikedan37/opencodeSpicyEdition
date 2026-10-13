// spicy: `opencode serve` stopped by a signal disposes its instances first, so language servers end through LSP
// `shutdown` and `exit` instead of being orphaned. An orphaned clangd aborts on its own exit once its pipes are gone,
// which leaves a crash report in ~/Library/Logs/DiagnosticReports.
import { describe, expect } from "bun:test"
import { execFileSync } from "child_process"
import { readdirSync } from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { which } from "@opencode-ai/core/util/which"
import { cliIt, withCliFixture } from "../../lib/cli-process"
import { it } from "../../lib/effect"

const fake = path.join(__dirname, "../../fixture/workbench/lsp-nav.js")
const reports = path.join(os.homedir(), "Library/Logs/DiagnosticReports")
const clangdReports = () => {
  try {
    return new Set(readdirSync(reports).filter((name) => name.startsWith("clangd")))
  } catch {
    return new Set<string>()
  }
}
// The server's language server children by name (pgrep exits 1 when there are none).
const children = (pid: number, name: string) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid), name], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const hover = (url: string, directory: string, file: string) =>
  Effect.promise(() =>
    fetch(`${url}/workbench/lsp/hover?${new URLSearchParams({ path: file, line: "0", character: "1", directory })}`),
  )

describe("opencode serve stopped by a signal", () => {
  cliIt.live(
    "SIGTERM disposes the instances: the language server gets shutdown and exit, then the server ends",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const dir = path.join(home, "project")
        const log = path.join(dir, "lsp.log")
        yield* Effect.promise(() => Bun.write(path.join(dir, "a.nav"), "def thing\n"))
        const server = yield* opencode.serve({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              lsp: { nav: { command: [process.execPath, fake], extensions: [".nav"], env: { FAKE_LSP_LOG: log } } },
            }),
          },
        })
        expect((yield* hover(server.url, dir, "a.nav")).status).toBe(200)
        expect(yield* Effect.promise(() => Bun.file(log).text())).toContain("initialize")

        server.kill()
        yield* Effect.promise(() => server.exited)
        const methods = (yield* Effect.promise(() => Bun.file(log).text())).split("\n")
        expect(methods.slice(-3)).toEqual(["shutdown", "exit", ""])
      }),
    60_000,
  )

  const real = which("clangd") && process.platform === "darwin" ? it.live : it.live.skip
  real(
    `[clangd] SIGTERM stops clangd cleanly: no crash report${which("clangd") ? "" : " (skipped: clangd is not on PATH)"}`,
    () =>
      withCliFixture(({ opencode, home }) =>
        Effect.gen(function* () {
          const dir = path.join(home, "project")
          yield* Effect.promise(() => Bun.write(path.join(dir, "main.c"), "int main(void) { return 0; }\n"))
          const before = clangdReports()
          const server = yield* opencode.serve({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ lsp: true }) } })
          expect((yield* hover(server.url, dir, "main.c")).status).toBe(200)
          const clangd = children(server.pid, "clangd")
          expect(clangd).toHaveLength(1)

          server.kill()
          yield* Effect.promise(() => server.exited)
          expect(alive(clangd[0])).toBe(false)
          // A crash report lands a moment after the crash; give it time to show up.
          yield* Effect.sleep("3 seconds")
          expect([...clangdReports()].filter((name) => !before.has(name))).toEqual([])
        }),
      ),
    60_000,
  )
})
