import path from "path"
import { fileURLToPath } from "url"
import { Option, Schema } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import type { WorkbenchProblems } from "../problems/store"

// Parsers turn one checker run's output into problem drafts. Tool positions are 1-based unless noted;
// problems are 0-based. Relative paths resolve against the directory the tool ran in.

type Draft = WorkbenchProblems.Draft
export type Output = { stdout: string; stderr: string; exitCode: number; cwd: string }

// ---------------------------------------------------------------- clang SARIF (+ linker text)

const SarifLocation = Schema.Struct({
  physicalLocation: Schema.optional(
    Schema.Struct({
      artifactLocation: Schema.optional(Schema.Struct({ uri: Schema.optional(Schema.String) })),
      region: Schema.optional(
        Schema.Struct({
          startLine: Schema.optional(Schema.Number),
          startColumn: Schema.optional(Schema.Number),
          endLine: Schema.optional(Schema.Number),
          endColumn: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
})
const Sarif = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      results: Schema.optional(
        Schema.Array(
          Schema.Struct({
            level: Schema.optional(Schema.String),
            ruleId: Schema.optional(Schema.String),
            message: Schema.Struct({ text: Schema.String }),
            locations: Schema.optional(Schema.Array(SarifLocation)),
          }),
        ),
      ),
    }),
  ),
})
const decodeSarif = Schema.decodeUnknownOption(Schema.fromJsonString(Sarif))
const sarifLevels: Record<string, Workbench.Severity> = {
  error: "error",
  warning: "warning",
  note: "info",
  none: "hint",
}

// clang prints one pretty SARIF document per source file to stderr, with plain text (error counts,
// linker output) between them. Documents open with "{" and close with "}" at column 0.
export function clang(output: Output): Draft[] {
  const docs: string[][] = []
  const text: string[] = []
  for (const line of output.stderr.split("\n")) {
    const doc = docs.at(-1)
    if (doc && doc.at(-1) !== "}") doc.push(line)
    else if (line === "{") docs.push([line])
    else text.push(line)
  }
  const problems = docs.flatMap((doc) =>
    Option.match(decodeSarif(doc.join("\n")), {
      onNone: () => [],
      onSome: (sarif) =>
        sarif.runs.flatMap((run) =>
          (run.results ?? []).map((result): Draft => {
            const location = result.locations?.[0]?.physicalLocation
            const region = location?.region
            const uri = location?.artifactLocation?.uri
            return {
              file: uri?.startsWith("file://") ? fileURLToPath(uri) : uri && path.resolve(output.cwd, uri),
              range: region?.startLine
                ? span(region.startLine, region.startColumn ?? 1, region.endLine, region.endColumn)
                : undefined,
              severity: sarifLevels[result.level ?? "error"] ?? "error",
              message: result.message.text,
              code: result.ruleId,
            }
          }),
        ),
    }),
  )
  return [...problems, ...linker(text)]
}

// A program that type-checks but does not link must fail: `-fsyntax-only` alone exits 0 there.
function linker(lines: string[]): Draft[] {
  const block = lines.map((line) => line.trimEnd()).filter((line) => line && !/^\d+ (error|warning)s? /.test(line))
  if (!block.some((line) => /Undefined symbols|undefined reference|linker command failed|^ld: /.test(line))) return []
  return [
    {
      kind: "build",
      severity: "error",
      code: "link",
      // object names carry a random suffix (main-1a2b3c.o); drop it so the problem id is stable
      message: block
        .slice(0, 12)
        .join("\n")
        .replace(/-[0-9a-f]{6}\.o\b/g, ".o"),
    },
  ]
}

// ---------------------------------------------------------------- tsc --pretty false

export function tsc(output: Output): Draft[] {
  const problems: Draft[] = []
  for (const line of output.stdout.split("\n")) {
    const at = /^(.+)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/.exec(line)
    const global = /^(error|warning) (TS\d+): (.*)$/.exec(line)
    const last = problems.at(-1)
    if (at)
      problems.push({
        file: path.resolve(output.cwd, at[1]),
        range: span(Number(at[2]), Number(at[3])),
        severity: at[4] === "error" ? "error" : at[4] === "warning" ? "warning" : "info",
        message: at[6],
        code: at[5],
      })
    else if (global)
      problems.push({ severity: global[1] === "error" ? "error" : "warning", message: global[3], code: global[2] })
    // continuation lines of a multi-line message are indented
    else if (last && /^\s+\S/.test(line))
      problems[problems.length - 1] = { ...last, message: `${last.message}\n${line.trim()}` }
  }
  return problems
}

// ---------------------------------------------------------------- file:line:col: [severity:] message

// swift, swiftc, go build output, go vet. Lines without a severity word use `severity`.
export function located(text: string, cwd: string, severity: Workbench.Severity = "error"): Draft[] {
  return text.split("\n").flatMap((line) => {
    const match = /^(.+?\.[\w+]+):(\d+):(?:(\d+):)? (?:(error|warning|note|remark|fatal error): )?(.*)$/.exec(line)
    if (!match || !match[5]) return []
    const level = match[4]
    return [
      {
        file: path.resolve(cwd, match[1]),
        range: span(Number(match[2]), Number(match[3] ?? 1)),
        severity: !level
          ? severity
          : level === "warning"
            ? "warning"
            : level === "note" || level === "remark"
              ? "info"
              : "error",
        message: match[5],
      },
    ]
  })
}

export function swift(output: Output): Draft[] {
  return located(stripAnsi(`${output.stdout}\n${output.stderr}`), output.cwd)
}

export function goVet(output: Output): Draft[] {
  return located(`${output.stdout}\n${output.stderr}`, output.cwd)
}

// ---------------------------------------------------------------- go build -json

const GoEvent = Schema.Struct({ Action: Schema.optional(Schema.String), Output: Schema.optional(Schema.String) })
const decodeGoEvent = Schema.decodeUnknownOption(Schema.fromJsonString(GoEvent))

export function goBuild(output: Output): Draft[] {
  const text = output.stdout
    .split("\n")
    .flatMap((line) => Option.toArray(decodeGoEvent(line)))
    .filter((event) => event.Action === "build-output")
    .map((event) => event.Output ?? "")
    .join("")
  return located(text, output.cwd)
}

// ---------------------------------------------------------------- cargo check --message-format=json

const CargoSpan = Schema.Struct({
  file_name: Schema.String,
  line_start: Schema.Number,
  column_start: Schema.Number,
  line_end: Schema.Number,
  column_end: Schema.Number,
  is_primary: Schema.Boolean,
  label: Schema.optional(Schema.NullOr(Schema.String)),
})
const CargoMessage = Schema.Struct({
  reason: Schema.String,
  message: Schema.optional(
    Schema.Struct({
      level: Schema.String,
      message: Schema.String,
      code: Schema.optional(Schema.NullOr(Schema.Struct({ code: Schema.String }))),
      spans: Schema.Array(CargoSpan),
    }),
  ),
})
const decodeCargo = Schema.decodeUnknownOption(Schema.fromJsonString(CargoMessage))
const cargoLevels: Record<string, Workbench.Severity> = {
  error: "error",
  "error: internal compiler error": "error",
  warning: "warning",
  note: "info",
  help: "hint",
}

export function cargo(output: Output): Draft[] {
  return output.stdout.split("\n").flatMap((line) =>
    Option.toArray(decodeCargo(line)).flatMap((event): Draft[] => {
      const message = event.message
      if (event.reason !== "compiler-message" || !message || !cargoLevels[message.level]) return []
      if (/^aborting due to/.test(message.message)) return []
      const primary = message.spans.find((item) => item.is_primary)
      // span-less warnings are summaries ("2 warnings emitted")
      if (!primary && message.level !== "error") return []
      return [
        {
          file: primary && path.resolve(output.cwd, primary.file_name),
          range: primary && span(primary.line_start, primary.column_start, primary.line_end, primary.column_end),
          severity: cargoLevels[message.level],
          message: primary?.label ? `${message.message}: ${primary.label}` : message.message,
          code: message.code?.code,
          related: message.spans
            .filter((item) => !item.is_primary && item.label)
            .map((item) => ({
              file: path.resolve(output.cwd, item.file_name),
              range: span(item.line_start, item.column_start, item.line_end, item.column_end),
              message: item.label ?? "",
            })),
        },
      ]
    }),
  )
}

// ---------------------------------------------------------------- ruff --output-format=json

const RuffItem = Schema.Struct({
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
  filename: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  location: Schema.Struct({ row: Schema.Number, column: Schema.Number }),
  end_location: Schema.optional(Schema.Struct({ row: Schema.Number, column: Schema.Number })),
})
const decodeRuff = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(RuffItem)))
// Lint findings are warnings, except syntax errors and names that do not exist at run time.
const ruffErrors = new Set(["E999", "F821", "F822", "F823"])

