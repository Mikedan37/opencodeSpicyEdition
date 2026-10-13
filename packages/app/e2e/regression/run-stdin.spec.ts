import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, startServer } from "../utils/opencode-server"

// CON-10: what the user types in the Run tab reaches the program. A real opencode server (isolated XDG dirs) debugs a
// Python program with debugpy in an integrated terminal; the Run tab attaches to its PTY over the real WebSocket, the
// test types a line there, and the program echoes it. Run with PLAYWRIGHT_SERVER_PORT set to a free port.

const ECHO = `import os, sys, threading

# Never wait forever if the test stops early.
threading.Timer(60, lambda: os._exit(3)).start()
print("ready for input", flush=True)
line = sys.stdin.readline().strip()
print(f"echo: {line}", flush=True)
os._exit(0)
`

const LAUNCH = {
  version: "0.2.0",
  configurations: [
    {
      name: "Echo in terminal",
      type: "debugpy",
      request: "launch",
      program: "${workspaceFolder}/echo.py",
      console: "integratedTerminal",
    },
  ],
}

test.use({ viewport: { width: 1280, height: 800 } })

test("run tab: typing in the program's terminal reaches the program", async ({ page }, info) => {
  test.setTimeout(180_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-run-e2e-")))
  const project = path.join(root, "project")
  await createProject(project)
  await fs.writeFile(path.join(project, "echo.py"), ECHO)
  await fs.mkdir(path.join(project, ".vscode"))
  await fs.writeFile(path.join(project, ".vscode", "launch.json"), JSON.stringify(LAUNCH))
  const server = await startServer(root)
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, init)
  let debugID = ""
  const printed = async () =>
    ((await (await api(`/workbench/debug/sessions/${debugID}/output`)).json()) as { by: string; text: string }[])
      .filter((row) => row.by === "program")
      .map((row) => row.text)
      .join("")
  try {
    const session = (await (
      await api("/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    ).json()) as { id: string }
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press("Control+Backquote")
    await page.locator('[data-workbench-tab="run"]').click()

    const started = await api("/workbench/debug/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: "Echo in terminal" }),
    })
    expect(started.status).toBe(200)
    debugID = ((await started.json()) as { id: string }).id
    await expect.poll(printed, { timeout: 30_000 }).toContain("ready for input")

    // The Run tab shows the program's terminal; typing there goes over the PTY WebSocket to the program's stdin.
    const run = page.locator('[data-component="workbench-run"]')
    const terminal = run.locator('[data-run-pty] [data-component="terminal"]')
    await expect(terminal).toBeVisible()
    await terminal.click()
    await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.type("hello from the Run tab")
    await page.keyboard.press("Enter")
    await expect.poll(printed, { timeout: 30_000 }).toContain("echo: hello from the Run tab")
    await expect(run.locator('[data-slot="run-status"]')).toHaveText("Exited with code 0", { timeout: 30_000 })
    await page.screenshot({ path: info.outputPath("run-stdin.png") })
  } finally {
    if (debugID) await api(`/workbench/debug/sessions/${debugID}`, { method: "DELETE" }).catch(() => undefined)
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
