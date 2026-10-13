import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, fakeModel, startServer } from "../utils/opencode-server"

// The git panel against a real opencode server (isolated XDG dirs) in temp repositories. One project has no
// small_model and a local bare repository as origin: Generate stays off, a file is staged from its checkbox and
// committed with Ctrl+Enter, the branch is published with --set-upstream after the dialog's confirmation, a new branch
// is created and switched to, and a switch with uncommitted changes is refused with git's reason. In the other, a
// session's agent wrote a file that the Agent changes review has not decided: the commit area warns, Generate asks the
// small_model (a scripted stub) for the message, and Commit asks before committing. No gh, no network.
// Run with PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there.

test.use({ viewport: { width: 1440, height: 900 } })

// The server never looks for OpenCode Native (AgentKit discovery) on this machine.
async function serve(root: string) {
  const bridge = process.env.OPENCODE_AGENTKIT_BRIDGE
  process.env.OPENCODE_AGENTKIT_BRIDGE = path.join(root, "no-agentkit-bridge")
  return startServer(root).finally(() => {
    if (bridge === undefined) delete process.env.OPENCODE_AGENTKIT_BRIDGE
    else process.env.OPENCODE_AGENTKIT_BRIDGE = bridge
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
  } finally {
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("git panel: undecided agent changes warn before the commit; Generate uses the small_model", async ({
  page,
}, info) => {
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
    await expect(area.locator('[data-slot="git-unreviewed"]')).toContainText("1 agent change not reviewed yet", {
      timeout: 30_000,
    })

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

    // Commit asks first while the review has undecided hunks; Cancel commits nothing.
    const commit = area.locator('[data-action="git-commit"]')
    await commit.click()
    const dialog = page.locator('[data-component="git-unreviewed-dialog"]')
    await expect(dialog).toContainText("1 agent change not reviewed yet")
    await shot("4-unreviewed")
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toHaveCount(0)
    expect(git("rev-parse", "HEAD")).toBe(before)

    // Commit anyway.
    await commit.click()
    await dialog.locator('[data-action="git-commit-anyway"]').click()
    await expect(area.locator('[data-kind="staged"]')).toContainText("Nothing staged")
    await expect.poll(() => git("log", "-1", "--format=%s")).toBe("Add agent.txt")
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("agent.txt")
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
