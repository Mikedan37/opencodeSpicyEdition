import type { Workbench } from "@opencode-ai/schema/workbench"
import { sourcesOf } from "./problems"

// What "Fix with agent" and "Investigate with agent" send (UI-07): plain text the agent reads as its prompt, every
// field spelled out. Nothing in it asks for or grants a permission.

const CONTEXT = 10 // source lines on each side of a problem
const MAX_PROBLEMS = 50

// Project-relative when inside `root`.
export function shortPath(root: string, file: string) {
  const base = root.replace(/\/+$/, "")
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file
}

// 1-based like the Problems tab: "12:5", or "12:5-12:18" when it spans.
export function rangeText(range: Workbench.Range | undefined) {
  if (!range) return "(no position)"
  const start = `${range.start.line + 1}:${range.start.character + 1}`
  const end = `${range.end.line + 1}:${range.end.character + 1}`
  return end === start ? start : `${start}-${end}`
}

// The lines around each marked line (1-based), windows merged where they meet or overlap, ">" on the marked lines,
// in a fence longer than any backtick run inside.
export function excerpt(text: string, marked: readonly number[], context = CONTEXT) {
  const lines = text === "" ? [] : text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  // A line past the end (the file got shorter since) has nothing to show.
  const windows = [...new Set(marked)]
    .filter((line) => line >= 1 && line <= lines.length)
    .toSorted((a, b) => a - b)
    .map((line): [number, number] => [Math.max(1, line - context), Math.min(lines.length, line + context)])
    .reduce<[number, number][]>((merged, [start, end]) => {
      const last = merged.at(-1)
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
      return merged
    }, [])
  if (!windows.length) return
  const width = String(windows.at(-1)![1]).length
  const body = windows
    .map(([start, end]) =>
      lines
        .slice(start - 1, end)
        .map((line, index) => {
          const number = start + index
          return `${marked.includes(number) ? ">" : " "} ${String(number).padStart(width)} | ${line}`
        })
        .join("\n"),
    )
    .join("\n…\n")
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((match) => match[0].length + 1)))
  return `${fence}\n${body}\n${fence}`
}

// The run that reported these problems when one did, else the newest finished check or test run.
export function latestRun(problems: readonly Workbench.Problem[], runs: readonly Workbench.RunInfo[]) {
  const ids = new Set(problems.flatMap((problem) => sourcesOf(problem).flatMap((source) => source.runID ?? [])))
  const finished = runs
    .filter((run) => run.kind !== "repro" && run.status !== "queued" && run.status !== "running")
    .toSorted((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))
  return finished.find((run) => ids.has(run.id)) ?? finished[0]
}

export function runSummary(run: Workbench.RunInfo, root: string) {
  const details = [
    run.exitCode === undefined ? undefined : `exit code ${run.exitCode}`,
    run.reason,
    run.counts ? `${run.counts.error} errors, ${run.counts.warning} warnings` : undefined,
    `run ${run.id}`,
  ].filter(Boolean)
  return `${run.checker} ${run.kind} of ${shortPath(root, run.unit)}: ${run.status} (${details.join("; ")})`
}

// One problem, or a file's problems ("Fix all in file"). `source`: the file's text, or why it could not be read.
export function problemSnapshot(input: {
  root: string
  file?: string
  problems: readonly Workbench.Problem[]
  source?: { text: string } | { error: string }
  run?: Workbench.RunInfo
}) {
  const where = input.file ? ` in ${shortPath(input.root, input.file)}` : ""
  const shown = input.problems.slice(0, MAX_PROBLEMS)
  const many = input.problems.length > 1
  const blocks = shown.map((problem, index) => {
    const message = problem.message.split("\n").join("\n  ")
    const code =
      problem.code === undefined ? [] : [`Code: ${problem.code}${problem.codeHref ? ` (${problem.codeHref})` : ""}`]
    const sources = sourcesOf(problem).map(
      (source) =>
        `${source.tool} (${[source.kind, source.channel, source.runID && `run ${source.runID}`].filter(Boolean).join(", ")})`,
    )
    const related = (problem.related ?? []).map(
      (item) => `Related: ${shortPath(input.root, item.file)}:${rangeText(item.range)}: ${item.message}`,
    )
    return [
      ...(many ? [`Problem ${index + 1} of ${input.problems.length}`] : []),
      // A file's problems name the file once, above them.
      ...(problem.file && !(many && input.file) ? [`File: ${shortPath(input.root, problem.file)}`] : []),
      `Severity: ${problem.severity}`,
      `Range: ${rangeText(problem.range)}`,
      ...code,
      `Message: ${message}`,
      `Sources: ${sources.join(", ")}`,
      ...related,
      ...(problem.stale ? ["Stale: the file or its language server changed since this was reported"] : []),
    ].join("\n")
  })
  const more =
    input.problems.length > shown.length ? [`… and ${input.problems.length - shown.length} more problems.`] : []
  const source = (() => {
    if (!input.file || !input.source) return []
    const name = shortPath(input.root, input.file)
    if ("error" in input.source) return [`Source of ${name}: not available (${input.source.error}).`]
    const lines = shown.flatMap((problem) => (problem.range ? [problem.range.start.line + 1] : []))
    const text = excerpt(input.source.text, lines)
    return text ? [`Source of ${name} (">" marks the problem lines):\n${text}`] : []
  })()
  return [
    many ? `Fix these ${input.problems.length} problems${where}.` : "Fix this problem.",
    ...blocks,
    ...more,
    ...source,
    `Latest verification run: ${input.run ? runSummary(input.run, input.root) : "none yet"}.`,
  ].join("\n\n")
}

// A debugger stop: the backend already capped its frames and locals (dap/snapshot.ts `fit`), so they go as they are.
export function stopSnapshot(input: { root: string; session: Workbench.DebugSessionInfo }) {
  const session = input.session
  const stop = session.stop
  const program = session.program ? shortPath(input.root, session.program) : "(unknown program)"
  const header = [
    "Investigate this debugger stop.",
    [
      `Program: ${program} (${session.adapter}, debug session ${session.id})`,
      ...(stop
        ? [`Reason: ${stop.reason}${stop.description ? ` (${stop.description})` : ""}`]
        : ["Reason: (not stopped)"]),
      ...(stop?.exception
        ? [`Exception: ${[stop.exception.id, stop.exception.description].filter(Boolean).join(": ")}`]
        : []),
      ...(session.investigationID ? [`Investigation: ${session.investigationID}`] : []),
    ].join("\n"),
  ]
  if (!stop) return header.join("\n\n")
  const frames = stop.frames.map(
    (frame, index) =>
      `${index + 1}. ${frame.name} at ${frame.file ? `${shortPath(input.root, frame.file)}:${frame.line ?? "?"}` : "(no source)"}`,
  )
  const top = stop.frames[0]
  // Adapter groups such as debugpy's "special variables" have no value of their own: nothing to read without a click.
  const locals = stop.locals
    .filter((local) => local.value !== "" || local.variablesReference === 0)
    .map((local) => `- ${local.name}${local.type ? `: ${local.type}` : ""} = ${local.value}`)
  return [
    ...header,
    `Top frames:\n${frames.length ? frames.join("\n") : "(none)"}`,
    `Locals of ${top?.name ?? "the top frame"}:\n${locals.length ? locals.join("\n") : "(none)"}`,
  ].join("\n\n")
}
