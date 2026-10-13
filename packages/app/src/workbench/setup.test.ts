import { describe, expect, test } from "bun:test"
import { fixCommand } from "./setup"

describe("IDE setup", () => {
  test("a missing tool gets its install command; the doctor's own command wins; a ready tool needs none", () => {
    expect(fixCommand({ area: "lsp", tool: "pyright", status: "missing" })).toBe("npm install -g pyright")
    expect(
      fixCommand({
        area: "debug",
        tool: "lldb-dap",
        status: "blocked",
        reason:
          "Developer Mode is off: launching under lldb asks for an admin password (sudo DevToolsSecurity -enable)",
      }),
    ).toBe("sudo DevToolsSecurity -enable")
    expect(fixCommand({ area: "test", tool: "pytest", status: "broken", reason: "exit code 1" })).toBe(
      "pip install pytest",
    )
    expect(fixCommand({ area: "check", tool: "tsc", status: "ok", version: "5.8.2" })).toBeUndefined()
    expect(fixCommand({ area: "check", tool: "unknown", status: "missing" })).toBeUndefined()
  })
})
