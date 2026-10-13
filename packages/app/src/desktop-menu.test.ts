import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU, desktopMenuLabel } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })

  // spicy: the IDE's entries in View run the commands workbench/panel.tsx registers, labelled from the fork's copy
  test("lists the IDE's tabs and actions under View with their labels", () => {
    const view = DESKTOP_MENU.find((menu) => menu.id === "view")?.items ?? []
    const ide = view.flatMap((item) => (item.type === "item" && item.command?.startsWith("workbench.") ? [item] : []))
    expect(ide.map((item) => item.command)).toEqual([
      "workbench.agents",
      "workbench.problems",
      "workbench.output",
      "workbench.debug",
      "workbench.run",
      "workbench.activity",
      "workbench.tools",
      "workbench.check",
      "workbench.agent.new",
      "workbench.task.new",
      "workbench.tool.new",
    ])
    const translate = (key: string) => `native:${key}`
    expect(ide.map((item) => desktopMenuLabel(item.labelKey!, translate)).slice(0, 2)).toEqual([
      "Show agents",
      "Show problems",
    ])
    expect(desktopMenuLabel("desktop.menu.toggleTerminal", translate)).toBe("native:desktop.menu.toggleTerminal")
  })
})