export function ruff(output: Output): Draft[] {
  return Option.getOrElse(decodeRuff(output.stdout.trim() || "[]"), () => []).map((item) => ({
    file: path.resolve(output.cwd, item.filename),
    range: span(item.location.row, item.location.column, item.end_location?.row, item.end_location?.column),
    severity: item.code === null || ruffErrors.has(item.code) ? "error" : "warning",
    message: item.message,
    code: item.code ?? undefined,
    codeHref: item.url ?? undefined,
  }))
}

// ---------------------------------------------------------------- mypy -O json

const MypyItem = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number, // 0-based
  message: Schema.String,
  hint: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.String,
})
const decodeMypy = Schema.decodeUnknownOption(Schema.fromJsonString(MypyItem))

export function mypy(output: Output): Draft[] {
  return output.stdout.split("\n").flatMap((line) =>
    Option.toArray(decodeMypy(line)).map(
      (item): Draft => ({
        file: path.resolve(output.cwd, item.file),
        range: span(item.line, Math.max(item.column, 0) + 1),
        severity: item.severity === "error" ? "error" : "info",
        message: item.hint ? `${item.message}\n${item.hint}` : item.message,
        code: item.code ?? undefined,
      }),
    ),
  )
}

// ---------------------------------------------------------------- test runners

