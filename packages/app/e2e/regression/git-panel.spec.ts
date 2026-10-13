import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, fakeModel, startServer } from "../utils/opencode-server"

// The git panel against a real opencode server (isolated XDG dirs) in temp repositories. The commit area is a one-line
// bar until "Commit…" expands it (remembered per workspace). One project has no small_model and a local bare
// repository as origin: Generate stays off, a file is staged from its checkbox and committed with Ctrl+Enter, the branch
// is published with --set-upstream after the dialog's confirmation, a new branch is created and switched to, and a
// switch with uncommitted changes is refused with git's reason. In another, a session's agent wrote a file the Agent
// changes review has not decided: the bar says to review first and cannot expand until the review is done; then
// Generate asks the small_model (a scripted stub) for the message. The third runs at the desktop app's 1280×800 with
// the terminal open: while agent hunks are pending, the bar stays collapsed (even after the human had expanded it)
// and every hunk's Accept and Reject can be clicked. No gh, no network.
// Run with PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there.

test.use({ viewport: { width: 1440, height: 900 } })

// The server never looks for OpenCode Native (AgentKit discovery) on this machine, and its terminals never save or
// restore a macOS Terminal shell session (~/.zsh_sessions, ~/.bash_sessions) of the terminal that runs the tests.
async function serve(root: string) {
  const saved = { ...process.env }
  process.env.OPENCODE_AGENTKIT_BRIDGE = path.join(root, "no-agentkit-bridge")
  process.env.SHELL_SESSIONS_DISABLE = "1"
  delete process.env.TERM_SESSION_ID
  delete process.env.TERM_PROGRAM
  return startServer(root).finally(() => {
    for (const key of ["OPENCODE_AGENTKIT_BRIDGE", "SHELL_SESSIONS_DISABLE", "TERM_SESSION_ID", "TERM_PROGRAM"]) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

test("git panel: stage, commit, publish, branch; Generate off without small_model; dirty switch refused", async ({
  page,
}, info) => {
  test.setTimeout(180_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-git-e2e-")))
  const project = path.join(root, "project")
  const origin = path.join(root, "origin.git")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim()
  await createProject(project)
  // createProject configures small_model; this project must not have one. With $schema in place the server leaves
  // the file as it is (it adds a missing one), so the tree stays clean.
  const config = JSON.parse(await fs.readFile(path.join(project, "opencode.json"), "utf8")) as Record<string, unknown>
  delete config.small_model
  await fs.writeFile(
    path.join(project, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
  git("commit", "-q", "-am", "no small model")
  execFileSync("git", ["init", "-q", "--bare", origin])
  git("remote", "add", "origin", origin)
  const main = git("branch", "--show-current")
  await fs.writeFile(path.join(project, "hello.txt"), "hello\n")

  const server = await serve(root)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  try {
    const created = await fetch(`${server.url}/session?directory=${encodeURIComponent(project)}`, json({}))
    const session = (await created.json()) as { id: string }
    await page.addInitScript(() => {
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ review: { panelOpened: true } }))
    })
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)

    const area = page.locator('[data-component="git-commit-area"]')
    await expect(area.locator('[data-slot="git-branch"]')).toHaveText(main, { timeout: 30_000 })
    // A one-line bar by default; "Commit…" expands it and puts the cursor in the message box.
    await expect(area).toHaveAttribute("data-state", "collapsed")
    await expect(area.locator('[data-slot="git-change-count"]')).toHaveText("1 change")
    await area.locator('[data-action="git-expand"]').click()
    await expect(area).toHaveAttribute("data-state", "expanded")
    await expect(area.getByRole("textbox", { name: "Commit message" })).toBeFocused()
    const staged = area.locator('[data-component="git-files"][data-kind="staged"]')
    const changed = area.locator('[data-component="git-files"][data-kind="changes"]')
    await expect(changed.locator('[data-path="hello.txt"]')).toHaveAttribute("data-state", "untracked")
    await expect(staged).toContainText("Nothing staged")
    // No small_model in the config: Generate is off and says why.
    const generate = area.locator('[data-action="git-generate"]')
    await expect(generate).toBeDisabled()
    await expect(generate.locator("..")).toHaveAttribute("title", /small_model/)

    // Stage from the checkbox; Commit waits for a message.
    await area.getByRole("checkbox", { name: "Stage hello.txt" }).check()
    await expect(staged.locator('[data-path="hello.txt"]')).toHaveAttribute("data-state", "added")
    await expect(changed).toContainText("No changes")
    await expect(generate).toBeDisabled()
    const commit = area.locator('[data-action="git-commit"]')
    await expect(commit).toBeDisabled()
    const message = area.getByRole("textbox", { name: "Commit message" })
    await message.fill("Add hello.txt")
    await expect(commit).toBeEnabled()
    await shot("1-staged")

    // Ctrl+Enter commits (the emulated "Desktop Chrome" device reports Win32, so mod is Ctrl).
    await message.press("Control+Enter")
    await expect(staged).toContainText("Nothing staged")
    await expect(message).toHaveValue("")
    await expect.poll(() => git("log", "-1", "--format=%s")).toBe("Add hello.txt")
    expect(git("status", "--porcelain")).toBe("")

    // No upstream yet: the button publishes, and only after the dialog's confirmation.
    const push = area.locator('[data-action="git-push"]')
    await expect(push).toHaveText("Publish branch")
    await push.click()
    const pushDialog = page.locator('[data-component="git-push-dialog"]')
    await expect(pushDialog.locator('[data-slot="git-push-summary"]')).toContainText("--set-upstream")
    await expect(pushDialog.locator('select[name="remote"]')).toHaveValue("origin")
    await shot("2-publish")
    await pushDialog.locator('[data-action="git-push-confirm"]').click()
    await expect(pushDialog).toHaveCount(0)
    await expect(area).toContainText(`origin/${main}`)
    await expect(push).toHaveText("Push")
    expect(execFileSync("git", ["--git-dir", origin, "log", "-1", "--format=%s", main], { encoding: "utf8" })).toBe(
      "Add hello.txt\n",
    )
    expect(git("rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${main}`)

    // A new branch, switched to (the working tree stays as it is).
    await area.locator('[data-action="git-branches"]').click()
    const branchDialog = page.locator('[data-component="git-branch-dialog"]')
    await expect(branchDialog.locator(`[data-branch="${main}"]`)).toBeDisabled()
    await branchDialog.getByRole("textbox", { name: "New branch" }).fill("feature/panel")
    await branchDialog.locator('[data-action="git-branch-create"]').click()
    await expect(branchDialog).toHaveCount(0)
    await expect(area.locator('[data-slot="git-branch"]')).toHaveText("feature/panel")
    expect(git("branch", "--show-current")).toBe("feature/panel")

    // An uncommitted change to a tracked file blocks switching back; git's reason is shown and nothing moves.
    await fs.writeFile(path.join(project, "hello.txt"), "edited\n")
    await area.locator('[data-action="git-refresh"]').click()
    await expect(changed.locator('[data-path="hello.txt"]')).toHaveAttribute("data-state", "modified")
    await area.locator('[data-action="git-branches"]').click()
    await branchDialog.locator(`[data-branch="${main}"]`).click()
    await expect(branchDialog.locator('[data-slot="git-dialog-error"]')).toContainText("uncommitted changes")
    await expect(branchDialog.locator('[data-slot="git-dialog-error"]')).toContainText("hello.txt")
    await shot("3-dirty-switch")
    expect(git("branch", "--show-current")).toBe("feature/panel")
    expect(await fs.readFile(path.join(project, "hello.txt"), "utf8")).toBe("edited\n")

    // Expanded or not is remembered for the workspace.
    await branchDialog.getByRole("button", { name: "Cancel" }).click()
    await page.reload()
    await expect(area).toHaveAttribute("data-state", "expanded", { timeout: 30_000 })
    await area.locator('[data-action="git-collapse"]').click()
    await page.reload()
    await expect(area.locator('[data-slot="git-change-count"]')).toHaveText("1 change", { timeout: 30_000 })
    await expect(area).toHaveAttribute("data-state", "collapsed")
  } finally {
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("git panel: undecided agent changes come first; Generate uses the small_model", async ({ page }, info) => {
  test.setTimeout(180_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-git-agent-e2e-")))
  const project = path.join(root, "project")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim()
  // The session's turn writes agent.txt; requests without tools (titles, the commit message) get "Add agent.txt".
  const model = await fakeModel(
    [{ tool: "write", args: { filePath: "agent.txt", content: "from the agent\n" } }, { text: "Wrote agent.txt." }],
    "Add agent.txt",
  )
  await createProject(project, model.url)
  const server = await serve(root)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}?directory=${encodeURIComponent(project)}`, init)
  try {
    const session = (await (await api("/session", json({}))).json()) as { id: string }
    const prompt = await api(
      `/session/${session.id}/message`,
      json({
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "Write agent.txt" }],
      }),
    )
    expect(prompt.status).toBe(200)
    expect(await fs.readFile(path.join(project, "agent.txt"), "utf8")).toBe("from the agent\n")
    await expect.poll(async () => ((await (await api("/review/changesets")).json()) as unknown[]).length).toBe(1)
    const before = git("rev-parse", "HEAD")

    await page.addInitScript(() => {
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ review: { panelOpened: true } }))
    })
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    const area = page.locator('[data-component="git-commit-area"]')
    const unreviewed = area.locator('[data-slot="git-unreviewed"]')
    await expect(unreviewed).toHaveText("Review agent changes first", { timeout: 30_000 })
    await expect(unreviewed).toHaveAttribute("title", "1 agent change not reviewed yet")
    await expect(area).toHaveAttribute("data-state", "collapsed")
    const expand = area.locator('[data-action="git-expand"]')
    await expect(expand).toBeDisabled()
    await shot("4-review-first")

    // Once the review is decided the area opens.
    const [changeset] = (await (await api("/review/changesets")).json()) as { id: string }[]
    expect((await api(`/review/changesets/${changeset!.id}/all`, json({ action: "accept" }))).status).toBe(200)
    await expect(unreviewed).toHaveCount(0)
    await expand.click()
    await expect(area).toHaveAttribute("data-state", "expanded")

    // Generate is on with a small_model; it writes the message from the staged diff.
    const generate = area.locator('[data-action="git-generate"]')
    await expect(generate).toBeDisabled() // nothing staged yet
    await area.getByRole("checkbox", { name: "Stage agent.txt" }).check()
    await expect(area.locator('[data-kind="staged"] [data-path="agent.txt"]')).toHaveAttribute("data-state", "added")
    await expect(generate).toBeEnabled()
    await expect(generate.locator("..")).toHaveAttribute("title", /test\/test-model/)
    await generate.click()
    const message = area.getByRole("textbox", { name: "Commit message" })
    await expect(message).toHaveValue("Add agent.txt")

    expect(git("rev-parse", "HEAD")).toBe(before)
    await area.locator('[data-action="git-commit"]').click()
    await expect(area.locator('[data-kind="staged"]')).toContainText("Nothing staged")
    await expect.poll(() => git("log", "-1", "--format=%s")).toBe("Add agent.txt")
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("agent.txt")
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

const TEN = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
const A_EDITED = TEN.replace("two\n", "TWO\n").replace("nine\n", "NINE\n")
const A_REVIEWED = TEN.replace("two\n", "TWO\n")
const B_EDITED = "alpha\nBETA\ngamma\n"

test("git panel at 1280x800 with the terminal open: pending agent hunks keep the bar collapsed and every hunk clickable", async ({
  page,
}, info) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-git-review-e2e-")))
  const project = path.join(root, "project")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim()
  const model = await fakeModel([
    { tool: "write", args: { filePath: "a.txt", content: A_EDITED } },
    { tool: "write", args: { filePath: "b.txt", content: B_EDITED } },
    { text: "Edited a.txt and b.txt." },
  ])
  await createProject(project, model.url)
  // The terminal runs /bin/sh, so no shell profile or session file of this machine is read or written.
  const config = JSON.parse(await fs.readFile(path.join(project, "opencode.json"), "utf8")) as Record<string, unknown>
  await fs.writeFile(
    path.join(project, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config, shell: "/bin/sh" }),
  )
  await fs.writeFile(path.join(project, "a.txt"), TEN)
  await fs.writeFile(path.join(project, "b.txt"), "alpha\nbeta\ngamma\n")
  git("add", "opencode.json", "a.txt", "b.txt")
  git("commit", "-q", "-m", "files")
  const server = await serve(root)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}?directory=${encodeURIComponent(project)}`, init)
  try {
    const session = (await (await api("/session", json({}))).json()) as { id: string }
    // The review panel and the terminal open, as the desktop app's window has them.
    await page.addInitScript(() => {
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ review: { panelOpened: true }, terminal: { opened: true, height: 280 } }),
      )
    })
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 30_000 })
    const area = page.locator('[data-component="git-commit-area"]')

    // The human had the commit area open before the agent's turn.
    await area.locator('[data-action="git-expand"]').click()
    await expect(area).toHaveAttribute("data-state", "expanded")
    const prompt = await api(
      `/session/${session.id}/message`,
      json({
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "Edit a.txt and b.txt" }],
      }),
    )
    expect(prompt.status).toBe(200)

    // Pending hunks: the area goes back to its one-line bar and cannot open.
    await expect(area).toHaveAttribute("data-state", "collapsed")
    await expect(area.locator('[data-slot="git-unreviewed"]')).toHaveText("Review agent changes first")
    await expect(area.locator('[data-action="git-expand"]')).toBeDisabled()

    // Agent changes: every hunk's Accept and Reject are on screen and nothing covers them.
    const panel = page.locator("#review-panel")
    await panel.locator('[data-component="select-v2"]').click()
    await page.locator('[data-component="menu-v2-item"]', { hasText: "Agent changes" }).click()
    const hunks = page.locator('[data-component="review-hunk"]')
    for (const [file, count] of [
      ["a.txt", 2],
      ["b.txt", 1],
    ] as const) {
      await page.locator(`[data-component="review-file-row"][data-path="${file}"]`).click()
      await expect(hunks).toHaveCount(count)
      for (const hunk of await hunks.all())
        for (const action of ["accept", "reject"]) {
          const button = hunk.locator(`[data-action="${action}"]`)
          await button.scrollIntoViewIfNeeded()
          await expect(button).toBeInViewport()
          await button.click({ trial: true })
        }
    }
    await shot("5-review-1280x800")
    // The bar is one line; the review keeps the rest of the panel.
    const bar = await area.boundingBox()
    const column = await area.locator("..").boundingBox()
    expect(bar!.height).toBeLessThanOrEqual(40)
    expect(bar!.height / column!.height).toBeLessThan(0.4)

    // a.txt as the desktop smoke does it: accept one hunk, reject the other.
    await page.locator('[data-component="review-file-row"][data-path="a.txt"]').click()
    await expect(hunks).toHaveCount(2)
    await hunks.nth(0).locator('[data-action="accept"]').click()
    await expect(hunks).toHaveCount(1)
    await hunks.nth(0).locator('[data-action="reject"]').click()
    await expect.poll(() => fs.readFile(path.join(project, "a.txt"), "utf8")).toBe(A_REVIEWED)
    await expect(area).toHaveAttribute("data-state", "collapsed") // b.txt still pending

    // Reviewed: the area opens again as the human left it, and takes at most 40% of the panel.
    await page.locator('[data-component="review-file-row"][data-path="b.txt"]').click()
    await hunks.nth(0).locator('[data-action="accept"]').click()
    await expect(area).toHaveAttribute("data-state", "expanded")
    const open = await area.boundingBox()
    expect(open!.height / column!.height).toBeLessThanOrEqual(0.41)
    await shot("6-reviewed-1280x800")
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
