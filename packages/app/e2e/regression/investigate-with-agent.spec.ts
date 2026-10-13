import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stopSnapshot } from "../../src/workbench/snapshot"
import { createProject, fakeModel, startServer } from "../utils/opencode-server"

// UI-07 on a real opencode server (isolated XDG dirs) with real debugpy: the program stops on its uncaught exception,
// "Investigate with agent" → This session sends the stop's snapshot, and the session stores exactly that text as the
// user's message, which the scripted model then answers. Run with PLAYWRIGHT_SERVER_PORT set to a free port.

const AVG = [
  "import os, threading",
  "",
  "# Never wait forever if the test stops early.",
  "threading.Timer(60, lambda: os._exit(3)).start()",
  "",
  "",
  "def average(xs):",
  "    return sum(xs) / len(xs)",
  "",
  "",
  "print(average([]))",
  "",
].join("\n")

type Message = { info: { role: string }; parts: { type: string; text?: string }[] }

test.use({ viewport: { width: 1440, height: 900 } })

test("UI-07 Investigate with agent sends the real stop to this session", async ({ page }, info) => {
  test.setTimeout(180_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-handoff-e2e-")))
  const project = path.join(root, "project")
  const model = await fakeModel([{ text: "Looking into the division." }], "Investigate")
  await createProject(project, model.url)
  await fs.writeFile(path.join(project, "avg.py"), AVG)
  const server = await startServer(root)
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, init)
  const post = (route: string, body: unknown) =>
    api(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  let debugID = ""
  try {
    const session = (await (await post("/session", {})).json()) as { id: string }
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible({ timeout: 30_000 })

    // The user debugs the program; its uncaught exception stops it and brings avg.py forward.
    const started = await post("/workbench/debug/sessions", { program: "avg.py" })
    expect(started.status).toBe(200)
    debugID = ((await started.json()) as { id: string }).id
    const panel = page.locator("#review-panel")
    await expect(panel.getByRole("tab", { name: "avg.py" })).toHaveAttribute("data-selected", "", { timeout: 60_000 })
    await panel.locator('[data-workbench-side-tab="debug"]').click()
    const debug = panel.locator('[data-component="workbench-debug"]')
    await expect(debug.locator('[data-slot="debug-status"]')).toContainText("ZeroDivisionError")

    await debug.locator('[data-action="handoff"]').click()
    await page.locator('[data-handoff-menu] [data-target="session"]').click()
    await expect(page.getByText("Sent to this session", { exact: true })).toBeVisible()

    // Exactly the snapshot of the stop the server reports, stored as the user's message.
    const stopped = ((await (await api("/workbench/debug/sessions")).json()) as Workbench.DebugSessionInfo[]).find(
      (item) => item.id === debugID,
    )!
    const expected = stopSnapshot({ root: project, session: stopped })
    expect(expected).toContain("Exception: ZeroDivisionError: division by zero")
    expect(expected).toContain("1. average at avg.py:8")
    expect(expected).toContain("- xs: list = []")
    // debugpy's value-less "special variables" group stays out.
    expect(expected).not.toContain("special variables")
    const userTexts = async () =>
      ((await (await api(`/session/${session.id}/message`)).json()) as Message[])
        .filter((message) => message.info.role === "user")
        .map((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))
    await expect.poll(userTexts, { timeout: 30_000 }).toEqual([expected])
    // The model answered it; nothing was approved on its behalf.
    await expect.poll(() => model.remaining(), { timeout: 30_000 }).toBe(0)
    await expect(page.getByText("Looking into the division.")).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: info.outputPath("investigate-real.png") })
  } finally {
    if (debugID) await api(`/workbench/debug/sessions/${debugID}`, { method: "DELETE" }).catch(() => undefined)
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
