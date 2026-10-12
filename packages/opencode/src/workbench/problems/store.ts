import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Context, Effect, Layer, Option, Queue, Stream } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { LspSource } from "./lsp-source"

// A problem before the store stamps its id, origin and observation time. `kind` overrides the
// producer's kind for one problem (a link error inside a compiler run is a build problem).
export type Draft = Omit<Workbench.Problem, "id" | "source" | "observedAt" | "stale"> & {
  readonly kind?: Workbench.SourceKind
}
export type Meta = { kind: Workbench.SourceKind; tool: string }
export type ProducerState = Workbench.ProblemsSnapshot["producers"][number]["state"]
export type Filter = { severity?: Workbench.Severity; source?: Workbench.SourceKind; file?: string }
export type Result = {
  state: ProducerState
  reason?: string
  observedAt: number
  runID?: Workbench.RunID
  // Omitted when the run produced no verdict (timeout, missing tool): the previous problems stay and go stale.
  problems?: ReadonlyArray<Draft>
}

type Slice = {
  meta: Meta
  generation: number
  controller?: AbortController
  state: ProducerState
  reason?: string
  updatedAt: number
  files: Map<string, Workbench.Problem[]> // "" holds problems without a file, such as link errors
}

type State = {
  slices: Map<string, Slice>
  changes: Queue.Queue<{ producer: string; files: string[] }>
}

export interface Interface {
  /** Starts a new generation of a producer. The previous run's signal aborts and its results are dropped. */
  readonly begin: (producer: string, meta: Meta) => Effect.Effect<{ generation: number; signal: AbortSignal }>
  /** Replaces the producer's slice atomically. Returns false when a newer generation already started. */
  readonly finish: (producer: string, generation: number, result: Result) => Effect.Effect<boolean>
  readonly snapshot: (filter?: Filter) => Effect.Effect<Workbench.ProblemsSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchProblems") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("WorkbenchProblems.state")(function* () {
        const s: State = { slices: new Map(), changes: yield* Queue.unbounded<{ producer: string; files: string[] }>() }

        // Coalesce bursts (LSP pushes, parallel runs) into at most one event per 100 ms.
        yield* Effect.gen(function* () {
          const batch = [yield* Queue.take(s.changes)]
          yield* Effect.sleep("100 millis")
          batch.push(...(yield* Queue.clear(s.changes)))
          const files = new Map<string, Set<string>>()
          for (const change of batch) {
            const set = files.get(change.producer) ?? new Set<string>()
            for (const file of change.files) if (file) set.add(file)
            files.set(change.producer, set)
          }
          yield* events.publish(Workbench.Event.ProblemsUpdated, {
            producers: [...files].map(([producer, set]) => ({ producer, files: [...set] })),
            counts: count([...s.slices.values()].flatMap((slice) => [...slice.files.values()].flat())),
          })
        }).pipe(Effect.forever, Effect.forkScoped)

