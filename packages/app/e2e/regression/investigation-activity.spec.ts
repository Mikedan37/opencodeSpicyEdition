import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createProject, fakeModel, startServer } from "../utils/opencode-server"

// E2E-01, the UI half. The backend chain of workbench/investigation/verification.test.ts (E2E-01) runs on a real
// opencode server (isolated XDG dirs) with a scripted model, real debugpy and the real checkers: a failing test, the
// debugger's stop, a patch, verification, resolved. The Activity tab then shows the investigation and its evidence,
// and the evidence links open the verification run in Output and the debug session in the Debug tab.
// Run with PLAYWRIGHT_SERVER_PORT set to a free port: the spec starts its server there.

const AVG = "def average(xs: list[int]) -> float:\n    return sum(xs) / len(xs)\n"
const FIXED = "def average(xs: list[int]) -> float:\n    return sum(xs) / len(xs) if xs else 0\n"
const TEST = [
  "import unittest",
  "",
  "from avg import average",
  "",
  "",
  "class AverageTest(unittest.TestCase):",
  "    def test_empty(self) -> None:",
  "        self.assertEqual(average([]), 0)",
  "",
  "    def test_two(self) -> None:",
  "        self.assertEqual(average([10, 20]), 15)",
  "",
].join("\n")

type Evidence = { id: string; kind: string; class: string; refs?: { runID?: string; debugSessionID?: string } }

test.use({ viewport: { width: 1280, height: 800 } })

test("E2E-01: failing test → stop → patch → verification → resolved; the Activity tab shows it and its links", async ({
  page,
}, info) => {
  test.setTimeout(240_000)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-investigation-e2e-")))
  const project = path.join(root, "project")
  const model = await fakeModel(
    [
      { tool: "debug", args: { action: "start", preset: "python-test", program: "test_avg.py" } },
      { tool: "debug", args: { action: "stop" } },
      { tool: "write", args: { filePath: "avg.py", content: FIXED } },
      { tool: "check", args: { files: ["avg.py"], tests: true } },
      { text: "fixed: an empty list averages to 0" },
    ],
    "E2E-01",
  )
  await createProject(project, model.url)
  await fs.writeFile(path.join(project, "avg.py"), AVG)
  await fs.writeFile(path.join(project, "test_avg.py"), TEST)
  const server = await startServer(root)
  const api = (route: string, init?: RequestInit) =>
    fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, init)
  const send = (method: string, route: string, body: unknown) =>
    api(route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  try {
    // The agent's session may do anything, as in the backend test: nothing waits for an answer.
    const session = (await (await send("POST", "/session", {})).json()) as { id: string }
    expect(
      (
        await send("PATCH", `/session/${session.id}`, {
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
      ).status,
    ).toBe(200)
    const prompted = await send("POST", `/session/${session.id}/message`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "test_empty fails; find out why and fix it" }],
    })
    expect(prompted.status).toBe(200)
    expect(model.remaining()).toBe(0)
    expect(await fs.readFile(path.join(project, "avg.py"), "utf8")).toBe(FIXED)

    const summary = (
      (await (await api("/workbench/investigations")).json()) as { id: string; sessionID?: string }[]
    ).find((item) => item.sessionID === session.id)!
    expect(summary).toBeDefined()
    const record = (await (await api(`/workbench/investigations/${summary.id}`)).json()) as {
      investigation: { status: string }
      evidence: Evidence[]
    }
    expect(record.investigation.status).toBe("resolved")
    const stop = record.evidence.find((item) => item.kind === "exception")!
    const check = record.evidence.find((item) => item.kind === "check-run")!
    expect(stop.refs?.debugSessionID).toBeTruthy()
    expect(check.refs?.runID).toBeTruthy()

    // The Activity tab: the investigation, resolved, with its evidence.
    await page.goto(`/server/${base64Encode(server.url)}/session/${session.id}`)
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press("Control+Backquote")
    await page.locator('[data-workbench-tab="activity"]').click()
    const activity = page.locator('[data-component="workbench-activity"]')
    await activity.locator(`button[data-investigation="${summary.id}"]`).click()
    const detail = activity.locator(`[data-component="workbench-investigation"][data-investigation="${summary.id}"]`)
    await expect(detail.locator("[data-investigation-status]").first()).toHaveAttribute(
      "data-investigation-status",
      "resolved",
    )
    for (const item of record.evidence)
      await expect(detail.locator(`[data-evidence="${item.id}"]`)).toHaveAttribute("data-class", item.class)
    await expect(detail.locator(`[data-evidence="${stop.id}"]`)).toContainText("ZeroDivisionError")
    await page.screenshot({ path: info.outputPath("investigation.png") })

    // The verification run opens in Output, focused and expanded.
    await detail.locator(`[data-evidence="${check.id}"] [data-link="run"]`).click()
    await expect(page.locator('[data-workbench-tab="output"]')).toHaveAttribute("aria-selected", "true")
    const run = page.locator(`[data-component="workbench-output"] [data-run="${check.refs!.runID}"]`)
    await expect(run.locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true")
    await page.screenshot({ path: info.outputPath("investigation-run.png") })

    // The debug session opens in the side panel's Debug tab, selected.
    await page.locator('[data-workbench-tab="activity"]').click()
    await detail.locator(`[data-evidence="${stop.id}"] [data-link="debug"]`).click()
    const debug = page.locator('#review-panel [data-component="workbench-debug"]')
    await expect(debug).toBeVisible()
    // One session on this server, so the picker is its label.
    await expect(debug).toContainText("test_avg.py · Ended")
    expect(
      ((await (await api("/workbench/debug/sessions")).json()) as { id: string }[]).map((item) => item.id),
    ).toEqual([stop.refs!.debugSessionID])
    await page.screenshot({ path: info.outputPath("investigation-debug.png") })
  } finally {
    await server.stop()
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
