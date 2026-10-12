import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect, Schema } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "@/tool/tool"
import { WorkbenchGate } from "../verify/gate"
import { WorkbenchVerify } from "../verify/verify"
import DESCRIPTION from "./check.txt"

const MAX_UNIT_FILES = 200
const MAX_LISTED = 50
const TEST_BUDGET_MS = 180_000

// Unknown keys are rejected so a call cannot pass a report, a status or anything else the engine decides.
export const Parameters = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Files to check, absolute or relative. Defaults to the files changed since the user's last message.",
  }),
  unit: Schema.optional(Schema.String).annotate({
    description: "A folder (every source file under it) or a single file to check",
  }),
  tests: Schema.optional(Schema.Boolean).annotate({
    description: "Also run the tests of the affected packages (go test, cargo test, bun test, node --test)",
  }),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const CheckTool = Tool.define(
  "check",
  Effect.gen(function* () {
    const verify = yield* WorkbenchVerify.Service
    const ripgrep = yield* Ripgrep.Service
    const fs = yield* FSUtil.Service

    const unitFiles = Effect.fnUntraced(function* (target: string) {
      if (!(yield* fs.isDir(target))) return [target]
      const entries = yield* ripgrep
        .glob({
          cwd: target,
          pattern: `**/*{${verify.extensions.join(",")}}`,
          limit: MAX_UNIT_FILES,
        })
        .pipe(Effect.orElseSucceed(() => []))
      return entries.map((entry) => path.join(target, entry.path))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const files = args.files?.length
            ? args.files.map((file) => path.resolve(instance.directory, file))
            : args.unit
              ? yield* unitFiles(path.resolve(instance.directory, args.unit))
              : WorkbenchGate.turnFiles(ctx.messages, instance.directory)
          const result = yield* verify.run({
            files,
            trigger: "agent",
            sessionID: ctx.sessionID,
            tests: args.tests,
            budgetMs: args.tests ? TEST_BUDGET_MS : undefined,
            approve: (units) =>
              ctx
                .ask({ permission: "verify.exec", patterns: [...units], always: [...units], metadata: { units } })
                .pipe(Effect.as(units)),
          })
          const summary = result.report.summary
          return {
            title: files.length
              ? `${summary.failed} failed, ${summary.passed} passed of ${result.report.checks.length} checks`
              : "nothing to check",
            metadata: { report: result.report },
            output: render(result, instance.directory).join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function render(result: WorkbenchVerify.Result, directory: string) {
  const report = result.report
  if (!report.checks.length)
    return [
      report.changedFiles.length
        ? "No checker covers these files. Unverified: " +
          report.changedFiles.map((file) => path.relative(directory, file)).join(", ")
        : "No changed files to check.",
    ]
  const errors = result.problems.filter((item) => item.severity === "error")
  const fresh = errors.filter((item) => item.new)
  const other = errors.filter((item) => !item.new)
  const warnings = result.problems.filter((item) => item.severity === "warning").length
  const s = report.summary
  const list = (items: WorkbenchVerify.Found[]) => [
    ...items.slice(0, MAX_LISTED).map((item) => WorkbenchVerify.formatProblem(item, directory)),
    ...(items.length > MAX_LISTED ? [`... and ${items.length - MAX_LISTED} more`] : []),
  ]
  return [
    `${s.passed} passed, ${s.failed} failed, ${s.timedOut} timed out, ${s.skipped} skipped, ${s.unavailable} unavailable (report ${report.id})`,
    ...(fresh.length ? ["", `Errors in the checked files (${fresh.length}):`, ...list(fresh)] : []),
    ...(other.length ? ["", `Errors elsewhere in the same units (${other.length}):`, ...list(other)] : []),
    ...(warnings ? ["", `${warnings} warning(s) not listed.`] : []),
    "",
    "Runs:",
    ...report.checks.map((check) =>
      [
        check.run.status,
        check.run.checker,
        path.relative(directory, check.run.unit) || ".",
        check.run.reason ?? "",
        check.run.exitCode === undefined ? "" : `exit ${check.run.exitCode}`,
      ]
        .filter(Boolean)
        .join("  "),
    ),
    ...(report.unverifiedFiles.length
      ? ["", "Unverified: " + report.unverifiedFiles.map((file) => path.relative(directory, file)).join(", ")]
      : []),
  ]
}

// What ToolRegistry.node must depend on for this tool (the verification engine and its graph).
export const node = WorkbenchVerify.node

export * as WorkbenchCheckTool from "./check"
