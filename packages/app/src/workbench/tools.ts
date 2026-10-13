// The tool creator's state (Tools tab): drafts agents or the user wrote, waiting for the user's review, and the
// created tools (custom_<name>). The list comes from GET /workbench/tools; workbench.tool.updated / removed events
// keep it current, and an update refetches the list, which alone carries an enabled tool's inputSchema.
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { errorText, WorkbenchRequestError, type WorkbenchClient } from "./client"

type Tool = Workbench.CustomTool

export const TOOL_GROUPS = [
  "draft",
  "enabled",
  "disabled",
  "invalid",
] as const satisfies readonly Workbench.CustomToolStatus[]

type Client = Pick<
  WorkbenchClient,
  "tools" | "createTool" | "approveTool" | "enableTool" | "disableTool" | "rejectTool" | "removeTool" | "runTool"
>

// The list's sections in review order, each newest change first; empty sections are left out.
export function groupTools(list: readonly Tool[]) {
  return TOOL_GROUPS.map((status) => ({
    status,
    tools: list.filter((tool) => tool.status === status).toSorted((a, b) => b.updatedAt - a.updatedAt),
  })).filter((group) => group.tools.length > 0)
}

export function createToolsState(client: Client, delay = 250) {
  const [state, setState] = createStore({
    list: [] as Tool[],
    status: "idle" as "idle" | "loading" | "ready" | "unavailable" | "failed",
    error: undefined as string | undefined,
    selected: undefined as string | undefined,
    // The action in flight per tool, so its buttons wait.
    busy: {} as Record<string, string | undefined>,
    // "stale": an approve or enable was refused because the code changed after the user looked at it.
    notice: {} as Record<string, "stale" | undefined>,
  })
  const find = (name: string | undefined) => (name ? state.list.find((tool) => tool.name === name) : undefined)

  function upsert(tool: Tool) {
    const index = state.list.findIndex((item) => item.name === tool.name)
    if (index === -1) return setState("list", (list) => [...list, tool])
    const current = state.list[index]!
    // An event carries the file's view, without the loaded inputSchema; keep the list's until the refetch.
    const keep = !tool.inputSchema && current.inputSchema && current.hash === tool.hash && tool.status === "enabled"
    setState("list", index, reconcile(keep ? { ...tool, inputSchema: current.inputSchema } : tool))
  }
  const drop = (name: string) =>
    batch(() => {
      setState("list", (list) => list.filter((tool) => tool.name !== name))
      if (state.selected === name) setState("selected", undefined)
    })

  // Loads the list; a call while one is in flight runs once more after it, so the newest state wins.
  const run = { active: false, again: false }
  function load(): Promise<void> {
    if (run.active) {
      run.again = true
      return Promise.resolve()
    }
    run.active = true
    if (state.status !== "ready") setState({ status: "loading", error: undefined })
    return client
      .tools()
      .then(
        (list) =>
          batch(() => {
            setState("list", reconcile([...list], { key: "name" }))
            setState({ status: "ready", error: undefined })
          }),
        (error: unknown) =>
          setState({
            status:
              error instanceof WorkbenchRequestError && error.kind === "unavailable" && !error.status
                ? "unavailable"
                : "failed",
            error: errorText(error),
          }),
      )
      .finally(() => {
        run.active = false
        if (!run.again) return
        run.again = false
        return load()
      })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const invalidate = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void load(), delay)
  }

  function act<T>(name: string, action: string, request: () => Promise<T>) {
    if (state.busy[name]) return Promise.resolve(undefined)
    batch(() => {
      setState("busy", name, action)
      setState("notice", name, undefined)
    })
    return request().finally(() => setState("busy", name, undefined))
  }

  // Approve and enable send the hash of the code the user reviewed; the server refuses (409) a file that changed since,
  // then the list is loaded again so the detail shows what it is now.
  const reviewed = (tool: Tool, action: "approve" | "enable") =>
    act(tool.name, action, () =>
      (action === "approve" ? client.approveTool : client.enableTool)(tool.name, tool.hash).then(
        (result) => {
          upsert(result)
          return "done" as const
        },
        (error: unknown) => {
          if (!(error instanceof WorkbenchRequestError) || error.status !== 409) throw error
          setState("notice", tool.name, "stale")
          return load().then(() => "stale" as const)
        },
      ),
    )

  return {
    state,
    find,
    load,
    invalidate,
    dispose: () => clearTimeout(timer),
    groups: () => groupTools(state.list),
    // Drafts waiting for the user's review (the tab's badge).
    waiting: () => state.list.filter((tool) => tool.status === "draft").length,
    select: (name: string | undefined) => setState("selected", name),
    // workbench.tool.updated / removed
    update(tool: Tool) {
      upsert(tool)
      invalidate()
    },
    remove: drop,
    approve: (tool: Tool) => reviewed(tool, "approve"),
    enable: (tool: Tool) => reviewed(tool, "enable"),
    disable: (name: string) => act(name, "disable", () => client.disableTool(name).then(upsert)),
    reject: (name: string) => act(name, "reject", () => client.rejectTool(name).then(() => drop(name))),
    delete: (name: string) => act(name, "delete", () => client.removeTool(name).then(() => drop(name))),
    run: (name: string, args: Record<string, unknown>) => act(name, "run", () => client.runTool(name, args)),
    // The user's own draft: saved like an agent's, then reviewed and approved like any other.
    create: (draft: Workbench.CustomToolDraft) =>
      client.createTool(draft).then((tool) => {
        batch(() => {
          upsert(tool)
          setState("selected", tool.name)
        })
        return tool
      }),
  }
}

