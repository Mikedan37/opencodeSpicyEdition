import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, startServer } from "../utils/opencode-server"

// The IDE editor against a real opencode server (isolated XDG dirs): open a file, edit, save with the keyboard and
// compare the bytes on disk; a save over a file changed on disk is refused (409) until Reload or a confirmed
// Overwrite; closing a tab with unsaved edits asks first. Run with PLAYWRIGHT_SERVER_PORT set to a free port: the
// spec starts its server there, so the app's default server is this one too.

// A trailing newline and a blank first line: the editor saves the file's exact text, not the viewer's trimmed one.
const ORIGINAL = "\nimport sys\n\n\ndef main():\n    return 1\n"

test.use({ viewport: { width: 1280, height: 800 } })

test("editor: edit, save, conflicts on a file changed on disk, and closing with unsaved edits", async ({
  page,
}, info) => {
  test.setTimeout(180_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-editor-e2e-")))
  const project = path.join(root, "project")
  const file = path.join(project, "app.py")
  await createProject(project)
  await fs.writeFile(file, ORIGINAL)
  const server = await startServer(root)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  const disk = () => fs.readFile(file, "utf8")
  try {
    const session = (await (
      await fetch(`${server.url}/session?directory=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string }
    await page.addInitScript(() => {
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ review: { panelOpened: true } }))
    })
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    const panel = page.locator("#review-panel")
    await panel.getByRole("button", { name: "Open file" }).click()
    await panel.locator('[data-slot="file-tree-v2-row"][data-path="app.py"]').click()
    const editor = panel.locator('[data-component="workbench-editor"][data-path="app.py"]')
    const content = editor.locator(".cm-content")
    await expect(content).toBeVisible()
    await expect(editor.locator(".cm-line")).toHaveCount(ORIGINAL.split("\n").length)
    const unsaved = panel.locator('[data-slot="tab-unsaved"]')
    await expect(unsaved).toHaveCount(0)

    // Edit line 2 and save with the keyboard. The emulated "Desktop Chrome" device reports Win32, so Mod is Ctrl.
    await editor.locator(".cm-line").nth(1).click()
    await page.keyboard.press("End")
    await page.keyboard.type(", os")
    await expect(unsaved).toHaveCount(1)
    await shot("1-edited")
    await page.keyboard.press("Control+s")
    await expect(unsaved).toHaveCount(0)
    await expect.poll(disk).toBe(ORIGINAL.replace("import sys", "import sys, os"))
    await shot("2-saved")

    // Typing goes on in the editor after the save.
    await page.keyboard.type("  # saved")
    await expect(unsaved).toHaveCount(1)

    // A reload with an unsaved edit asks first (the browser's leave-page confirmation); staying keeps the edit.
    const asked = page.waitForEvent("dialog")
    const reloading = page.evaluate(() => location.reload()).catch(() => undefined)
    const leave = await asked
    expect(leave.type()).toBe("beforeunload")
    await leave.dismiss()
    await reloading
    await expect(editor.locator(".cm-line").nth(1)).toHaveText("import sys, os  # saved")
    await expect(unsaved).toHaveCount(1)

    // Cmd+S saves the side panel's active file tab with the focus outside the editor (the app's command, not the
    // editor's keymap).
    await panel.getByRole("tab", { name: "app.py" }).click()
    await page.keyboard.press("Control+s")
    await expect(unsaved).toHaveCount(0)
    await expect.poll(disk).toBe(ORIGINAL.replace("import sys", "import sys, os  # saved"))

    // The file changes on disk under an unsaved edit: the save is refused and nothing is written.
    await editor.locator(".cm-line").nth(1).click()
    await page.keyboard.press("End")
    await page.keyboard.type("!")
    await expect(unsaved).toHaveCount(1)
    const theirs = "\nimport json\n"
    await fs.writeFile(file, theirs)
    await page.keyboard.press("Control+s")
    const conflict = editor.locator('[data-slot="editor-conflict"]')
    await expect(conflict).toContainText("changed on disk")
    expect(await disk()).toBe(theirs)
    await shot("3-conflict")

    // Reload from disk: the editor shows the file's text, with nothing unsaved.
    await conflict.getByRole("button", { name: "Reload from disk" }).click()
    await expect(conflict).toHaveCount(0)
    await expect(editor.locator(".cm-line").nth(1)).toHaveText("import json")
    await expect(unsaved).toHaveCount(0)

    // Again, then Overwrite: it asks first, then writes the editor's text over the file.
    await editor.locator(".cm-line").nth(1).click()
    await page.keyboard.press("End")
    await page.keyboard.type(", re")
    await fs.writeFile(file, "\nimport csv\n")
    await page.keyboard.press("Control+s")
    await expect(conflict).toBeVisible()
    await conflict.getByRole("button", { name: "Overwrite" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toContainText("Overwrite app.py?")
    await shot("4-overwrite-asks")
    await dialog.getByRole("button", { name: "Overwrite" }).click()
    await expect.poll(disk).toBe("\nimport json, re\n")
    await expect(conflict).toHaveCount(0)
    await expect(unsaved).toHaveCount(0)

    // Closing the tab with an unsaved edit asks; "Don't save" closes it and leaves the file alone.
    await editor.locator(".cm-line").nth(1).click()
    await page.keyboard.press("End")
    await page.keyboard.type("  # draft")
    await expect(unsaved).toHaveCount(1)
    // A middle click closes the tab the way its close button does.
    await panel.getByRole("tab", { name: "app.py" }).click({ button: "middle" })
    await expect(dialog).toContainText("Save the changes to app.py?")
    await shot("5-close-asks")
    await dialog.getByRole("button", { name: "Don't save" }).click()
    await expect(panel.getByRole("tab", { name: "app.py" })).toHaveCount(0)
    expect(await disk()).toBe("\nimport json, re\n")
  } finally {
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