const GoTestEvent = Schema.Struct({
  Action: Schema.String,
  Test: Schema.optional(Schema.String),
  Output: Schema.optional(Schema.String),
})
const decodeGoTest = Schema.decodeUnknownOption(Schema.fromJsonString(GoTestEvent))

// go test -json: one problem per failing test, at the first `file.go:line:` message or, for a panic, the first
// stack frame inside the package. Build errors arrive as build-output events.
export function goTest(output: Output): Draft[] {
  const events = output.stdout.split("\n").flatMap((line) => Option.toArray(decodeGoTest(line)))
  const text = (test: string) =>
    events
      .filter((event) => event.Action === "output" && event.Test === test)
      .map((event) => event.Output ?? "")
      .join("")
  const failed = events.flatMap((event) => (event.Action === "fail" && event.Test ? [event.Test] : []))
  const build = located(
    events
      .filter((event) => event.Action === "build-output")
      .map((event) => event.Output ?? "")
      .join(""),
    output.cwd,
  )
  return [
    ...build,
    ...failed
      // a parent test fails because a subtest failed; report the subtest
      .filter((test) => !failed.some((other) => other.startsWith(`${test}/`)))
      .map((test): Draft => {
        const body = text(test)
        const assertion = /^\s+([^\s:]+\.go):(\d+): (.*)$/m.exec(body)
        const panic = /^panic: (.*)$/m.exec(body)
        const frame = [...body.matchAll(/^\t(\/\S+\.go):(\d+)/gm)].find((match) =>
          match[1].startsWith(output.cwd + path.sep),
        )
        const at = assertion ?? frame
        return {
          kind: "test",
          file: at && path.resolve(output.cwd, at[1]),
          range: at && span(Number(at[2]), 1),
          severity: "error",
          message: `${test}: ${assertion?.[3] ?? (panic ? `panic: ${panic[1]}` : "failed")}`,
          code: test,
        }
      }),
  ]
}

// JUnit XML from bun test and node --test. ponytail: regex over the reporter's regular XML, not a full parser.
export function junit(output: Output): Draft[] {
  return [...output.stdout.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)].flatMap((match): Draft[] => {
    const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(match[2])
    if (!failure) return []
    const attrs = attributes(match[1])
    const failureAttrs = attributes(failure[1] ?? failure[3] ?? "")
    const body = xmlText(`${failureAttrs.message ?? ""}\n${failure[2] ?? ""}`)
    // the first stack location inside the project, else the testcase's own file and line
    const frame = [...body.matchAll(/(?:file:\/\/)?((?:\/|\.{0,2}[\w@-])[^\s():]*\.[cm]?[jt]sx?):(\d+):(\d+)/g)]
      .map((item) => ({
        file: path.resolve(output.cwd, item[1]),
        line: Number(item[2]),
        column: Number(item[3]),
      }))
      .find(
        (item) =>
          item.file.startsWith(output.cwd + path.sep) && !item.file.includes(`${path.sep}node_modules${path.sep}`),
      )
    const file = frame?.file ?? (attrs.file ? path.resolve(output.cwd, attrs.file) : undefined)
    const line = frame?.line ?? (attrs.line ? Number(attrs.line) : undefined)
    const message = xmlText(failureAttrs.message ?? failure[2] ?? "failed")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n")
    return [
      {
        kind: "test",
        file,
        range: line === undefined ? undefined : span(line, frame?.column ?? 1),
        severity: "error",
        message: `${xmlText(attrs.name ?? "test")}: ${message}`,
        code: xmlText(attrs.name ?? "test"),
      },
    ]
  })
}

// cargo test --message-format=json: compiler messages are JSON lines (see `cargo`); the test harness writes text.
export function cargoTest(output: Output): Draft[] {
  return [...output.stdout.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((match): Draft => {
    const name = match[1]
    const start = output.stdout.indexOf(`---- ${name} stdout ----`)
    const block = start === -1 ? "" : output.stdout.slice(start).split(/\n(?=---- |failures:)/)[0]
    const panic = /panicked at (.+?):(\d+):(\d+):\n(.*)/.exec(block)
    return {
      kind: "test",
      file: panic ? path.resolve(output.cwd, panic[1]) : undefined,
      range: panic ? span(Number(panic[2]), Number(panic[3])) : undefined,
      severity: "error",
      message: `${name}: ${panic?.[4] ?? "failed"}`,
      code: name,
    }
  })
}

function attributes(text: string) {
  return Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]))
}

function xmlText(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

// ---------------------------------------------------------------- helpers

function span(line: number, column: number, endLine?: number, endColumn?: number): Workbench.Range {
  const start = { line: Math.max(line - 1, 0), character: Math.max(column - 1, 0) }
  if (endLine === undefined) return { start, end: start }
  return { start, end: { line: Math.max(endLine - 1, 0), character: Math.max((endColumn ?? column) - 1, 0) } }
}

export function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
}

export * as WorkbenchParse from "./parse"
