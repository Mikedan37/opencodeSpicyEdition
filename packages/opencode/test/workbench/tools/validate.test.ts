// Static checks of drafted tools, and the guard that they run under Node (the desktop sidecar) without Bun APIs.
import { describe, expect, test } from "bun:test"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import { inspect } from "@/workbench/tools/validate"

const GOOD = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Greets someone",
  args: {
    name: tool.schema.string().describe("Who to greet"),
    times: tool.schema.number().optional(),
  },
  async execute(args) {
    return \`hello \${args.name}\`
  },
})
`

describe("tool creator: static checks", () => {
  test("a good draft yields its description and args, read from the source", async () => {
    expect(await inspect("hello", GOOD)).toEqual({
      description: "Greets someone",
      args: [
        { name: "name", type: "string", description: "Who to greet", required: true },
        { name: "times", type: "number", required: false },
      ],
    })
  })

  test("bad drafts get a reason", async () => {
    const reason = async (name: string, source: string) => (await inspect(name, source)).reason
    expect(await reason("Hello", GOOD)).toContain("lowercase letters")
    expect(await reason("../escape", GOOD)).toContain("lowercase letters")
    expect(await reason("broken", "export default tool({ description: 'x',")).toStartWith("it does not compile:")
    expect(await reason("plain", "export default { description: 'x', args: {}, execute: async () => 'x' }")).toContain(
      "export default tool(",
    )
    expect(
      await reason(
        "two",
        `${GOOD}export const more = tool({ description: "y", args: {}, execute: async () => "y" })\n`,
      ),
    ).toBe("only the default export may be a tool (found export more)")
    expect(await reason("big", `// ${"x".repeat(300 * 1024)}\n${GOOD}`)).toContain("larger than")
  })

  test("the tool creator uses no Bun APIs", async () => {
    for (const file of ["validate.ts", "tools.ts"]) {
      const source = await Bun.file(path.join(import.meta.dir, "../../../src/workbench/tools", file)).text()
      expect(source).not.toMatch(/\bBun\.|from "bun:/)
    }
  })

  test.skipIf(!which("node"))(
    `the checks run under Node${which("node") ? "" : " [skipped: node is not installed]"}`,
    async () => {
      const script = `const { inspect } = await import(${JSON.stringify(path.join(import.meta.dir, "../../../src/workbench/tools/validate.ts"))})
const source = ${JSON.stringify(GOOD)}
process.stdout.write(JSON.stringify([await inspect("hello", source), await inspect("broken", "export default 1 +")]))`
      const proc = Bun.spawn(["node", "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(err.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, "")).toBe("")
      expect(code).toBe(0)
      const [good, broken] = JSON.parse(out)
      expect(good).toEqual(await inspect("hello", GOOD))
      expect(broken.reason).toStartWith("it does not compile:")
    },
  )
})
