import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, startServer } from "../utils/opencode-server"

// Project search and replace against a real opencode server (isolated XDG dirs): Ctrl+Shift+F opens the side panel's
// Search tab from the composer, a search finds matches across files, the regex toggle changes what matches, a click
// opens the file at its line, Replace all asks first and the files on disk match, a file changed between the search
// and the replace is refused (409) and reported, and a file with unsaved edits in the editor is skipped. Run with
// PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there, so the app's default server is this one.

const FILES = {
  "src/alpha.ts": "export const alpha = 1\nexport function useAlpha() {\n  return alpha + 1\n}\n",
  "src/beta.ts": 'import { alpha } from "./alpha"\nexport const beta = alpha * 2\n',
  "docs/notes.md": "Alpha notes\n",
  "gamma.txt": "alpha1 alpha22\n",
}

test.use({ viewport: { width: 1400, height: 900 } })

test("search: find across files, regex, open at the line, replace all, 409 and unsaved files skipped", async ({
  page,
}, info) => {
  test.setTimeout(180_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-search-e2e-")))
  const project = path.join(root, "project")
  await createProject(project)
  for (const [name, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(project, name)), { recursive: true })
    await fs.writeFile(path.join(project, name), text)
  }
  const server = await startServer(root)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  const disk = (name: string) => fs.readFile(path.join(project, name), "utf8")
  try {
    const session = (await (
      await fetch(`${server.url}/session?directory=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string }
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)

    // From the composer, with the side panel closed. The emulated "Desktop Chrome" device reports Win32: Mod is Ctrl.
    const composer = page.locator('[data-component="prompt-input"]')
    await composer.click()
    await expect(composer).toBeFocused()
    await expect(page.getByRole("tab", { name: "Search" })).toHaveCount(0)
    await page.keyboard.press("Control+Shift+KeyF")
    const panel = page.locator('[data-component="workbench-search-side"]')
    const query = panel.getByRole("textbox", { name: "Search", exact: true })
    await expect(query).toBeFocused()
    await expect(page.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true")

    // Literal and ignoring case: "Alpha" counts, files come in path order with their match counts.
    await query.fill("alpha")
    const summary = panel.locator('[data-slot="search-summary"]')
    await expect(summary).toHaveText("9 matches in 4 files")
    await expect
      .poll(() => listed(page))
      .toEqual([
        ["docs/notes.md", "1"],
        ["gamma.txt", "2"],
        ["src/alpha.ts", "3"],
        ["src/beta.ts", "3"],
      ])
    await expect(matchRow(page, "src/alpha.ts", 2).locator('[data-slot="search-hit"]')).toHaveText("Alpha")
    await shot("1-results")

    // A regular expression only with the toggle on.
    await query.fill("alpha\\d+")
    await expect(panel.getByText("No results")).toBeVisible()
    await panel.locator('[data-option="regex"]').click()
    await expect(summary).toHaveText("2 matches in 1 file")
    await expect(panel.locator('[data-component="search-match"] [data-slot="search-hit"]')).toHaveText([
      "alpha1",
      "alpha22",
    ])
    await shot("2-regex")
    await panel.locator('[data-option="regex"]').click()

    // A click opens the file in the editor at the line.
    await query.fill("useAlpha")
    await expect(summary).toHaveText("1 match in 1 file")
    await matchRow(page, "src/alpha.ts", 2)
      .getByRole("button", { name: /useAlpha/ })
      .click()
    await expect(panel).toHaveCount(0)
    const editor = page.locator('[data-component="workbench-editor"][data-path="src/alpha.ts"]')
    await expect(editor.locator(".cm-line.cm-spicy-selected")).toHaveText(["export function useAlpha() {"])
    await shot("3-opened-at-line")

    // Unsaved edits in that file: typed, not saved.
    await editor.locator(".cm-line").nth(1).click()
    await page.keyboard.press("End")
    await page.keyboard.type(" // mine")
    await expect(page.locator('[data-slot="tab-unsaved"]')).toHaveCount(1)

    // Ctrl+Shift+F from the editor brings the search back as it was.
    await page.keyboard.press("Control+Shift+KeyF")
    await expect(query).toBeFocused()
    await expect(query).toHaveValue("useAlpha")
    await query.fill("alpha")
    await expect(summary).toHaveText("9 matches in 4 files")
    await expect(fileRow(page, "src/alpha.ts").locator('[data-slot="search-unsaved"]')).toBeVisible()

    // A file changed on disk after the search: its replace is refused.
    await fs.writeFile(path.join(project, "docs/notes.md"), "Alpha notes\nmore\n")

    await panel.locator('[data-action="toggle-replace"]').click()
    await panel.getByRole("textbox", { name: "Replace", exact: true }).fill("omega")
    await expect(matchRow(page, "gamma.txt", 1).locator('[data-slot="search-new"]')).toHaveText(["omega", "omega"])
    await shot("4-replace-preview")

    // Replace all asks first: the unsaved file is not counted.
    await panel.locator('[data-action="replace-all"]').click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toContainText("Replace 6 matches in 3 files?")
    await shot("5-confirm")
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/workbench/file" &&
        response.request().postDataJSON().path === "docs/notes.md",
    )
    await dialog.locator('[data-choice="replace"]').click()
    expect((await refused).status()).toBe(409)

    const report = panel.locator('[data-component="search-report"]')
    await expect(report).toContainText("Replaced 5 matches in 2 files.")
    await expect(report.locator('[data-slot="search-skipped"]')).toHaveCount(2)
    await expect(report.locator('[data-slot="search-skipped"][data-path="src/alpha.ts"]')).toHaveAttribute(
      "data-reason",
      "unsaved",
    )
    await expect(report.locator('[data-slot="search-skipped"][data-path="docs/notes.md"]')).toHaveAttribute(
      "data-reason",
      "changed",
    )
    await shot("6-report")
    expect(await disk("src/beta.ts")).toBe('import { omega } from "./omega"\nexport const beta = omega * 2\n')
    expect(await disk("gamma.txt")).toBe("omega1 omega22\n")
    expect(await disk("docs/notes.md")).toBe("Alpha notes\nmore\n")
    expect(await disk("src/alpha.ts")).toBe(FILES["src/alpha.ts"])
    // The replaced files' matches are gone from the results.
    await expect(summary).toHaveText("4 matches in 2 files")
    await expect
      .poll(() => listed(page))
      .toEqual([
        ["docs/notes.md", "1"],
        ["src/alpha.ts", "3"],
      ])

    // Searching again lists the changed file as it is now; one match is replaced on its own.
    await panel.getByRole("button", { name: "Search again" }).click()
    await expect(matchRow(page, "docs/notes.md", 1)).toHaveCount(1)
    await matchRow(page, "docs/notes.md", 1).hover()
    await expect(matchRow(page, "docs/notes.md", 1).locator('[data-action="replace-match"]')).toBeVisible()
    await shot("7-replace-one")
    await matchRow(page, "docs/notes.md", 1).locator('[data-action="replace-match"]').click()
    await expect.poll(() => disk("docs/notes.md")).toBe("omega notes\nmore\n")
    await expect(report).toContainText("Replaced 1 match in 1 file.")

    await expect(summary).toHaveText("3 matches in 1 file")

    // Another tab hides the search: the unsaved edits are still in the editor, the file on disk is untouched. The
    // Search tab brings the results back as they were.
    await page.getByRole("tab", { name: "alpha.ts" }).click()
    await expect(panel).toHaveCount(0)
    await expect(editor.locator(".cm-line").nth(1)).toHaveText("export function useAlpha() { // mine")
    expect(await disk("src/alpha.ts")).toBe(FILES["src/alpha.ts"])
    await page.getByRole("tab", { name: "Search" }).click()
    await expect(summary).toHaveText("3 matches in 1 file")

    // The command palette has it too.
    await page.getByRole("tab", { name: "alpha.ts" }).click()
    await expect(panel).toHaveCount(0)
    await page.keyboard.press("Control+KeyK")
    await page.getByPlaceholder("Search files, commands, and sessions").fill("Search in files")
    await page.getByRole("option", { name: /Search in files/ }).click()
    await expect(query).toBeFocused()
    await expect(query).toHaveValue("alpha")

    // Past 2,000 matches the rest are counted, not listed: 2,103 in all, one per line.
    await fs.writeFile(path.join(project, "many.txt"), "alpha\n".repeat(2_100))
    await panel.getByRole("button", { name: "Search again" }).click()
    await expect(panel.locator('[data-slot="search-more"]')).toHaveText(
      "103 more matches not shown. Narrow the search to see them.",
    )
    await expect(summary).toContainText("2000 matches in")
    await shot("8-capped")
  } finally {
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The file rows as [path, match count], in order.
const listed = (page: Page) =>
  page
    .locator('[data-component="search-file"]')
    .evaluateAll((rows) =>
      rows.map((row) => [row.getAttribute("data-path"), row.querySelector('[data-slot="search-count"]')?.textContent]),
    )
const fileRow = (page: Page, file: string) => page.locator(`[data-component="search-file"][data-path="${file}"]`)
const matchRow = (page: Page, file: string, line: number) =>
  page.locator(`[data-component="search-match"][data-path="${file}"][data-line="${line}"]`)
