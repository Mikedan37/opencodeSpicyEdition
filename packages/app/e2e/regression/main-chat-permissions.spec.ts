import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, fakeModel, startServer } from "../utils/opencode-server"

// The main chat asks before it edits, on a real opencode server (isolated XDG dirs) with a scripted model: the build
// agent's write waits in the permission dock and lands only after Allow. The composer's chip turns on auto-approve for
// the session (after a confirmation), and the next edit and a shell command run without asking; a new session asks
// again. Run with PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there.

test.use({ viewport: { width: 1280, height: 800 } })

test("main chat: an edit asks in the dock; with auto-approve on, edits and bash run without asking", async ({
  page,
}, info) => {
  test.setTimeout(240_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-permissions-e2e-")))
  const project = path.join(root, "project")
  const model = await fakeModel(
    [
      { tool: "write", args: { filePath: "a.txt", content: "one\n" } },
      { text: "Wrote a.txt." },
      { tool: "write", args: { filePath: "a.txt", content: "two\n" } },
      { tool: "bash", args: { command: "printf ran > b.txt", description: "Write b.txt" } },
      { text: "Done." },
    ],
    "Permissions",
  )
  await createProject(project, model.url)
  const server = await startServer(root)
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, init)
  const send = (method: string, route: string, body: unknown) =>
    api(route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const read = (name: string) => fs.readFile(path.join(project, name), "utf8").catch(() => undefined)
  const turn = (sessionID: string, text: string) =>
    send("POST", `/session/${sessionID}/prompt_async`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text }],
    })
  const idle = (sessionID: string) =>
    expect
      .poll(async () => {
        const status = (await (await api("/session/status")).json()) as Record<string, { type: string }>
        return status[sessionID]?.type ?? "idle"
      })
      .toBe("idle")
  // The composer's chip turns both switches on and off together.
  const switchOn = async (sessionID: string) => {
    const value = (await (await api(`/workbench/sessions/${sessionID}/auto-approve`)).json()) as {
      edits: boolean
      commands: boolean
    }
    return value.edits && value.commands
  }
  try {
    const session = (await (await send("POST", "/session", {})).json()) as { id: string }
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible({ timeout: 30_000 })
    const chip = page.locator('[data-action="prompt-auto-approve"]')
    await expect(chip).toHaveAttribute("data-state", "off")
    await expect(chip).toHaveText("Asks before edits")

    // The edit asks: the dock shows it, and the file is written only after Allow once.
    expect((await turn(session.id, "Write a.txt")).status).toBe(204)
    const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
    await expect(dock).toBeVisible({ timeout: 30_000 })
    await expect(dock.getByText("a.txt")).toBeVisible()
    // "Always" is remembered for this session only, and the button says so.
    await expect(dock.getByRole("button", { name: "Always allow in this session" })).toBeVisible()
    expect(await read("a.txt")).toBeUndefined()
    await page.screenshot({ path: info.outputPath("permission-dock.png") })
    await dock.getByRole("button", { name: "Allow once" }).click()
    await expect.poll(() => read("a.txt")).toBe("one\n")
    await idle(session.id)
    await expect(dock).toBeHidden()

    // Turning auto-approve on asks first; Cancel leaves it off.
    await chip.click()
    await page.locator('[data-choice="cancel"]').click()
    await expect(chip).toHaveAttribute("data-state", "off")
    expect(await switchOn(session.id)).toBe(false)
    await chip.click()
    await page.locator('[data-choice="auto-approve"]').click()
    await expect(chip).toHaveAttribute("data-state", "on")
    await expect(chip).toHaveText("Auto-approving this session")
    expect(await switchOn(session.id)).toBe(true)
    await page.screenshot({ path: info.outputPath("auto-approve-on.png") })

    // The next edit and a shell command run without asking.
    expect((await turn(session.id, "Write a.txt again and run a command")).status).toBe(204)
    await expect.poll(() => read("b.txt"), { timeout: 30_000 }).toBe("ran")
    await idle(session.id)
    expect(await read("a.txt")).toBe("two\n")
    expect(model.remaining()).toBe(0)
    const pending = (await (await api("/permission")).json()) as { sessionID: string }[]
    expect(pending.filter((item) => item.sessionID === session.id)).toEqual([])
    await expect(dock).toBeHidden()

    // Turning it off needs no confirmation, and a new session starts asking.
    await chip.click()
    await expect(chip).toHaveAttribute("data-state", "off")
    expect(await switchOn(session.id)).toBe(false)
    const next = (await (await send("POST", "/session", {})).json()) as { id: string }
    await page.goto(`/server/${base64Encode(server.url)}/session/${next.id}`)
    await expect(page.locator('[data-action="prompt-auto-approve"]')).toHaveAttribute("data-state", "off", {
      timeout: 30_000,
    })
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
