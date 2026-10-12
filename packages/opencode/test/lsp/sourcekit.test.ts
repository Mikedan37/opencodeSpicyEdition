import { expect, test } from "bun:test"
import path from "path"
import { spawnSync } from "child_process"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import { spawn } from "@/lsp/launch"

// spicy: REG-01 against the real sourcekit-lsp. A fresh environment variable makes SwiftPM miss its manifest
// cache (it keys on the environment, which is why every opencode process, with its own OPENCODE_PID, hit this),
// so the first pull is answered empty and the diagnostics only arrive after workspace/diagnostic/refresh.
const found =
  process.platform === "darwin" ? spawnSync("xcrun", ["-f", "sourcekit-lsp"], { encoding: "utf8" }) : undefined
const sourcekit = found?.status === 0 ? found.stdout.trim() : undefined
const skip = sourcekit
  ? undefined
  : "skipped: `xcrun -f sourcekit-lsp` failed (needs macOS with Xcode or a Swift toolchain)"

test.skipIf(!sourcekit)(
  `sourcekit-lsp reports a Swift type error on first open${skip ? ` (${skip})` : ""}`,
  async () => {
    await using tmp = await tmpdir()
    await Bun.write(
      path.join(tmp.path, "Package.swift"),
      `// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Demo", targets: [.executableTarget(name: "Demo", path: "Sources/Demo")])\n`,
    )
    const file = path.join(tmp.path, "Sources", "Demo", "main.swift")
    await Bun.write(file, 'let count: Int = "three"\nprint(count)\n')

    const diagnostics = await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "sourcekit-lsp",
          server: {
            process: spawn(sourcekit!, [], {
              cwd: tmp.path,
              env: { ...process.env, SPICY_SOURCEKIT_TEST_NONCE: `${Date.now()}-${Math.random()}` },
            }),
          },
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })
        const version = await client.notify.open({ path: file })
        await client.waitForDiagnostics({ path: file, version, mode: "document" })
        const result = client.diagnostics.get(file) ?? []
        await client.shutdown()
        return result
      },
    })

    expect(diagnostics.map((item) => [item.severity, item.message, item.range.start.line])).toContainEqual([
      1,
      "Cannot convert value of type 'String' to specified type 'Int'",
      0,
    ])
  },
  30_000,
)
