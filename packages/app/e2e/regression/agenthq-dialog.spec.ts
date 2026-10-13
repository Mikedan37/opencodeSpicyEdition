import { expect, test } from "@playwright/test"
import { mockWorkbench } from "../utils/workbench-mock"

// UX audit #14: the agent dialog has no dead ends: no custom ACP agent without a launch command, the composer's model
// picker, readable provider reasons, and avatars and colours as radio groups (one tab stop each).
test.use({ viewport: { width: 1280, height: 860 } })

const capabilities = {
  streaming: true,
  toolEvents: true,
  permissionRequests: true,
  cancel: true,
  resume: true,
  models: true,
  mcpTools: true,
}
const provider = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
  id,
  name,
  available: true,
  auth: "ok",
  capabilities,
  ...patch,
})

test("the agent dialog: providers, the composer's model picker, radio groups", async ({ page }) => {
  const { mock, open } = await mockWorkbench(page, { directory: "/work/agent-dialog", title: "Agent dialog" })
  mock.providers = [
    provider("opencode", "OpenCode", { version: "0.0.0-spicy-desktop-202610130159" }),
    provider("claude-code", "Claude Code", { version: "2.0.14" }),
    provider("codex", "Codex", {
      available: false,
      auth: "required",
      reason: "Codex is not logged in; run `codex login`",
    }),
    provider("acp", "Custom ACP agent", { capabilities: { ...capabilities, models: false } }),
  ]
  await open()
  await page.keyboard.press("Control+Backquote")
  await page.locator('[data-workbench-tab="agents"]').click()
  await page.locator('[data-action="agenthq-new"]').first().click()
  const dialog = page.locator('[data-component="agenthq-dialog"]')
  await expect(dialog).toBeVisible()

  // No custom ACP agent; no development build version; the reason's command reads as code
  await expect(dialog.locator("[data-provider]")).toHaveCount(3)
  await expect(dialog.locator('[data-provider="acp"]')).toHaveCount(0)
  await expect(dialog.locator('[data-provider="opencode"]')).toHaveText("OpenCode")
  await expect(dialog.locator('[data-provider="claude-code"]')).toContainText("2.0.14")
  await expect(dialog.locator('[data-provider="codex"] code')).toHaveText("codex login")
  await expect(dialog.locator('[data-provider="codex"]')).not.toContainText("`")

  // Name → avatars (one stop, arrows inside) → emoji → colours (one stop) → provider
  await dialog.getByRole("textbox", { name: "Name" }).fill("Ada")
  await page.keyboard.press("Tab")
  await expect(dialog.getByRole("radio", { name: "Fox" })).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(dialog.getByRole("radio", { name: "Octopus" })).toBeChecked()
  await page.keyboard.press("Tab")
  await expect(dialog.getByRole("textbox", { name: "Emoji" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(dialog.getByRole("radio", { name: "Use orange" })).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Tab")
  await expect(dialog.getByRole("radio", { name: /OpenCode/ })).toBeFocused()

  // OpenCode agents pick their model with the composer's picker
  const model = dialog.locator('[data-action="agent-model"]')
  await expect(model).toHaveText("Provider default")
  await model.click()
  await page.locator('[data-option-key="opencode:test"]').click()
  await expect(model).toHaveText("Test")
  await page.screenshot({ path: test.info().outputPath("ux14-agent-dialog.png") })
  await dialog.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => mock.created.length).toBe(1)
  expect(mock.created[0]).toMatchObject({
    name: "Ada",
    provider: "opencode",
    model: "opencode/test",
    avatar: { kind: "preset", value: "octopus" },
  })
  expect((mock.created[0] as { avatar: { color: string } }).avatar.color).not.toBe("orange")
})
