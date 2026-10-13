import { describe, expect, test } from "bun:test"
import { fitTabs, legacyTab, migratePanel, PLACES } from "./tabs"

describe("the bottom panel's tab model", () => {
  test("old tab ids open their new places", () => {
    expect(PLACES.output).toEqual({ surface: "checks" })
    expect(PLACES.run).toEqual({ surface: "debug", view: "program" })
    expect(PLACES.activity).toEqual({ surface: "agents", view: "activity" })
    expect(PLACES.tools).toEqual({ surface: "agents", view: "tools" })
    // Without a view a surface keeps its last one
    expect(PLACES.debug).toEqual({ surface: "debug" })
    expect(PLACES.agents).toEqual({ surface: "agents" })
  })

  test("the open panel answers to its old id", () => {
    expect(legacyTab("checks")).toBe("output")
    expect(legacyTab("problems")).toBe("problems")
    expect(legacyTab("debug", "console")).toBe("debug")
    expect(legacyTab("debug", "program")).toBe("run")
    expect(legacyTab("agents", "agents")).toBe("agents")
    expect(legacyTab("agents", "tasks")).toBe("agents")
    expect(legacyTab("agents", "activity")).toBe("activity")
    expect(legacyTab("agents", "tools")).toBe("tools")
  })

  test("a panel saved before the regroup opens where its tab went", () => {
    expect(migratePanel({ tab: "output" })).toEqual({ tab: "checks" })
    expect(migratePanel({ tab: "run" })).toEqual({ tab: "debug", debug: "program" })
    expect(migratePanel({ tab: "activity" })).toEqual({ tab: "agents", agents: "activity" })
    expect(migratePanel({ tab: "tools" })).toEqual({ tab: "agents", agents: "tools" })
    // Ids that are still surfaces, a terminal (""), unknown ids and current panels stay as they are
    for (const value of [{ tab: "agents" }, { tab: "debug" }, { tab: "problems" }, { tab: "" }, { tab: "nope" }])
      expect(migratePanel(value)).toBe(value)
    const current = { tab: "agents", debug: "console", agents: "tools" }
    expect(migratePanel(current)).toBe(current)
    expect(migratePanel(null)).toBe(null)
  })

  test("tabs that do not fit go to the menu; the open one stays in the bar", () => {
    const widths = [80, 70, 60, 70]
    expect(fitTabs(widths, 280, 30, 0)).toEqual([0, 1, 2, 3])
    // 279: the menu (30) and the first three (210) fit
    expect(fitTabs(widths, 279, 30, 0)).toEqual([0, 1, 2])
    expect(fitTabs(widths, 190, 30, 1)).toEqual([0, 1])
    // The open one is last: it takes the place of the tabs before it until it fits
    expect(fitTabs(widths, 190, 30, 3)).toEqual([0, 3])
    expect(fitTabs(widths, 100, 30, 3)).toEqual([3])
    expect(fitTabs(widths, 20, 30, -1)).toEqual([])
  })
})
