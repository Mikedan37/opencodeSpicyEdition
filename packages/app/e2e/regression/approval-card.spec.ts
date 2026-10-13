import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

// The main chat's approval card and the composer's approval mode, against a mocked server: the card's words, its
// queue ("2 of 3"), what Always covers, the project save, and the mode pill's menu with its inline confirm for Auto.

const directory = "C:/OpenCode/Approvals"
const projectID = "proj_approvals"
const sessionID = "ses_approvals"
const title = "Approval card"

const bash = {
  id: "per_1",
  sessionID,
  permission: "bash",
  patterns: ["bun test"],
  metadata: { command: "bun test" },
  always: ["bun test *"],
}
const edit = {
  id: "per_2",
  sessionID,
  permission: "edit",
  patterns: ["src/app.ts"],
  metadata: {
    filepath: `${directory}/src/app.ts`,
    diff: [
      "Index: src/app.ts",
      "===================================================================",
      "--- src/app.ts",
      "+++ src/app.ts",
      "@@ -1,3 +1,3 @@",
      " export function greet(name: string) {",
      '-  return "Hello " + name',
      "+  return `Hello, ${name}!`",
      " }",
      "",
    ].join("\n"),
  },
  always: ["*"],
}
const mcp = {
  id: "per_3",
  sessionID,
  permission: "github_create_issue",
  patterns: ["*"],
  metadata: {},
  always: ["*"],
}

test.use({ viewport: { width: 1280, height: 800 } })

test("the approval card: words, queue, what Always covers, and each answer", async ({ page }) => {
  const transport = await installSseTransport(page, { server: server(), retry: 20 })
  await mockServer(page, [bash, edit, mcp])
  const saved: string[] = []
  await page.route(workbench("permissions/"), (route) => {
    saved.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!))
    return route.fulfill({ json: { rules: [{ permission: mcp.permission, pattern: "*" }] } })
  })
  const replies: { id: string; reply: unknown }[] = []
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(/\/permission\/([^/]+)\/reply$/)
    if (match && request.method() === "POST") replies.push({ id: match[1], reply: request.postDataJSON().reply })
  })
  const replied = (id: string) =>
    transport.send({ directory, payload: { type: "permission.replied", properties: { sessionID, requestID: id } } })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const card = page.locator('[data-component="approval-card"]')
  const object = card.locator('[data-slot="approval-object"]')
  const queue = card.locator('[data-slot="approval-queue"]')
  const always = card.locator('[data-action="approval-always"]')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-slot="approval-verb"]')).toHaveText("Run")
  await expect(object).toHaveText("bun test")
  await expect(queue).toHaveText("1 of 3")
  await expect(always).toHaveText("Always: bun test …")
  await expect(card.getByRole("group")).toHaveAccessibleName("Run bun test 1 of 3")
  // The composer gave way to the card, so the card holds the focus (not a button: typing answers nothing).
  await expect(card.getByRole("group")).toBeFocused()
  await page.keyboard.type("y")
  expect(replies).toEqual([])

  await card.locator('[data-action="approval-allow"]').click()
  await expect.poll(() => replies).toEqual([{ id: "per_1", reply: "once" }])
  await replied("per_1")

  // The next request slides in: an edit, with its diff, and Always covers every edit.
  await expect(object).toHaveText("src/app.ts")
  await expect(queue).toHaveText("2 of 3")
  await expect(card.locator('[data-slot="approval-diff"]')).toContainText("Hello, ${name}!")
  await expect(always).toHaveText("Always: all edits")
  await always.click()
  await expect.poll(() => replies.at(-1)).toEqual({ id: "per_2", reply: "always" })
  await replied("per_2")

  // An MCP tool asks with its own name; Always ▾ → This project saves it (and answers it).
  await expect(card.locator('[data-slot="approval-verb"]')).toHaveText("Use")
  await expect(object).toHaveText("github_create_issue")
  await expect(queue).toHaveText("3 of 3")
  await card.locator('[data-action="approval-always-menu"]').click()
  const menu = page.locator("[data-approval-menu]")
  await expect(menu.getByRole("menuitem")).toHaveText(["This session", /This project/])
  await menu.locator('[data-choice="project"]').click()
  await expect.poll(() => saved).toEqual(["per_3"])
  expect(replies.map((item) => item.id)).not.toContain("per_3")
  await replied("per_3")

  // The card leaves; the composer is back.
  await expect(card).toHaveCount(0)
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})

