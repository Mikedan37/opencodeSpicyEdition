import { describe, expect, test } from "bun:test"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { WorkbenchRequestError } from "./client"
import { createToolsState, draftedTool, groupTools, toolArgs, toolFields } from "./tools"

const tool = (name: string, patch: Partial<Workbench.CustomTool> = {}): Workbench.CustomTool => ({
  name,
  id: `custom_${name}`,
  description: `${name} tool`,
  args: [],
  status: "draft",
  path: `/repo/.opencode/tool-drafts/${name}.ts`,
  source: `// ${name}`,
  hash: `h:${name}`,
  createdBy: { by: "agent", sessionID: "ses_1", agent: "build" },
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

function setup(list: Workbench.CustomTool[]) {
  const calls: string[] = []
  const server = { list }
  const client = {
    tools: async () => {
      calls.push("list")
      return server.list
    },
    createTool: async (draft: Workbench.CustomToolDraft) => {
      calls.push(`create ${draft.name}`)
      return tool(draft.name, { createdBy: { by: "user" as const } })
    },
    approveTool: async (name: string, hash: string) => {
      calls.push(`approve ${name} ${hash}`)
      const current = server.list.find((item) => item.name === name)!
      if (current.hash !== hash) throw new WorkbenchRequestError("failed", "changed since review", 409)
      return { ...current, status: "enabled" as const, inputSchema: { type: "object", properties: {} } }
    },
    enableTool: async (name: string, hash: string) => {
      calls.push(`enable ${name} ${hash}`)
      return tool(name, { status: "enabled" })
    },
    disableTool: async (name: string) => {
      calls.push(`disable ${name}`)
      return tool(name, { status: "disabled" })
    },
    rejectTool: async (name: string) => {
      calls.push(`reject ${name}`)
      return true
    },
    removeTool: async (name: string) => {
      calls.push(`delete ${name}`)
      return true
    },
    runTool: async (name: string, args: Record<string, unknown>) => {
      calls.push(`run ${name} ${JSON.stringify(args)}`)
      return { title: name, output: `ran ${JSON.stringify(args)}`, metadata: {} }
    },
  }
  return { calls, server, tools: createToolsState(client, 0) }
}

describe("tools state", () => {
  test("the list groups drafts, enabled, disabled and invalid tools, newest first; drafts waiting are counted", () => {
    const list = [
      tool("old_draft", { updatedAt: 1 }),
      tool("live", { status: "enabled", updatedAt: 5 }),
      tool("new_draft", { updatedAt: 9 }),
      tool("broken", { status: "invalid", reason: "it does not compile" }),
    ]
    expect(groupTools(list).map((group) => [group.status, group.tools.map((item) => item.name)])).toEqual([
      ["draft", ["new_draft", "old_draft"]],
      ["enabled", ["live"]],
      ["invalid", ["broken"]],
    ])
  })

  test("approve sends the reviewed hash; a 409 marks the tool stale and loads the list again", async () => {
    const { calls, server, tools } = setup([tool("greet")])
    await tools.load()
    expect(tools.waiting()).toBe(1)

    // An agent replaced the draft after the user looked at it: the server refuses the old hash.
    const seen = tools.find("greet")!
    server.list = [tool("greet", { source: "// changed", hash: "h:changed", updatedAt: 2 })]
    expect(await tools.approve(seen)).toBe("stale")
    expect(calls).toEqual(["list", "approve greet h:greet", "list"])
    expect(tools.state.notice.greet).toBe("stale")
    expect(tools.find("greet")?.source).toBe("// changed")

    // Approving what is on screen now goes through and clears the notice.
    expect(await tools.approve(tools.find("greet")!)).toBe("done")
    expect(calls.at(-1)).toBe("approve greet h:changed")
    expect(tools.state.notice.greet).toBeUndefined()
    expect(tools.find("greet")?.status).toBe("enabled")
    expect(tools.waiting()).toBe(0)
  })

  test("one action per tool at a time; reject, delete and removed events drop it and its selection", async () => {
    const { calls, tools } = setup([tool("a"), tool("b"), tool("c", { status: "enabled" })])
    await tools.load()
    tools.select("a")
    const first = tools.reject("a")
    expect(await tools.approve(tools.find("a")!)).toBeUndefined()
    await first
    expect(tools.find("a")).toBeUndefined()
    expect(tools.state.selected).toBeUndefined()
    await tools.delete("c")
    tools.remove("b")
    expect(tools.state.list).toEqual([])
    expect(calls).toEqual(["list", "reject a", "delete c"])
  })

  test("an update event keeps the loaded inputSchema of the same file and refetches the list", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } } }
    const { calls, tools } = setup([tool("greet", { status: "enabled", inputSchema: schema })])
    await tools.load()
    tools.update(tool("greet", { status: "enabled", description: "renamed" }))
    expect(tools.find("greet")?.inputSchema).toEqual(schema)
    expect(tools.find("greet")?.description).toBe("renamed")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(calls).toEqual(["list", "list"])
    tools.dispose()
  })

  test("the user's draft is saved and selected; the test run sends the args", async () => {
    const { calls, tools } = setup([])
    await tools.load()
    const draft = await tools.create({ name: "greet", description: "Greets", source: "// x" })
    expect(draft.createdBy.by).toBe("user")
    expect(tools.state.selected).toBe("greet")
    expect(await tools.run("greet", { name: "Ada" })).toEqual({
      title: "greet",
      output: 'ran {"name":"Ada"}',
      metadata: {},
    })
    expect(calls).toEqual(["list", "create greet", 'run greet {"name":"Ada"}'])
  })
})

