// Static checks of a drafted custom tool. The source is parsed with the TypeScript compiler, never imported or run.
// This module runs under Node too (the desktop sidecar): only node built-ins and the `typescript` package, no Bun
// APIs and no path aliases (test/workbench/tools/validate.test.ts runs it under Node).
import type { CustomToolArg } from "@opencode-ai/schema/workbench"
import type { CallExpression, ExportAssignment, Node, PropertyAssignment } from "typescript"

export const NAME = /^[a-z][a-z0-9_]{0,39}$/
export const MAX_SOURCE = 256 * 1024

export type Inspection = {
  readonly reason?: string // set when the draft cannot be approved
  readonly description?: string // the description in the tool() call, when it is a plain string
  readonly args: CustomToolArg[]
}

export async function inspect(name: string, source: string): Promise<Inspection> {
  if (!NAME.test(name))
    return { reason: "the name must be lowercase letters, digits and _ (max 40), starting with a letter", args: [] }
  if (source.length > MAX_SOURCE) return { reason: `the source is larger than ${MAX_SOURCE / 1024} KB`, args: [] }
  const ts = (await import("typescript")).default
  const compiled = ts.transpileModule(source, {
    fileName: `${name}.ts`,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  })
  const error = compiled.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error)
  if (error) {
    const line =
      error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start).line : -1
    return {
      reason: `it does not compile: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}${line >= 0 ? ` (line ${line + 1})` : ""}`,
      args: [],
    }
  }

  const file = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const isTool = (node: Node | undefined): node is CallExpression => {
    const inner = node && ts.isAsExpression(node) ? node.expression : node
    return (
      !!inner && ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "tool"
    )
  }
  // Named exports become extra tools (custom_<name>_<export>) that the user never reviewed as such.
  const named = file.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? statement.declarationList.declarations.filter((item) => isTool(item.initializer))
      : [],
  )
  if (named.length)
    return { reason: `only the default export may be a tool (found export ${named[0].name.getText(file)})`, args: [] }
  const exported = file.statements.find(
    (statement): statement is ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals,
  )
  const call =
    exported && (ts.isAsExpression(exported.expression) ? exported.expression.expression : exported.expression)
  if (!isTool(call))
    return {
      reason: 'the file must end with export default tool({ ... }) using tool from "@opencode-ai/plugin"',
      args: [],
    }

  const options = call.arguments[0]
  if (!options || !ts.isObjectLiteralExpression(options))
    return { reason: "tool() must get an object: { description, args, execute }", args: [] }
  const property = (key: string) =>
    options.properties.find(
      (item): item is PropertyAssignment =>
        ts.isPropertyAssignment(item) && item.name.getText(file).replace(/^["']|["']$/g, "") === key,
    )?.initializer
  const text = property("description")
  const description =
    text && (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)) ? text.text : undefined
  const args = property("args")
  return {
    ...(description !== undefined ? { description } : {}),
    args:
      args && ts.isObjectLiteralExpression(args)
        ? args.properties.flatMap((item) =>
            ts.isPropertyAssignment(item) ? [summary(item.name.getText(file), item.initializer.getText(file))] : [],
          )
        : [],
  }
}

// What a zod chain like tool.schema.string().optional().describe("...") says, read from its text.
function summary(name: string, chain: string): CustomToolArg {
  const type = /\b(?:schema|z)\.(\w+)\(/.exec(chain)?.[1]
  const description = /\.describe\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/.exec(chain)?.[2]
  return {
    name: name.replace(/^["']|["']$/g, ""),
    ...(type ? { type } : {}),
    ...(description ? { description } : {}),
    required: !/\.(optional|nullish|default)\(/.test(chain),
  }
}
