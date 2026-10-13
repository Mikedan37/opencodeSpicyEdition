// The bottom panel's IDE surfaces after the terminals (UX #7): Problems, Checks, Debug and Agents. Debug and Agents
// have views (sub-tabs). The tab ids from before the regroup still work: persisted panels, `open(id)` and the
// `data-workbench-tab` / `data-tab` test ids.
export const SURFACES = ["problems", "checks", "debug", "agents"] as const
export type Surface = (typeof SURFACES)[number]
export const DEBUG_VIEWS = ["console", "program"] as const
export type DebugView = (typeof DEBUG_VIEWS)[number]
export const AGENT_VIEWS = ["agents", "tasks", "activity", "tools"] as const
export type AgentView = (typeof AGENT_VIEWS)[number]

type Place =
  | { surface: "problems" | "checks" }
  | { surface: "debug"; view?: DebugView }
  | { surface: "agents"; view?: AgentView }

// Every id a caller may open, old and new. Without a view a surface opens on its last one.
export const PLACES = {
  problems: { surface: "problems" },
  checks: { surface: "checks" },
  output: { surface: "checks" },
  debug: { surface: "debug" },
  console: { surface: "debug", view: "console" },
  program: { surface: "debug", view: "program" },
  run: { surface: "debug", view: "program" },
  agents: { surface: "agents" },
  agentList: { surface: "agents", view: "agents" },
  tasks: { surface: "agents", view: "tasks" },
  activity: { surface: "agents", view: "activity" },
  tools: { surface: "agents", view: "tools" },
} as const satisfies Record<string, Place>
export type PlaceID = keyof typeof PLACES

// The stable test id of each surface's trigger: Checks keeps Output's.
export const TRIGGER_ID: Record<Surface, string> = {
  problems: "problems",
  checks: "output",
  debug: "debug",
  agents: "agents",
}

// The id from before the regroup for what the panel shows (its `data-tab`), so old selectors keep matching.
export function legacyTab(surface: Surface, view?: string) {
  if (surface === "debug") return view === "program" ? "run" : "debug"
  if (surface === "agents") return view === "activity" || view === "tools" ? view : "agents"
  return TRIGGER_ID[surface]
}

// A panel saved before the regroup names a tab that is a view now: "run" opens Debug › Program, "activity" Agents ›
// Activity, "output" Checks.
export function migratePanel(value: unknown) {
  if (!value || typeof value !== "object") return value
  const saved = value as { tab?: unknown }
  const place: Place | undefined =
    typeof saved.tab === "string" && saved.tab in PLACES ? PLACES[saved.tab as PlaceID] : undefined
  if (!place || place.surface === saved.tab) return value
  return { ...saved, tab: place.surface, ...("view" in place && place.view ? { [place.surface]: place.view } : {}) }
}

// The triggers that fit in `room` (indexes into `widths`, in order); the others go to the "»" menu, `more` wide. The
// open one always stays in the bar.
export function fitTabs(widths: readonly number[], room: number, more: number, open: number) {
  if (widths.reduce((sum, width) => sum + width, 0) <= room) return widths.map((_, index) => index)
  const shown: number[] = []
  let used = more
  for (const [index, width] of widths.entries()) {
    if (used + width > room) break
    used += width
    shown.push(index)
  }
  if (open < 0 || shown.includes(open)) return shown
  while (shown.length && used + widths[open]! > room) used -= widths[shown.pop()!]!
  return [...shown, open]
}