describe("test run form", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", description: "Who to greet" },
      count: { type: "integer" },
      ratio: { type: "number" },
      loud: { type: "boolean" },
      mode: { type: "string", enum: ["short", "long"] },
      level: { enum: [1, 2, 3] },
      tags: { type: "array", items: { type: "string" } },
      when: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["name", "count", "loud"],
  }

  test("fields follow the schema; anything but strings, numbers, booleans and enums is typed as JSON", () => {
    expect(toolFields(schema)).toEqual([
      { name: "name", kind: "string", required: true, description: "Who to greet" },
      { name: "count", kind: "integer", required: true },
      { name: "ratio", kind: "number", required: false },
      { name: "loud", kind: "boolean", required: true },
      { name: "mode", kind: "enum", required: false, options: ["short", "long"] },
      { name: "level", kind: "enum", required: false, options: ["1", "2", "3"] },
      { name: "tags", kind: "json", required: false },
      { name: "when", kind: "json", required: false },
    ])
    expect(toolFields(undefined)).toEqual([])
  })

  test("values become args: numbers, enums and JSON parsed, empty optional fields left out", () => {
    const fields = toolFields(schema)
    expect(
      toolArgs(
        fields,
        { name: "Ada", count: "3", ratio: "", loud: false, mode: "long", level: "2", tags: '["a"]' },
        schema,
      ),
    ).toEqual({ args: { name: "Ada", count: 3, loud: false, mode: "long", level: 2, tags: ["a"] } })
    expect(toolArgs(fields, { name: "", count: "1" }, schema)).toEqual({
      error: { field: "name", problem: "required" },
    })
    expect(toolArgs(fields, { name: "Ada", count: "1.5" }, schema)).toEqual({
      error: { field: "count", problem: "integer" },
    })
    expect(toolArgs(fields, { name: "Ada", count: "x" }, schema)).toEqual({
      error: { field: "count", problem: "number" },
    })
    expect(toolArgs(fields, { name: "Ada", count: "1", tags: "[oops" }, schema)).toEqual({
      error: { field: "tags", problem: "json" },
    })
  })
})

describe("Agent HQ", () => {
  test("a completed tool_create names the drafted tool", () => {
    expect(draftedTool({ tool: "tool_create", state: "completed", title: "custom_greet" })).toBe("greet")
    expect(
      draftedTool({
        tool: "mcp__opencode-workbench__tool_create",
        state: "completed",
        output: "Draft created … Once approved it is available as custom_word_count; nothing in it runs before that.",
      }),
    ).toBe("word_count")
    expect(draftedTool({ tool: "tool_create", state: "running", title: "custom_greet" })).toBeUndefined()
    expect(draftedTool({ tool: "write", state: "completed", title: "custom_greet" })).toBeUndefined()
  })
})
