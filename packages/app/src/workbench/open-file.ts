import { createCommandPaletteFileOpener } from "@/components/command-palette"
import { useFile } from "@/context/file"
import { useWorkbench } from "./panel"

// Opens a file tab at a 1-based line: selects the line (the viewer highlights it), opens the tab with the app's own
// opener, then scrolls the rendered line into view. The viewer exposes [data-line] rows inside its shadow root.
export function useFileLineOpener() {
  const file = useFile()
  const workbench = useWorkbench()
  const openFile = createCommandPaletteFileOpener()
  return (path: string, line: number) => {
    // The side panel's Debug tab covers the file tabs.
    workbench.hideSide()
    file.setSelectedLines(path, { start: line, end: line })
    openFile(path)
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
