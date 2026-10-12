// spicy: the v1 sidecar's OPENCODE_BIN_PATH (Agent HQ's Workbench MCP bridge re-runs the bundled CLI).
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundledCli, bundledCliEnv, executableName } from "./bundled-cli"

describe("bundledCliEnv", () => {
  test("a packaged app points OPENCODE_BIN_PATH at the CLI in its resources, only when it exists", async () => {
    const resources = await mkdtemp(join(tmpdir(), "opencode-resources-"))
    try {
      expect(bundledCliEnv(true, resources)).toEqual({})
      const cli = join(resources, executableName())
      await writeFile(cli, "")
      expect(bundledCliEnv(true, resources)).toEqual({ OPENCODE_BIN_PATH: cli })
    } finally {
      await rm(resources, { recursive: true, force: true })
    }
  })

  test("in development the CLI is looked up in this tree's resources", () => {
    expect(bundledCli(false, "/unused")).toBe(join(import.meta.dir, "../../resources", executableName()))
  })
})
