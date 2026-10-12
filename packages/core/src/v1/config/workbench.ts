export * as ConfigWorkbenchV1 from "./workbench"

// OpenCode Spicy Edition: workbench settings. `checks` are check commands defined by the repository. They are
// arbitrary repository code, so the workbench treats every one as exec-class: it asks for verify.exec before it
// runs one, and it never runs them when the configuration loads.

import { Schema } from "effect"

// Output formats the workbench can read; `plain` is `file:line(:col): [severity: ]message` lines.
export const Format = Schema.Literals([
  "plain",
  "tsc",
  "sarif",
  "cargo",
  "go-build",
  "ruff",
  "mypy",
  "junit",
  "go-test",
])
export type Format = Schema.Schema.Type<typeof Format>

export const Check = Schema.Struct({
  command: Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMinLength(1)).annotate({
    description:
      "Program and arguments, run without a shell. $REPORT_DIR is replaced by a temporary folder whose files are read as the report (for junit)",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "Working directory, relative to the project directory (default: the project directory)",
  }),
  files: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Globs, relative to the project directory, of the changed files that trigger this check (default: every file)",
  }),
  format: Format.annotate({ description: "How to read the command's output" }),
})
export type Check = Schema.Schema.Type<typeof Check>

export const Info = Schema.Struct({
  checks: Schema.optional(Schema.Record(Schema.String, Check)).annotate({
    description:
      "Check commands defined by this repository, by name. They run only through the workbench (check tool, turn-end gate, Problems panel) and always ask for the verify.exec permission.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