test("Deny answers reject; a lone request shows no count", async ({ page }) => {
  await mockServer(page, [{ ...bash, id: "per_9" }])
  await page.route(workbench(""), (route) => route.fulfill({ status: 404, json: {} }))
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const card = page.locator('[data-component="approval-card"]')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-slot="approval-queue"]')).toHaveCount(0)
  const reply = page.waitForRequest((request) => /\/permission\/per_9\/reply$/.test(new URL(request.url()).pathname))
  await card.locator('[data-action="approval-deny"]').click()
  expect((await reply).postDataJSON()).toEqual({ reply: "reject" })
})

test("the approval mode pill: Ask, Auto edits, and Auto after an inline confirm", async ({ page }) => {
  await mockServer(page, [])
  let state = { edits: false, commands: false }
  const puts: unknown[] = []
  await page.route(workbench("sessions/"), async (route) => {
    if (route.request().method() === "PUT") {
      state = route.request().postDataJSON()
      puts.push(state)
    }
    return route.fulfill({ json: state })
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const pill = page.locator('[data-action="prompt-approval-mode"]')
  await expect(pill).toHaveAttribute("data-mode", "ask")
  await expect(pill).toHaveText("Ask")
  await expect(pill).toHaveAccessibleName("Approvals: Ask")

  await pill.click()
  const menu = page.locator("[data-approval-modes]")
  const ask = menu.getByRole("menuitemradio", { name: "Ask" })
  const edits = menu.getByRole("menuitemradio", { name: "Auto edits" })
  const auto = menu.getByRole("menuitemradio", { name: "Auto", exact: true })
  await expect(menu.getByRole("menuitemradio")).toHaveText([/^Ask/, /^Auto edits/, /^Auto/])
  await expect(ask).toHaveAttribute("aria-checked", "true")
  await expect(ask).toHaveAccessibleDescription("Asks before edits and commands")
  await expect(edits).toHaveAccessibleDescription("Edits apply; you review after. Commands ask.")
  await expect(auto).toHaveAccessibleDescription("Edits and commands run. Your denies still apply.")
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  // From the keyboard: Enter opens the menu on its first mode, arrows move, Enter picks.
  await pill.focus()
  await page.keyboard.press("Enter")
  await expect(ask).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(edits).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(menu).toHaveCount(0)
  await expect.poll(() => puts).toEqual([{ edits: true, commands: false }])
  await expect(pill).toHaveAttribute("data-mode", "edits")
  await expect(pill).toHaveText("Auto edits")
  await expect(page.getByText("Approvals: Auto edits")).toBeAttached()

  // Auto asks once, inline: the first pick only arms it; Escape disarms it.
  await pill.click()
  await auto.click()
  await expect(auto).toHaveAccessibleDescription("Select again to turn on Auto")
  expect(puts).toHaveLength(1)
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await pill.click()
  await expect(auto).toHaveAccessibleDescription("Edits and commands run. Your denies still apply.")
  await auto.click()
  await auto.click()
  await expect.poll(() => puts.at(-1)).toEqual({ edits: true, commands: true })
  await expect(pill).toHaveAttribute("data-mode", "auto")
  await expect(pill).toHaveText("Auto")

  // Back to Ask needs no confirm.
  await pill.click()
  await ask.click()
  await expect.poll(() => puts.at(-1)).toEqual({ edits: false, commands: false })
  await expect(pill).toHaveAttribute("data-mode", "ask")
})

// The server's /workbench routes (not the app's own /src/workbench modules).
function workbench(prefix: string) {
  return (url: URL) => url.port === new URL(server()).port && url.pathname.startsWith(`/workbench/${prefix}`)
}

function server() {
  return `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
}

async function mockServer(page: Page, permissions: unknown[]) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "approvals",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "approvals",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    permissions,
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
}
