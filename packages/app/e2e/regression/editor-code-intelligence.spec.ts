import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, startServer } from "../utils/opencode-server"

// The IDE editor's code intelligence against a real opencode server and a real clangd (isolated XDG dirs): the hover
// shows a function's signature, Ctrl-click opens its definition in the header, Ctrl+- comes back, Shift+F12 lists the
// references, each a link to its line (without a compilation database clangd only finds references in the open file,
// so they are all in main.c); Shift+Alt+F formats, completion inserts, and F2 renames into a review changeset. The
// server is stopped with SIGTERM, which shuts clangd down cleanly. Skips without clangd. Run with PLAYWRIGHT_SERVER_PORT set to a free
// port: the spec starts its server there, so the app's default server is this one too.

const clangd = (() => {
  try {
    execFileSync("clangd", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

test.use({ viewport: { width: 1280, height: 800 } })

// The middle of the first `word` on a CodeMirror line, in page coordinates.
const wordAt = (line: Locator, word: string) =>
  line.evaluate((element, word) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(word) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + 1)
      range.setEnd(node, index + 2)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    throw new Error(`${word} is not on this line`)
  }, word)

// A git project with language servers on, its server, a session, and the editor's file opener.
async function start(page: Page, files: Record<string, string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-editor-lsp-e2e-")))
  const project = path.join(root, "project")
  await createProject(project)
  // createProject leaves language servers off; this spec needs them.
  const config = path.join(project, "opencode.json")
  await fs.writeFile(config, JSON.stringify({ ...JSON.parse(await fs.readFile(config, "utf8")), lsp: true }))
  await Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(project, name), text)))
  const server = await startServer(root)
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
  return {
    project,
    server,
    session,
    panel,
    open: async (file: string) => {
      await panel.getByRole("button", { name: "Open file" }).click()
      await panel.locator(`[data-slot="file-tree-v2-row"][data-path="${file}"]`).click()
      return panel.locator(`[data-component="workbench-editor"][data-path="${file}"]`)
    },
    stop: async () => {
      await server.stop()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("editor: hover, go to definition, back and references through clangd", async ({ page }, info) => {
  test.skip(!clangd, "clangd is not on PATH")
  test.setTimeout(180_000)
  const app = await start(page, {
    "util.h": "static inline int add(int a, int b) { return a + b; }\n",
    "main.c":
      '#include "util.h"\n\nint twice(int x) { return add(x, x); }\n\nint main(void) {\n  return add(1, 2) + twice(3);\n}\n',
  })
  const panel = app.panel
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  try {
    const main = await app.open("main.c")
    const call = main.locator(".cm-line").nth(5)
    await expect(call).toHaveText("  return add(1, 2) + twice(3);")
    // Hover: clangd's markdown with the signature.
    const add = await wordAt(call, "add")
    await page.mouse.move(add.x, add.y)
    const hover = page.locator("[data-lsp-hover]")
    await expect(hover).toContainText("int add(int a, int b)")
    await shot("1-hover")

    // Ctrl-click (the emulated device reports Win32, so Mod is Ctrl) opens the header on the definition's line.
    await page.keyboard.down("Control")
    await page.mouse.click(add.x, add.y)
    await page.keyboard.up("Control")
    const util = panel.locator('[data-component="workbench-editor"][data-path="util.h"]')
    await expect(util.locator(".cm-activeLine")).toHaveText("static inline int add(int a, int b) { return a + b; }")
    await expect(panel.getByRole("tab", { name: "util.h" })).toHaveAttribute("aria-selected", "true")
    await shot("2-definition")

    // Back to the call.
    await page.keyboard.press("Control+Minus")
    await expect(main.locator(".cm-activeLine")).toHaveText("  return add(1, 2) + twice(3);")
    await expect(panel.getByRole("tab", { name: "main.c" })).toHaveAttribute("aria-selected", "true")

    // Shift+F12 on twice: its definition and its call, each a link to its line.
    const twice = await wordAt(call, "twice")
    await page.mouse.click(twice.x, twice.y)
    await page.keyboard.press("Shift+F12")
    const references = main.locator('[data-slot="editor-references"]')
    await expect(references.locator('[data-slot="editor-reference"]')).toHaveText([
      "main.c:3int twice(int x) { return add(x, x); }",
      "main.c:6return add(1, 2) + twice(3);",
    ])
    await shot("3-references")
    await references.locator('[data-slot="editor-reference"]').first().click()
    await expect(main.locator(".cm-activeLine")).toHaveText("int twice(int x) { return add(x, x); }")
    // Escape closes the list.
    await page.keyboard.press("Escape")
    await expect(references).toHaveCount(0)
  } finally {
    await app.stop()
  }
})

test("editor: format, completion and a rename for review through clangd", async ({ page }, info) => {
  test.skip(!clangd, "clangd is not on PATH")
  test.setTimeout(180_000)
  const saved = "int add(int a, int b) { return a + b; }\n\nint main(void){\n  int x = add(1, 2);\n  return x;\n}\n"
  const app = await start(page, { "main.c": saved })
  const file = path.join(app.project, "main.c")
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  try {
    const main = await app.open("main.c")
    const lines = main.locator(".cm-line")
    const unsaved = app.panel.locator('[data-slot="tab-unsaved"]')
    const note = page.locator("[data-lsp-note]")
    await expect(lines.nth(2)).toHaveText("int main(void){")

    // Shift+Alt+F: clangd's edits, applied unsaved.
    await lines.nth(2).click()
    await page.keyboard.press("Shift+Alt+F")
    await expect(lines.nth(2)).toHaveText("int main(void) {")
    await expect(unsaved).toHaveCount(1)
    // A rename is written to disk, so unsaved edits block it.
    await page.keyboard.press("F2")
    await expect(note).toHaveText("Save your changes before renaming")
    await page.keyboard.press("Control+s")
    await expect(unsaved).toHaveCount(0)

    // Completion of the unsaved text: `ad` offers add, Enter inserts it.
    await lines.nth(3).click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("int total = ad")
    await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("add")
    await shot("4-completion")
    await page.keyboard.press("Enter")
    await expect(lines.nth(4)).toHaveText("  int total = add")
    await page.keyboard.press("Control+s")
    await expect(unsaved).toHaveCount(0)
    const before = await fs.readFile(file, "utf8")

    // F2 on add: the new name goes to disk and waits for review in the session's changeset.
    const add = await wordAt(lines.nth(0), "add")
    await page.mouse.click(add.x, add.y)
    await page.keyboard.press("F2")
    const input = page.locator("[data-lsp-rename]")
    await expect(input).toHaveValue("add")
    await input.fill("sum")
    await shot("5-rename")
    await input.press("Enter")
    await expect(page.getByText("Renamed: the changes are waiting for your review")).toBeVisible()
    await expect.poll(() => fs.readFile(file, "utf8")).toBe(before.replaceAll("add", "sum"))
    const changesets = (await (
      await fetch(`${app.server.url}/review/changesets?directory=${encodeURIComponent(app.project)}`)
    ).json()) as { id: string; files: { path: string; state: string }[] }[]
    expect(
      changesets.find((item) => item.id === `chg_${app.session.id}`)?.files.map((item) => [item.path, item.state]),
    ).toEqual([["main.c", "pending"]])
    // The file's tab shows the rename's hunks to accept or reject; accepting the file brings the editor back.
    const review = app.panel.locator('[data-component="review-file"][data-path="main.c"]')
    await expect(review.locator('[data-component="review-hunk"]')).toHaveCount(2)
    await shot("6-review")
    await review.locator('[data-action="accept-file"]').click()
    await expect(lines.nth(0)).toHaveText("int sum(int a, int b) { return a + b; }")
    await expect(lines.nth(4)).toHaveText("  int total = sum")
  } finally {
    await app.stop()
  }
})
