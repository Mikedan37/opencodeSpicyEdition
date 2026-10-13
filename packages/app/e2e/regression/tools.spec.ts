import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, fakeModel, repo, startServer } from "../utils/opencode-server"

// The Tools tab against a real opencode server (isolated XDG dirs) with a scripted model: a draft posted through the
// route appears live, is approved, run from its generated form, disabled and deleted; an approve over a draft that
// changed on disk is refused and explained; the user's own draft from New tool; and an Agent HQ agent's tool_create
// links to its draft. The project's .opencode has @opencode-ai/plugin linked from this repository, so approving
// installs nothing. Run with PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there.

const GREET = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Greets someone",
  args: {
    name: tool.schema.string().describe("Who to greet"),
    times: tool.schema.number().int().optional().describe("How many times"),
    loud: tool.schema.boolean().optional().describe("Shout it"),
    style: tool.schema.enum(["plain", "fancy"]).optional(),
  },
  async execute(args) {
    const line = args.style === "fancy" ? \`* hello \${args.name} *\` : \`hello \${args.name}\`
    const text = Array.from({ length: args.times ?? 1 }, () => line).join("\\n")
    return args.loud ? text.toUpperCase() : text
  },
})
`

const WORDS = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Counts the words in a text",
  args: { text: tool.schema.string().describe("The text") },
  async execute(args) {
    return String(args.text.split(/\\s+/).filter(Boolean).length)
  },
})
`

test.use({ viewport: { width: 1280, height: 800 } })

test("tools: review, approve, run, disable, delete; stale reviews refused; drafts from New tool and from an agent", async ({
  page,
}, info) => {
  test.setTimeout(240_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tools-e2e-")))
  const project = path.join(root, "project")
  const model = await fakeModel(
    [
      { tool: "tool_create", args: { name: "word_count", description: "Counts words", source: WORDS } },
      { text: "Drafted word_count." },
    ],
    "Tools e2e",
  )
  await createProject(project, model.url)
  await linkPlugin(project)
  const server = await startServer(root)
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) })
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, init)
  const listed = async () => ((await (await api("/workbench/tools")).json()) as { name: string }[]).map((t) => t.name)
  try {
    const session = (await (await api("/session", json({}))).json()) as { id: string }
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press("Control+Backquote")
    // Tools is a view of the Agents tab (UX #7)
    await page.locator('[data-workbench-tab="agents"]').click()
    const tab = page.locator('[data-workbench-tab="tools"]')
    await tab.click()
    const panel = page.locator('[data-component="workbench-tools"]')
    await expect(panel).toContainText("No tools yet")

    // A draft posted through the route appears live, waiting for review; the tab counts it.
    const posted = await api("/workbench/tools", json({ name: "greet", description: "Greets someone", source: GREET }))
    expect(posted.status).toBe(200)
    const row = panel.locator('[data-tool-group="draft"] [data-tool="greet"]')
    await expect(row).toContainText("You")
    await expect(tab.locator('[data-slot="view-waiting"]')).toHaveText("1")
    await row.click()
    const detail = panel.locator('[data-component="workbench-tool"][data-tool="greet"]')
    await expect(detail).toHaveAttribute("data-status", "draft")
    await expect(detail.locator('[data-slot="tool-args"]')).toContainText("Who to greet")
    await expect(detail.locator('[data-component="code-view"] .cm-content')).toContainText(
      'description: "Greets someone"',
    )
    await shot("1-draft")

    // Approve: the tool is enabled and its test run form comes from the loaded schema.
    await detail.locator('[data-action="tool-approve"]').click()
    await expect(detail).toHaveAttribute("data-status", "enabled")
    await expect(panel.locator('[data-tool-group="enabled"] [data-tool="greet"]')).toBeVisible()
    // Nothing waits now: the badge is the view's muted count (UX wave 3)
    await expect(tab.locator('[data-slot="view-waiting"]')).toHaveCount(0)
    await expect(tab.locator('[data-slot="view-count"]')).toHaveText("1")
    const form = detail.locator('[data-slot="tool-run"]')
    await form.locator('input[name="name"]').fill("Ada")
    await form.locator('input[name="times"]').fill("2")
    await form.locator('select[name="style"]').selectOption("fancy")
    await form.locator('[data-action="tool-run"]').click()
    await expect(form.locator('[data-slot="tool-run-result"] pre')).toHaveText("* hello Ada *\n* hello Ada *")
    await shot("2-test-run")

    // Disable, then Delete, which asks first.
    await detail.locator('[data-action="tool-disable"]').click()
    await expect(detail).toHaveAttribute("data-status", "disabled")
    await detail.locator('[data-action="tool-delete"]').click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toContainText("Delete custom_greet?")
    await dialog.getByRole("button", { name: "Delete" }).click()
    await expect(panel.locator('[data-tool-group] [data-tool="greet"]')).toHaveCount(0)
    expect(await listed()).toEqual([])

    // The draft changes on disk after the user looked at it (no event): approving is refused, the detail says so and
    // shows the code as it is now; approving that goes through.
    await api("/workbench/tools", json({ name: "stale_one", description: "Greets someone", source: GREET }))
    await panel.locator('[data-tool-group="draft"] [data-tool="stale_one"]').click()
    const stale = panel.locator('[data-component="workbench-tool"][data-tool="stale_one"]')
    await expect(stale.locator(".cm-content")).toContainText('description: "Greets someone"')
    await fs.writeFile(
      path.join(project, ".opencode", "tool-drafts", "stale_one.ts"),
      GREET.replace('"Greets someone"', '"Greets someone, changed"'),
    )
    await stale.locator('[data-action="tool-approve"]').click()
    await expect(stale.locator('[data-slot="tool-stale"]')).toHaveText(
      "The code changed since you looked; review again.",
    )
    await expect(stale).toHaveAttribute("data-status", "draft")
    await expect(stale.locator(".cm-content")).toContainText('"Greets someone, changed"')
    await shot("3-stale")
    await stale.locator('[data-action="tool-approve"]').click()
    await expect(stale).toHaveAttribute("data-status", "enabled")
    await expect(stale.locator('[data-slot="tool-stale"]')).toHaveCount(0)

    // The user's own draft from New tool, reviewed like any other.
    await panel.locator('[data-action="tool-new"]').click()
    const create = panel.locator('[data-component="workbench-tool-new"]')
    await expect(create.locator(".cm-content")).toContainText('import { tool } from "@opencode-ai/plugin"')
    await create.locator('input[name="name"]').fill("hello_world")
    await create.locator('input[name="description"]').fill("Says hello")
    await shot("4-new-tool")
    await create.locator('[data-action="tool-save"]').click()
    const mine = panel.locator('[data-component="workbench-tool"][data-tool="hello_world"]')
    await expect(mine).toHaveAttribute("data-status", "draft")
    await expect(mine).toContainText("You")
    await mine.locator('[data-action="tool-approve"]').click()
    await expect(mine).toHaveAttribute("data-status", "enabled")

    // An Agent HQ agent drafts with tool_create (its edit ask answered like the user would): its feed links to the
    // draft in Tools.
    const agent = (await (
      await api(
        "/agenthq/agents",
        json({ name: "Ada", avatar: { kind: "preset", value: "fox" }, provider: "opencode" }),
      )
    ).json()) as { id: string }
    const hq = (await (await api(`/agenthq/agents/${agent.id}/sessions`, json({}))).json()) as { id: string }
    expect((await api(`/agenthq/sessions/${hq.id}/messages`, json({ text: "Make a word counter" }))).status).toBe(200)
    let requestID = ""
    await expect
      .poll(async () => {
        const record = (await (await api(`/agenthq/sessions/${hq.id}`)).json()) as {
          history: { event: { type: string; requestID?: string } }[]
        }
        requestID = record.history.find((item) => item.event.type === "permission.requested")?.event.requestID ?? ""
        return requestID
      })
      .not.toBe("")
    expect((await api(`/agenthq/sessions/${hq.id}/permissions/${requestID}`, json({ optionID: "once" }))).status).toBe(
      200,
    )
    await expect.poll(listed).toContain("word_count")
    // The Agents tab comes back on Tools; its Agents view has the roster
    await page.locator('[data-workbench-tab="agents"]').click()
    await page.locator('[data-agenthq-view="agents"]').click()
    await page.locator(`[data-component="agenthq-card"][data-agent="${agent.id}"]`).click()
    const drafted = page.locator('[data-component="agenthq-workspace"] [data-slot="tool-drafted"]')
    await expect(drafted).toContainText("Drafted tool word_count — review in Tools")
    await shot("5-agent-drafted")
    await drafted.getByRole("button", { name: "review in Tools" }).click()
    await expect(tab).toHaveAttribute("aria-selected", "true")
    const theirs = panel.locator('[data-component="workbench-tool"][data-tool="word_count"]')
    await expect(theirs).toHaveAttribute("data-status", "draft")
    await expect(theirs).toContainText("Ada")
    await shot("6-agent-draft-in-tools")
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
}

// The project's .opencode already has @opencode-ai/plugin (linked from this repository) and a lockfile, so config and
// approval install nothing.
async function linkPlugin(project: string) {
  const opencode = path.join(project, ".opencode")
  await fs.mkdir(path.join(opencode, "node_modules", "@opencode-ai"), { recursive: true })
  await fs.symlink(
    path.join(repo, "packages/plugin"),
    path.join(opencode, "node_modules", "@opencode-ai", "plugin"),
    "dir",
  )
  const dependencies = { "@opencode-ai/plugin": "*" }
  await fs.writeFile(path.join(opencode, "package.json"), JSON.stringify({ dependencies }))
  await fs.writeFile(path.join(opencode, "package-lock.json"), JSON.stringify({ packages: { "": { dependencies } } }))
}
