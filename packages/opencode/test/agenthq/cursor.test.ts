// Cursor through its ACP mode (`cursor-agent acp`): detection by the hidden `acp` subcommand, the launch (nothing but
// `acp` on its command line, a config folder of Agent HQ's with an empty allowlist), a Cursor that is not logged in,
// and the free opt-in real check.
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { AgentDetect } from "../../src/agenthq/providers/detect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node])))

const FIXTURE = path.join(import.meta.dir, "../fixture/agenthq/fake-acp-agent.ts")
const ACP_USAGE = "Usage: agent acp [options]\n\nStart the Cursor Agent as an ACP (Agent Client Protocol) server"
const TOP_USAGE = "Usage: cursor-agent [options] [command] [prompt...]\n\nStart the Cursor Agent"

/** A fake CLI in `dir` named `name`: `--version` prints `version`, `acp --help` prints `acpHelp` (else the top help). */
const fake = (dir: string, name: string, version: string, acpHelp?: string, extra: string[] = []) =>
  Effect.promise(async () => {
    const bin = path.join(dir, name)
    await fs.writeFile(
      bin,
      [
        "#!/bin/sh",
        ...extra,
        `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
        acpHelp ? `if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then printf '%s\\n' '${acpHelp}'; exit 0; fi` : "",
        `printf '%s\\n' '${TOP_USAGE}'`,
      ].join("\n"),
    )
    await fs.chmod(bin, 0o755)
    return bin
  })

const kit = (projectDirectory: string): AgentHQ.AgentIdentity => ({
  id: AgentHQ.AgentID.create(),
  name: "Cur",
  avatar: { kind: "initials", value: "C" },
  provider: "cursor",
  projectDirectory,
  createdAt: 0,
  updatedAt: 0,
})

describe("agenthq cursor (cursor-agent acp)", () => {
  it.live("finds cursor-agent by its hidden acp subcommand; an old one says to update; a bare agent is ignored", () =>
    Effect.gen(function* () {
      const bin = yield* tmpdirScoped()
      const status = (env: AgentDetect.CursorEnv) =>
        Effect.gen(function* () {
          return yield* (yield* AgentDetect.cursor(env)).status
        })
      // A bare `agent` (here: someone else's tool that even claims ACP) is never Cursor.
      yield* fake(bin, "agent", "1.0.0", ACP_USAGE)
      expect(yield* status({ PATH: bin })).toMatchObject({ available: false, reason: "cursor-agent not found on PATH" })

      // Before the ACP mode: `acp --help` is only the top-level help.
      yield* fake(bin, "cursor-agent", "2025.09.12-4852336")
      expect(yield* status({ PATH: bin })).toMatchObject({
        available: false,
        version: "2025.09.12-4852336",
        reason: "This cursor-agent (2025.09.12) has no ACP mode; update the Cursor CLI",
      })

      // With it; the top-level help never lists `acp`.
      yield* fake(bin, "cursor-agent", "2026.10.01-e373342", ACP_USAGE)
      expect(yield* status({ PATH: bin })).toMatchObject({ available: true, version: "2026.10.01-e373342" })

      // OPENCODE_CURSOR_AGENT alone when set: a build outside PATH is found, and one that is not there is not
      // replaced by the one on PATH.
      const elsewhere = yield* tmpdirScoped()
      const build = yield* fake(elsewhere, "cursor-agent", "2026.10.02-abc", ACP_USAGE)
      expect(yield* status({ PATH: "", OPENCODE_CURSOR_AGENT: build })).toMatchObject({
        available: true,
        version: "2026.10.02-abc",
      })
      expect(yield* status({ PATH: bin, OPENCODE_CURSOR_AGENT: path.join(elsewhere, "gone") })).toMatchObject({
        available: false,
        reason: "OPENCODE_CURSOR_AGENT does not point to a file",
      })
    }),
  )

  it.live("starts only `cursor-agent acp`, with a config folder of Agent HQ's whose allowlist is empty", () =>
    Effect.gen(function* () {
      const bin = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped()
      const record = path.join(bin, "record")
      yield* fake(bin, "cursor-agent", "2026.10.01-e373342", ACP_USAGE, [
        `if [ "$1" = "acp" ] && [ "$2" != "--help" ]; then`,
        `  printf '%s\\n' "$@" > '${record}.args'`,
        `  printf '%s' "$CURSOR_CONFIG_DIR" > '${record}.config'`,
        `  export FAKE_ACP_RECORD='${record}.session.json'`,
        `  exec '${process.execPath}' '${FIXTURE}'`,
        "fi",
      ])
      const provider = yield* AgentDetect.cursor({ PATH: bin })
      const session = yield* provider.createSession({ agent: kit(dir), emit: () => {} })
      yield* Effect.addFinalizer(() => session.close)
      const read = (suffix: string) => Effect.promise(() => fs.readFile(`${record}.${suffix}`, "utf8"))

      // Nothing but `acp`: never --force, --yolo, --auto-review, --approve-mcps or --trust.
      expect((yield* read("args")).trim()).toBe("acp")
      expect(JSON.parse(yield* read("session.json")).cwd).toBe(dir)
      const config = yield* read("config")
      expect(config).toBe(AgentDetect.cursorConfig())
      const settings = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(config, "cli-config.json"), "utf8")),
      )
      expect(settings.permissions).toEqual({ allow: [], deny: [] })
    }),
  )

  it.live("waits for a slow cursor-agent, asks it once per binary, and a session start reuses the answer", () =>
    Effect.gen(function* () {
      const bin = yield* tmpdirScoped()
      const runs = path.join(bin, "runs")
      const slow = path.join(bin, "slow")
      // Slower than the old 5-second probe limit, as the real CLI is under load.
      yield* Effect.promise(() => fs.writeFile(slow, ""))
      const cli = yield* fake(bin, "cursor-agent", "2026.10.01-e373342", ACP_USAGE, [
        `echo "$*" >> '${runs}'`,
        `if [ -e '${slow}' ] && [ "$1" = "acp" ] && [ "$2" = "--help" ]; then sleep 6; fi`,
        `if [ "$1" = "acp" ] && [ "$2" != "--help" ]; then exec '${process.execPath}' '${FIXTURE}'; fi`,
      ])
      const asked = Effect.promise(() =>
        fs.readFile(runs, "utf8").then((text) => text.split("\n").filter(Boolean).toSorted()),
      )
      const provider = yield* AgentDetect.cursor({ PATH: bin })
      expect(yield* provider.status).toMatchObject({ available: true, version: "2026.10.01-e373342" })
      expect(yield* asked).toEqual(["--version", "acp --help"])
      // Listed again and started: the same binary is not asked again; the session only runs `acp`.
      expect(yield* provider.status).toMatchObject({ available: true })
      const session = yield* provider.createSession({ agent: kit(yield* tmpdirScoped()), emit: () => {} })
      yield* Effect.addFinalizer(() => session.close)
      expect(yield* asked).toEqual(["--version", "acp", "acp --help"])
      // A changed binary is asked again.
      yield* Effect.promise(async () => {
        await fs.rm(slow)
        await fs.utimes(cli, new Date(), new Date(Date.now() + 1000))
      })
      expect(yield* provider.status).toMatchObject({ available: true })
      expect(yield* asked).toEqual(["--version", "--version", "acp", "acp --help", "acp --help"])
    }),
  )

  it.live("a Cursor that is not logged in: the start says to run cursor-agent login, and nothing logs in", () =>
    Effect.gen(function* () {
      const bin = yield* tmpdirScoped()
      const record = path.join(bin, "record")
      yield* fake(bin, "cursor-agent", "2026.10.01-e373342", ACP_USAGE, [
        `if [ "$1" = "acp" ] && [ "$2" != "--help" ]; then`,
        `  export FAKE_ACP_RECORD='${record}' FAKE_ACP_AUTH_REQUIRED=1`,
        `  exec '${process.execPath}' '${FIXTURE}'`,
        "fi",
      ])
      const provider = yield* AgentDetect.cursor({ PATH: bin })
      const failure = yield* provider
        .createSession({ agent: kit(yield* tmpdirScoped()), emit: () => {} })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ message: "Cursor is not logged in; run `cursor-agent login`" })
      // authenticate would make Cursor open a browser login; it is never called.
      expect(existsSync(`${record}.authenticate`)).toBe(false)
    }),
  )
})

// The free real check: initialize + session/new with the owner's existing Cursor login, no prompt, never a login.
// OPENCODE_CURSOR_AGENT names the build to check.
const realStatus = process.env.SPICY_REAL_CURSOR === "status" ? it.live : it.live.skip

describe("agenthq cursor (real, opt-in)", () => {
  realStatus(
    "REAL: cursor-agent acp starts a session with the owner's Cursor login [skipped unless SPICY_REAL_CURSOR=status; no prompt]",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const provider = yield* AgentDetect.cursor()
        const status = yield* provider.status
        const started = Date.now()
        const result = yield* provider.createSession({ agent: kit(dir), emit: () => {} }).pipe(
          Effect.flatMap((session) =>
            session.close.pipe(Effect.as({ sessionNew: "ok", providerSessionID: session.providerSessionID })),
          ),
          Effect.catch((error) => Effect.succeed({ sessionNew: "failed", message: error.message })),
        )
        const config = AgentDetect.cursorConfig()
        const settings = yield* Effect.promise(() =>
          fs.readFile(path.join(config, "cli-config.json"), "utf8").then(JSON.parse),
        )
        console.log(
          `SPICY_REAL_CURSOR status ${JSON.stringify({
            available: status.available,
            version: status.version,
            reason: status.reason,
            ms: Date.now() - started,
            ...result,
            allowlistAfter: settings.permissions,
          })}`,
        )
        expect(status.available).toBe(true)
        // The check is for a real session: anything short of one fails it.
        expect(result).toMatchObject({ sessionNew: "ok" })
      }),
    120_000,
  )
})