export type ToolsState = ReturnType<typeof createToolsState>

// The tool a completed tool_create call drafted (an Agent HQ feed row): the built-in tool, or the Workbench MCP
// bridge's (mcp__<server>__tool_create). The opencode provider titles the call custom_<name>; other providers' output
// names it ("… available as custom_<name>").
export function draftedTool(call: { tool: string; state: string; title?: string; output?: string }) {
  if (call.state !== "completed" || (call.tool !== "tool_create" && !call.tool.endsWith("__tool_create"))) return
  return /\bcustom_([a-z0-9_]+)/.exec(`${call.title ?? ""} ${call.output ?? ""}`)?.[1]
}

// ---------------------------------------------------------------- test run form

export type ToolField = {
  name: string
  kind: "string" | "number" | "integer" | "boolean" | "enum" | "json"
  required: boolean
  description?: string
  // enum values, as the select shows them
  options?: string[]
}

// The test run form from an enabled tool's inputSchema (JSON Schema of its zod args): strings, numbers, booleans and
// enums get their own field; anything else (arrays, objects, unions) is typed as JSON.
export function toolFields(schema: Record<string, unknown> | undefined): ToolField[] {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown> | undefined>
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]) : [])
  return Object.entries(properties).map(([name, property]) => {
    const values = property?.enum
    const kind: ToolField["kind"] =
      Array.isArray(values) && values.length > 0 && values.every((value) => ["string", "number"].includes(typeof value))
        ? "enum"
        : property?.type === "string" || property?.type === "number" || property?.type === "integer"
          ? property.type
          : property?.type === "boolean"
            ? "boolean"
            : "json"
    return {
      name,
      kind,
      required: required.has(name),
      ...(typeof property?.description === "string" ? { description: property.description } : {}),
      ...(kind === "enum" ? { options: (values as (string | number)[]).map(String) } : {}),
    }
  })
}

// The form's values as the tool's args. Empty optional fields are left out (an unchecked optional box too), so the
// tool's own defaults apply. `values` holds strings, and booleans for the checkboxes.
export function toolArgs(
  fields: readonly ToolField[],
  values: Record<string, string | boolean | undefined>,
  schema?: Record<string, unknown>,
):
  | { args: Record<string, unknown> }
  | { error: { field: string; problem: "required" | "number" | "integer" | "json" } } {
  const args: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (field.kind === "boolean") {
      if (raw === true || field.required) args[field.name] = raw === true
      continue
    }
    const text = typeof raw === "string" ? raw : ""
    if (text === "") {
      if (field.required) return { error: { field: field.name, problem: "required" } }
      continue
    }
    if (field.kind === "number" || field.kind === "integer") {
      const value = Number(text)
      if (!Number.isFinite(value)) return { error: { field: field.name, problem: "number" } }
      if (field.kind === "integer" && !Number.isInteger(value))
        return { error: { field: field.name, problem: "integer" } }
      args[field.name] = value
      continue
    }
    if (field.kind === "enum") {
      // A numeric enum gets its number back.
      const property = (schema?.properties as Record<string, { enum?: unknown[] }> | undefined)?.[field.name]
      args[field.name] = property?.enum?.find((value) => String(value) === text) ?? text
      continue
    }
    if (field.kind === "json") {
      try {
        args[field.name] = JSON.parse(text)
      } catch {
        return { error: { field: field.name, problem: "json" } }
      }
      continue
    }
    args[field.name] = text
  }
  return { args }
}

// A new tool starts from this: the tool() API from @opencode-ai/plugin with one zod arg.
export const TOOL_TEMPLATE = `// A tool that agents call as custom_<name> once you approve it. Nothing in it runs before that,
// and every call asks you first unless you allow it always.
import { tool } from "@opencode-ai/plugin"

export default tool({
  // What the tool does, for the model that calls it.
  description: "Greet someone by name",
  // Arguments are zod schemas: tool.schema is zod.
  args: {
    name: tool.schema.string().describe("Who to greet"),
  },
  // Returns the text the agent sees, or { output, title?, metadata? }.
  // context.directory is the project folder; context.ask() asks the user for a permission.
  async execute(args, context) {
    return \`hello \${args.name}\`
  },
})
`