        yield* lsp.diagnosticEvents().pipe(
          Stream.runForEach((event) => Effect.sync(() => replaceFile(s, event))),
          Effect.forkScoped,
        )
        return s
      }),
    )

    const begin = Effect.fn("WorkbenchProblems.begin")(function* (producer: string, meta: Meta) {
      const s = yield* InstanceState.get(state)
      const slice = s.slices.get(producer) ?? emptySlice(meta)
      slice.controller?.abort()
      slice.meta = meta
      slice.generation++
      slice.controller = new AbortController()
      slice.state = "running"
      slice.reason = undefined
      slice.updatedAt = Date.now()
      s.slices.set(producer, slice)
      Queue.offerUnsafe(s.changes, { producer, files: [] })
      return { generation: slice.generation, signal: slice.controller.signal }
    })

    const finish = Effect.fn("WorkbenchProblems.finish")(function* (
      producer: string,
      generation: number,
      result: Result,
    ) {
      const s = yield* InstanceState.get(state)
      const slice = s.slices.get(producer)
      if (!slice || slice.generation !== generation) return false
      const touched = [...slice.files.keys()]
      if (result.problems)
        slice.files = Map.groupBy(stamp(producer, slice.meta, result.problems, result), (item) => item.file ?? "")
      slice.controller = undefined
      slice.state = result.state
      slice.reason = result.reason
      slice.updatedAt = Date.now()
      Queue.offerUnsafe(s.changes, { producer, files: [...touched, ...slice.files.keys()] })
      return true
    })

    const snapshot = Effect.fn("WorkbenchProblems.snapshot")(function* (filter: Filter = {}) {
      const s = yield* InstanceState.get(state)
      const file = filter.file === undefined ? undefined : path.resolve(yield* InstanceState.directory, filter.file)
      const matches = [...s.slices.values()]
        .flatMap((slice) => [...slice.files.values()].flat())
        .filter(
          (item) =>
            (!filter.severity || item.severity === filter.severity) &&
            (!filter.source || item.source.kind === filter.source) &&
            (!file || item.file === file),
        )
      // A problem is stale when its file changed (or vanished) after it was observed.
      const mtimes = new Map(
        yield* Effect.forEach(
          new Set(matches.flatMap((item) => (item.file ? [item.file] : []))),
          (item) =>
            fs.stat(item).pipe(
              Effect.map((info) => [item, Option.getOrUndefined(info.mtime)?.getTime() ?? 0] as const),
              Effect.orElseSucceed(() => [item, Infinity] as const),
            ),
          { concurrency: 16 },
        ),
      )
      const problems = matches.map((item) =>
        item.file ? { ...item, stale: (mtimes.get(item.file) ?? 0) > item.observedAt } : item,
      )
      return {
        problems,
        counts: count(problems),
        producers: [...s.slices].map(([producer, slice]) => ({
          producer,
          kind: slice.meta.kind,
          tool: slice.meta.tool,
          state: slice.state,
          reason: slice.reason,
          updatedAt: slice.updatedAt,
        })),
      } satisfies Workbench.ProblemsSnapshot
    })

    return Service.of({ begin, finish, snapshot })
  }),
)

// LSP updates replace one file of the server's slice; generations are not needed because the
// client delivers them in order.
function replaceFile(s: State, event: Parameters<typeof LspSource.producer>[0]) {
  const producer = LspSource.producer(event)
  const meta = { kind: "lsp" as const, tool: event.serverID }
  const slice = s.slices.get(producer) ?? emptySlice(meta)
  const items = stamp(producer, meta, LspSource.problems(event), { observedAt: event.at })
  if (!items.length && !slice.files.has(event.file) && s.slices.has(producer)) return
  if (items.length) slice.files.set(event.file, items)
  if (!items.length) slice.files.delete(event.file)
  slice.updatedAt = event.at
  s.slices.set(producer, slice)
  Queue.offerUnsafe(s.changes, { producer, files: [event.file] })
}

function emptySlice(meta: Meta): Slice {
  return { meta, generation: 0, state: "idle", updatedAt: Date.now(), files: new Map() }
}

function stamp(
  producer: string,
  meta: Meta,
  drafts: ReadonlyArray<Draft>,
  origin: { observedAt: number; runID?: Workbench.RunID },
): Workbench.Problem[] {
  const seen = new Set<string>()
  return drafts.flatMap(({ kind, ...draft }) => {
    const id = Hash.fast(
      JSON.stringify([producer, draft.file ?? "", draft.code ?? "", draft.message, draft.range?.start.line ?? -1]),
    ).slice(0, 16)
    if (seen.has(id)) return []
    seen.add(id)
    return [
      {
        ...draft,
        id,
        source: { kind: kind ?? meta.kind, tool: meta.tool, producer, runID: origin.runID },
        observedAt: origin.observedAt,
        stale: false,
      },
    ]
  })
}

export function count(problems: ReadonlyArray<Pick<Workbench.Problem, "severity">>): Workbench.ProblemCounts {
  return {
    error: problems.filter((item) => item.severity === "error").length,
    warning: problems.filter((item) => item.severity === "warning").length,
    info: problems.filter((item) => item.severity === "info").length,
    hint: problems.filter((item) => item.severity === "hint").length,
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, LSP.node, FSUtil.node],
})

export * as WorkbenchProblems from "./store"
