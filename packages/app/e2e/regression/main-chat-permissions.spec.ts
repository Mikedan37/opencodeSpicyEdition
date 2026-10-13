import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, fakeModel, startServer, type Reply } from "../utils/opencode-server"

// The main chat's approvals on a real opencode server (isolated XDG dirs) with a scripted model: the approval card
// (Allow, Always for the session, Always for the project), the composer's approval mode (Ask, Auto edits, Auto), the
// project's saved approvals in Settings → Permissions, and a turn's undo putting files back on disk. Run with
// PLAYWRIGHT_SERVER_PORT set to a free port (the specs start their servers there) and --workers=1.

test.use({ viewport: { width: 1280, height: 800 } })

async function setup(page: Page, script: Reply[]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-approvals-e2e-")))
  const project = path.join(root, "project")
  const model = await fakeModel(script, "Approvals")
  await createProject(project, model.url)
  const server = await startServer(root)
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, init)
  const send = (method: string, route: string, body?: unknown) =>
    api(route, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const session = async () => ((await (await send("POST", "/session", {})).json()) as { id: string }).id
  const open = async (sessionID: string) => {
    await page.goto(`/server/${base64Encode(server.url)}/session/${sessionID}`)
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible({ timeout: 30_000 })
  }
  const turn = async (sessionID: string, text: string) =>
    expect(
      (
        await send("POST", `/session/${sessionID}/prompt_async`, {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text }],
        })
      ).status,
    ).toBe(204)
  const idle = (sessionID: string) =>
    expect
      .poll(
        async () => {
          const status = (await (await api("/session/status")).json()) as Record<string, { type: string }>
          return status[sessionID]?.type ?? "idle"
        },
        { timeout: 30_000 },
      )
      .toBe("idle")
  const pending = async (sessionID: string) =>
    ((await (await api("/permission")).json()) as { id: string; sessionID: string }[]).filter(
      (item) => item.sessionID === sessionID,
    )
  const read = (name: string) => fs.readFile(path.join(project, name), "utf8").catch(() => undefined)
  const switches = async (sessionID: string) =>
    (await (await api(`/workbench/sessions/${sessionID}/auto-approve`)).json()) as { edits: boolean; commands: boolean }
  const approvals = async () =>
    ((await (await api("/workbench/approvals")).json()) as { rules: { permission: string; pattern: string }[] }).rules
  return {
    project,
    model,
    send,
    session,
    open,
    turn,
    idle,
    pending,
    read,
    switches,
    approvals,
    close: async () => {
      await server.stop()
      await model.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

const card = (page: Page) => page.locator('[data-component="approval-card"]')
const pill = (page: Page) => page.locator('[data-action="prompt-approval-mode"]')

async function pickMode(page: Page, mode: "ask" | "edits" | "auto") {
  await pill(page).click()
  const item = page.locator(`[data-approval-modes] [data-mode="${mode}"]`)
  await item.click()
  // Auto asks once more, inline
  if (mode === "auto") await item.click()
  await expect(page.locator("[data-approval-modes]")).toHaveCount(0)
}

test("the card asks; Allow lets one edit through, Always the session's next commands", async ({ page }) => {
  test.setTimeout(240_000)
  const env = await setup(page, [
    { tool: "write", args: { filePath: "a.txt", content: "one\n" } },
    { text: "Wrote a.txt." },
    { tool: "bash", args: { command: "printf 1 > one.txt", description: "Write one.txt" } },
    { tool: "bash", args: { command: "printf 2 > two.txt", description: "Write two.txt" } },
    { text: "Done." },
  ])
  try {
    const id = await env.session()
    await env.open(id)
    await expect(pill(page)).toHaveAttribute("data-mode", "ask")

    await env.turn(id, "Write a.txt")
    await expect(card(page)).toBeVisible({ timeout: 30_000 })
    await expect(card(page).locator('[data-slot="approval-verb"]')).toHaveText("Edit")
    await expect(card(page).locator('[data-slot="approval-object"]')).toHaveText("a.txt")
    await expect(card(page).locator('[data-slot="approval-diff"]')).toContainText("one")
    await expect(card(page).locator('[data-action="approval-always"]')).toHaveText("Always: all edits")
    expect(await env.read("a.txt")).toBeUndefined()
    await card(page).locator('[data-action="approval-allow"]').click()
    await expect.poll(() => env.read("a.txt")).toBe("one\n")
    await env.idle(id)
    await expect(card(page)).toHaveCount(0)

    // Always (this session) covers the next printf: it runs without asking.
    await env.turn(id, "Write one.txt and two.txt")
    await expect(card(page).locator('[data-slot="approval-object"]')).toHaveText("printf 1 > one.txt", {
      timeout: 30_000,
    })
    await expect(card(page).locator('[data-action="approval-always"]')).toHaveText("Always: printf …")
    await card(page).locator('[data-action="approval-always"]').click()
    await expect.poll(() => env.read("two.txt"), { timeout: 30_000 }).toBe("2")
    await env.idle(id)
    expect(await env.read("one.txt")).toBe("1")
    expect(env.model.remaining()).toBe(0)
    expect(await env.pending(id)).toEqual([])
    expect(await env.approvals()).toEqual([])
  } finally {
    await env.close()
  }
})

test("Auto edits lets an edit through while a command asks; Auto runs both; a new session asks", async ({ page }) => {
  test.setTimeout(240_000)
  const env = await setup(page, [
    { tool: "write", args: { filePath: "a.txt", content: "two\n" } },
    { tool: "bash", args: { command: "printf ran > b.txt", description: "Write b.txt" } },
    { text: "Done." },
    { tool: "bash", args: { command: "printf again > c.txt", description: "Write c.txt" } },
    { text: "Done again." },
  ])
  try {
    const id = await env.session()
    await env.open(id)
    await pickMode(page, "edits")
    await expect(pill(page)).toHaveAttribute("data-mode", "edits")
    expect(await env.switches(id)).toEqual({ edits: true, commands: false })

    await env.turn(id, "Write a.txt and run a command")
    // The edit went through; the command waits on the card.
    await expect(card(page).locator('[data-slot="approval-verb"]')).toHaveText("Run", { timeout: 30_000 })
    expect(await env.read("a.txt")).toBe("two\n")
    expect(await env.read("b.txt")).toBeUndefined()
    await page.screenshot({ path: test.info().outputPath("auto-edits-command-asks.png") })
    await card(page).locator('[data-action="approval-allow"]').click()
    await expect.poll(() => env.read("b.txt"), { timeout: 30_000 }).toBe("ran")
    await env.idle(id)

    await pickMode(page, "auto")
    await expect(pill(page)).toHaveAttribute("data-mode", "auto")
    expect(await env.switches(id)).toEqual({ edits: true, commands: true })
    await env.turn(id, "Run another command")
    await expect.poll(() => env.read("c.txt"), { timeout: 30_000 }).toBe("again")
    await env.idle(id)
    expect(env.model.remaining()).toBe(0)
    await expect(card(page)).toHaveCount(0)

    const next = await env.session()
    await env.open(next)
    await expect(pill(page)).toHaveAttribute("data-mode", "ask", { timeout: 30_000 })
    expect(await env.switches(next)).toEqual({ edits: false, commands: false })
  } finally {
    await env.close()
  }
})

test("Always ▾ This project saves the rule; Settings → Permissions lists it and × removes it", async ({ page }) => {
  test.setTimeout(240_000)
  const env = await setup(page, [
    { tool: "bash", args: { command: "touch saved.txt", description: "Touch saved.txt" } },
    { text: "Done." },
  ])
  try {
    const id = await env.session()
    await env.open(id)
    await env.turn(id, "Touch a file")
    await expect(card(page).locator('[data-action="approval-always"]')).toHaveText("Always: touch …", {
      timeout: 30_000,
    })
    await card(page).locator('[data-action="approval-always-menu"]').click()
    await page.locator('[data-approval-menu] [data-choice="project"]').click()
    await expect.poll(() => env.read("saved.txt"), { timeout: 30_000 }).toBe("")
    await env.idle(id)
    expect(await env.approvals()).toEqual([{ permission: "bash", pattern: "touch *" }])

    await page.keyboard.press("Control+,")
    const dialog = page.locator(".settings-v2-dialog")
    await dialog.getByRole("tab", { name: "Permissions" }).click()
    const list = dialog.locator('[data-component="workbench-approvals"]')
    const row = list.locator('[data-rule="bash"]')
    await expect(row).toContainText("Command")
    await expect(row).toContainText("touch …")
    await page.screenshot({ path: test.info().outputPath("settings-permissions.png") })
    await row.getByRole("button", { name: "Remove touch …" }).click()
    await expect(row).toHaveCount(0)
    await expect(list.locator('[data-slot="approvals-empty"]')).toBeVisible()
    expect(await env.approvals()).toEqual([])
  } finally {
    await env.close()
  }
})

// Saved rules reach Permission.ask in the backend's next step; until then this one fails (the second session asks).
test("a rule saved for the project lets the next session's ask through", async ({ page }) => {
  test.setTimeout(240_000)
  const env = await setup(page, [
    { tool: "bash", args: { command: "touch first.txt", description: "Touch first.txt" } },
    { text: "Done." },
    { tool: "bash", args: { command: "touch second.txt", description: "Touch second.txt" } },
    { text: "Done again." },
  ])
  try {
    const first = await env.session()
    await env.open(first)
    await env.turn(first, "Touch a file")
    await expect(card(page)).toBeVisible({ timeout: 30_000 })
    await card(page).locator('[data-action="approval-always-menu"]').click()
    await page.locator('[data-approval-menu] [data-choice="project"]').click()
    await expect.poll(() => env.read("first.txt"), { timeout: 30_000 }).toBe("")
    await env.idle(first)

    const second = await env.session()
    await env.open(second)
    await env.turn(second, "Touch another file")
    await expect.poll(() => env.read("second.txt"), { timeout: 30_000 }).toBe("")
    await env.idle(second)
    await expect(card(page)).toHaveCount(0)
  } finally {
    await env.close()
  }
})

test("a turn's undo puts its files back on disk", async ({ page }) => {
  test.setTimeout(240_000)
  const env = await setup(page, [
    { tool: "write", args: { filePath: "a.txt", content: "one\n" } },
    { text: "Wrote one." },
    { tool: "write", args: { filePath: "a.txt", content: "two\n" } },
    { text: "Wrote two." },
  ])
  try {
    const id = await env.session()
    expect((await env.send("PUT", `/workbench/sessions/${id}/auto-approve`, { edits: true, commands: false })).ok).toBe(
      true,
    )
    await env.open(id)
    await env.turn(id, "Write one")
    await expect.poll(() => env.read("a.txt"), { timeout: 30_000 }).toBe("one\n")
    await env.idle(id)
    await env.turn(id, "Write two")
    await expect.poll(() => env.read("a.txt"), { timeout: 30_000 }).toBe("two\n")
    await env.idle(id)

    // The latest turn shows its undo without hovering; an earlier turn's says how far it goes.
    await expect(page.locator('[data-action="turn-undo"]')).toHaveCount(2, { timeout: 30_000 })
    const latest = page.getByRole("button", { name: "Undo this turn" })
    await expect(latest).toBeVisible()
    await expect(page.getByRole("button", { name: "Undo back to here" })).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath("turn-undo.png") })
    await latest.click()
    await expect.poll(() => env.read("a.txt"), { timeout: 30_000 }).toBe("one\n")
    // Like /undo, the turn's prompt comes back to the composer.
    await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveText("Write two")
  } finally {
    await env.close()
  }
})
