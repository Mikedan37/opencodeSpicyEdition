import { describe, expect } from "bun:test"
import { utimes } from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { WorkbenchProblems } from "@/workbench/problems/store"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        WorkbenchProblems.node,
        LSP.node,
        Config.node,
        RuntimeFlags.node,
        EventV2Bridge.node,
        FSUtil.node,
      ]),
    ),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)

const fakeServer = path.join(__dirname, "../fixture/workbench/lsp-push-pull.js")
const meta = { kind: "typecheck" as const, tool: "test" }
const error = (file: string, message: string) => ({ file, severity: "error" as const, message, code: "T1" })

describe("workbench problem store", () => {
  it.instance(
    "DIAG-01 push and pull of the same error show one problem that lists both, and a checker joins it",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const problems = yield* WorkbenchProblems.Service
        const file = path.join(dir, "sample.repro")
        const producer = `lsp:fake:${dir}`
        yield* Effect.promise(() => Bun.write(file, "const thing = 1\n"))
        yield* lsp.touchFile(file, "document")

        // wait until the store has seen both channels
        const snapshot = yield* pollWithTimeout(
          problems
            .snapshot({ file })
            .pipe(
              Effect.map((result) =>
                result.problems.flatMap((item) => item.sources ?? []).length >= 2 ? result : undefined,
              ),
            ),
          "LSP problem never reached the store by push and pull",
        )
        expect(snapshot.problems).toHaveLength(1)
        expect(snapshot.problems[0]).toMatchObject({
          file,
          severity: "error",
          message: "planted error",
          code: "E100",
          codeHref: "https://example.com/E100",
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          source: { kind: "lsp", tool: "fake", producer, channel: "push" },
          sources: [
            { kind: "lsp", tool: "fake", producer, channel: "push" },
            { kind: "lsp", tool: "fake", producer, channel: "pull" },
          ],
          stale: false,
        })
        expect(snapshot.counts).toEqual({ error: 1, warning: 0, info: 0, hint: 0 })
        expect(snapshot.producers).toContainEqual(expect.objectContaining({ producer, kind: "lsp", state: "idle" }))
        expect(snapshot.lsp).toBe("on")
        // Both channels really carried the error: pushed after didOpen, pulled by textDocument/diagnostic.
        const methods = (yield* Effect.promise(() => Bun.file(path.join(dir, "lsp-methods.log")).text())).split("\n")
        expect(methods).toContain("textDocument/didOpen")
        expect(methods).toContain("textDocument/diagnostic")

        // A checker reporting the same error (other column, code and capitalization) joins that problem; its error
        // on another line stays separate.
        const run = yield* problems.begin("check:test:sample", meta)
        yield* problems.finish("check:test:sample", run.generation, {
          state: "idle",
          observedAt: Date.now(),
          problems: [
            {
              ...error(file, "Planted error"),
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            },
            {
              ...error(file, "planted error"),
              range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
            },
          ],
        })
        const merged = yield* problems.snapshot({ file })
        expect(
          merged.problems.map((item) => [
            item.range?.start.line,
            item.sources?.map((source) => [source.producer, source.channel]),
          ]),
        ).toEqual([
          [
            0,
            [
              [producer, "push"],
              [producer, "pull"],
              ["check:test:sample", undefined],
            ],
          ],
          [3, [["check:test:sample", undefined]]],
        ])
        expect(merged.problems[0]).toMatchObject({ code: "E100", source: { producer, channel: "push" } })
        expect(merged.counts).toEqual({ error: 2, warning: 0, info: 0, hint: 0 })
      }),
    {
      config: {
        lsp: {
          fake: {
            command: [process.execPath, fakeServer],
            extensions: [".repro"],
            env: { FAKE_LSP_LOG: "lsp-methods.log" },
          },
        },
      },
    },
  )

  it.instance(
    "DIAG-07 a crashed language server's problems stay, marked stale, until the restarted server reports",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const problems = yield* WorkbenchProblems.Service
        const file = path.join(dir, "sample.repro")
        const producer = `lsp:fake:${dir}`
        yield* Effect.promise(() => Bun.write(file, "const thing = 1\n"))
        yield* lsp.touchFile(file, "document")
        yield* pollWithTimeout(
          problems.snapshot({ file }).pipe(Effect.map((result) => (result.problems.length ? true : undefined))),
          "LSP problem never reached the store",
        )

        // the server exits on this change
        yield* Effect.promise(() => Bun.write(file, "CRASH\n"))
        yield* lsp.touchFile(file, "document")
        yield* pollWithTimeout(
          problems
            .snapshot({ file })
            .pipe(
              Effect.map((result) => (result.producers.some((item) => item.state === "failed") ? true : undefined)),
            ),
          "the crash never reached the store",
        )
        // backdate the file so only the crash can make its problem stale
        const past = new Date(Date.now() - 60_000)
        yield* Effect.promise(() => utimes(file, past, past))
        const crashed = yield* problems.snapshot({ file })
        expect(crashed.problems.map((item) => [item.message, item.stale])).toEqual([["planted error", true]])
        expect(crashed.producers).toContainEqual(
          expect.objectContaining({ producer, state: "failed", reason: expect.stringContaining("exited") }),
        )
        expect(yield* lsp.status()).toContainEqual(expect.objectContaining({ id: "fake", status: "error" }))

        // after its backoff the server restarts on a touch and reports again: the problem is fresh
        yield* Effect.promise(() => Bun.write(file, "const thing = 2\n"))
        const fresh = yield* pollWithTimeout(
          lsp.touchFile(file, "document").pipe(
            Effect.andThen(problems.snapshot({ file })),
            Effect.map((result) => (result.problems.length === 1 && !result.problems[0].stale ? result : undefined)),
          ),
          "the restarted server never replaced the stale problem",
          "10 seconds",
        )
        expect(fresh.producers).toContainEqual(expect.objectContaining({ producer, state: "idle" }))
        expect(yield* lsp.status()).toContainEqual(expect.objectContaining({ id: "fake", status: "connected" }))
      }),
    { config: { lsp: { fake: { command: [process.execPath, fakeServer], extensions: [".repro"] } } } },
    20_000,
  )

  it.instance(
    "DIAG-07 a store first used after the crash replays the crashed server's last report as stale",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const file = path.join(dir, "sample.repro")
        // the server reports and crashes before anything reads the store
        yield* Effect.promise(() => Bun.write(file, "const thing = 1\n"))
        yield* lsp.touchFile(file, "document")
        yield* Effect.promise(() => Bun.write(file, "CRASH\n"))
        yield* lsp.touchFile(file, "document")
        const past = new Date(Date.now() - 60_000)
        yield* Effect.promise(() => utimes(file, past, past))

        const problems = yield* WorkbenchProblems.Service
        const snapshot = yield* pollWithTimeout(
          problems.snapshot({ file }).pipe(Effect.map((result) => (result.problems.length ? result : undefined))),
          "the crashed server's report was not replayed",
        )
        expect(snapshot.problems.map((item) => [item.message, item.stale])).toEqual([["planted error", true]])
        expect(snapshot.producers).toContainEqual(
          expect.objectContaining({ producer: `lsp:fake:${dir}`, state: "failed" }),
        )
      }),
    { config: { lsp: { fake: { command: [process.execPath, fakeServer], extensions: [".repro"] } } } },
    20_000,
  )

  it.instance("DIAG-02 editing a file marks its problems stale until a new result arrives", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const problems = yield* WorkbenchProblems.Service
      const file = path.join(dir, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "one\n"))
      // mtime resolution: make sure the observation is strictly after the write
      yield* Effect.sleep("20 millis")

      const first = yield* problems.begin("check:test:a", meta)
      yield* problems.finish("check:test:a", first.generation, {
        state: "idle",
        observedAt: Date.now(),
        problems: [error(file, "first")],
      })
      expect((yield* problems.snapshot()).problems.map((item) => item.stale)).toEqual([false])

      yield* Effect.sleep("20 millis")
      yield* Effect.promise(() => Bun.write(file, "two\n"))
      expect((yield* problems.snapshot()).problems.map((item) => item.stale)).toEqual([true])

      yield* Effect.sleep("20 millis")
      const second = yield* problems.begin("check:test:a", meta)
      yield* problems.finish("check:test:a", second.generation, {
        state: "idle",
        observedAt: Date.now(),
        problems: [error(file, "second")],
      })
      const fresh = yield* problems.snapshot()
      expect(fresh.problems.map((item) => [item.message, item.stale])).toEqual([["second", false]])
    }),
  )

  it.instance("DIAG-03 a newer run of the same producer cancels the older one and drops its results", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const problems = yield* WorkbenchProblems.Service
      const file = path.join(dir, "b.ts")
      yield* Effect.promise(() => Bun.write(file, "b\n"))

      const older = yield* problems.begin("check:test:b", meta)
      const newer = yield* problems.begin("check:test:b", meta)
      expect(older.signal.aborted).toBe(true)
      expect(newer.signal.aborted).toBe(false)
      expect(newer.generation).toBeGreaterThan(older.generation)

      const at = Date.now() + 1000
      expect(
        yield* problems.finish("check:test:b", older.generation, {
          state: "idle",
          observedAt: at,
          problems: [error(file, "old")],
        }),
      ).toBe(false)
      expect(
        yield* problems.finish("check:test:b", newer.generation, {
          state: "idle",
          observedAt: at,
          problems: [error(file, "new")],
        }),
      ).toBe(true)

      const snapshot = yield* problems.snapshot()
      expect(snapshot.problems.map((item) => item.message)).toEqual(["new"])
      expect(snapshot.problems[0].source.producer).toBe("check:test:b")
      expect(snapshot.producers.find((item) => item.producer === "check:test:b")?.state).toBe("idle")
    }),
  )

  it.instance("DIAG-04 the problems event carries the project directory and reaches its listener", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const problems = yield* WorkbenchProblems.Service
      const events = yield* EventV2Bridge.Service
      const located: (string | undefined)[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Workbench.Event.ProblemsUpdated.type) located.push(event.location?.directory)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const received = yield* waitGlobalBusEvent({
        message: "workbench.problems.updated never reached the project's listener",
        predicate: (event) =>
          event.directory === dir &&
          event.payload.type === "workbench.problems.updated" &&
          JSON.stringify(event.payload.properties).includes("c.ts"),
      }).pipe(Effect.forkScoped)

      const file = path.join(dir, "c.ts")
      const run = yield* problems.begin("check:test:c", meta)
      yield* problems.finish("check:test:c", run.generation, {
        state: "idle",
        observedAt: Date.now(),
        problems: [error(file, "c")],
      })

      const event = yield* Fiber.join(received)
      expect(event.payload.properties).toMatchObject({
        producers: [{ producer: "check:test:c", files: [file] }],
        counts: { error: 1, warning: 0, info: 0, hint: 0 },
      })
      // EventV2 listeners run after the bridge's own GlobalBus forwarder, so wait for ours.
      yield* pollWithTimeout(
        Effect.sync(() => (located.length ? true : undefined)),
        "workbench.problems.updated never reached the EventV2 listener",
      )
      expect(new Set(located)).toEqual(new Set([dir]))
    }),
  )
})
