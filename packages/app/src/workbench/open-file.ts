import { createCommandPaletteFileOpener } from "@/components/command-palette"
import { useFile } from "@/context/file"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useWorkbench } from "./panel"

// Opens a file tab at a 1-based line: selects the line (the viewer highlights it), opens the tab with the app's own
// opener, then scrolls the rendered line into view. The viewer exposes [data-line] rows inside its shadow root.
// `select: false` only scrolls: the debugger marks its lines itself, and the file view keeps the first selection it
// reports, so a later programmatic selection in the same file would not show.
export function useFileLineOpener() {
  const file = useFile()
  const workbench = useWorkbench()
  const { tabs } = useSessionLayout()
  const openFile = createCommandPaletteFileOpener()
  return (path: string, line: number, select = true) => {
    // The side panel's Debug tab covers the file tabs.
    workbench.hideSide()
    if (select) file.setSelectedLines(path, { start: line, end: line })
    openFile(path)
    // A tab added while the panel's tab bar shows another one is selected before its trigger registers; Kobalte then
    // falls back to the first tab (Review). Selecting it again once the trigger exists keeps the file in front, as the
    // panel's own file opener does.
    const tab = file.tab(path)
    queueMicrotask(() => tabs().setActive(tab))
    revealLine(line)
  }
}

function revealLine(line: number, attempt = 0) {
  requestAnimationFrame(() => {
    const target = [...document.querySelectorAll("diffs-container")]
      .map((host) => host.shadowRoot?.querySelector(`[data-file] [data-line="${line}"]`))
      .find((node): node is HTMLElement => node instanceof HTMLElement && node.getClientRects().length > 0)
    if (target) return target.scrollIntoView({ block: "center" })
    // ponytail: polls up to ~1s for the viewer to render; a viewer "scroll to line" API would replace this.
    if (attempt < 60) revealLine(line, attempt + 1)
  })
}
