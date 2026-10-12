// AgentKit through its bridge's ACP mode (`agentkit-bridge acp`): detection, and an opt-in free check against the
// real bridge. The scripted end-to-end run under the agentkit provider is AHQ-15 in agenthq.test.ts. No test sends
// AgentKit a prompt.
import { describe, expect } from "bun:test"
import type { Client } from "@agentclientprotocol/sdk"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { which } from "@opencode-ai/core/util/which"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentProvider } from "../../src/agenthq/provider"
import { AgentDetect } from "../../src/agenthq/providers/detect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node])))

/** A PATH holding only a fake `agentkit-bridge` with this body, or nothing. */
const fakePath = (body?: string) =>
  Effect.gen(function* () {
    const bin = yield* tmpdirScoped()
    if (body)
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(bin, "agentkit-bridge"), `#!/bin/sh\n${body}\n`)
        await fs.chmod(path.join(bin, "agentkit-bridge"), 0o755)
      })
    return bin
  })

describe("agenthq agentkit (agentkit-bridge acp)", () => {
  it.live("is available only when agentkit-bridge on PATH has an ACP mode", () =>
    Effect.gen(function* () {
      const withAcp = yield* fakePath(
        [
          'if [ "$1 $2" = "acp --help" ]; then echo "Usage: agentkit-bridge acp  (serve AgentKit over ACP on stdio)"; exit 0; fi',
          "exit 2",
        ].join("\n"),
      )
      const ready = yield* (yield* AgentDetect.agentkit({ PATH: withAcp })).status
      expect(ready).toMatchObject({ id: "agentkit", name: "AgentKit", available: true, auth: "unknown" })
      expect(ready.capabilities).toMatchObject({
        streaming: true,
        permissionRequests: true,
        cancel: true,
        mcpTools: true,
      })

      // A bridge from before the ACP mode: `acp` is an unknown command.
      const withoutAcp = yield* fakePath(
        [
          'if [ "$1" = "--help" ]; then echo "Usage: agentkit-bridge serve"; exit 0; fi',
          'echo "unknown command: $1" >&2',
          "exit 2",
        ].join("\n"),
      )
      expect(yield* (yield* AgentDetect.agentkit({ PATH: withoutAcp })).status).toMatchObject({
        available: false,
        reason: "this AgentKit bridge has no ACP mode yet",
      })

      const missing = yield* fakePath()
      const absent = yield* AgentDetect.agentkit({ PATH: missing })
      expect(yield* absent.status).toMatchObject({ available: false, reason: "AgentKit bridge not found" })
      // Without a bridge, an identity without a launch command cannot start, and says why.
      const dir = yield* tmpdirScoped()
      const failure = yield* absent
        .createSession({
          agent: {
            id: "agt_kit" as never,
            name: "Kit",
            avatar: { kind: "initials", value: "K" },
            provider: "agentkit",
            projectDirectory: dir,
            createdAt: 0,
            updatedAt: 0,
          },
          emit: () => {},
        })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "AgentHQ.UnsupportedError", message: "AgentKit bridge not found" })
    }),
  )
})

// The free check against the real bridge, opt-in like the real Claude and Codex checks: initialize and one session/new
// with the Workbench MCP server of a password-protected listener, never a prompt. It is skipped, and says why, while no
// agentkit-bridge is on PATH.
const installed = which(AgentDetect.AGENTKIT_BRIDGE, { PATH: process.env.PATH ?? "" }) ?? undefined
const realAgentKit = process.env.SPICY_REAL_AGENTKIT === "status" && installed ? it.live : it.live.skip

describe("agenthq agentkit (real, opt-in)", () => {
  realAgentKit(
    `REAL: agentkit-bridge acp starts a session with the Workbench MCP server [${installed ? "skipped unless SPICY_REAL_AGENTKIT=status" : "skipped: no agentkit-bridge on PATH yet"}; never sends a prompt]`,
    () =>
      Effect.gen(function* () {
        const status = yield* (yield* AgentDetect.agentkit()).status
        // A bridge without an ACP mode fails here with its reason.
        expect(status).toMatchObject({ available: true })
        const bin = installed!
        const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = yield* Effect.promise(
          () => import("@agentclientprotocol/sdk"),
        )
        const { resetDatabase } = yield* Effect.promise(() => import("../fixture/db"))
        const { listener } = yield* Effect.promise(() => import("../fixture/agenthq/listener"))
        const { AgentWorkbench } = yield* Effect.promise(() => import("../../src/agenthq/workbench"))
        yield* Effect.acquireRelease(Effect.promise(resetDatabase), () => Effect.promise(resetDatabase))
        yield* listener
        const dir = yield* tmpdirScoped({ git: true })
        const workbench = (yield* AgentWorkbench.server(dir))!

        // As the ACP adapter starts it: no server credentials, a password of its own.
        const child = Bun.spawn([bin, "acp"], {
          cwd: dir,
          env: { ...AgentProvider.agentEnv(), OPENCODE_SERVER_PASSWORD: crypto.randomUUID() },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
        const stderr: string[] = []
        void new Response(child.stderr).text().then((text) => stderr.push(text))
        // Stop the whole tree the bridge starts, found before it exits.
        const tree = (pid: number): number[] =>
          Bun.spawnSync(["pgrep", "-P", String(pid)])
            .stdout.toString()
            .split("\n")
            .filter(Boolean)
            .map(Number)
            .flatMap((kid) => [kid, ...tree(kid)])
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const all = tree(child.pid)
            child.stdin.end()
            for (const pid of all.toReversed()) Bun.spawnSync(["kill", String(pid)])
            child.kill()
            await child.exited
          }),
        )

        const updates: string[] = []
        const client: Client = {
          sessionUpdate: async (notification) => void updates.push(notification.update.sessionUpdate),
          // No prompt is sent, so nothing can ask; anything that did would be refused.
          requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        }
        const connection = new ClientSideConnection(
          () => client,
          ndJsonStream(
            new WritableStream<Uint8Array>({
              write: (chunk) => {
                child.stdin.write(chunk)
                child.stdin.flush()
              },
            }),
            child.stdout,
          ),
        )
        const within = <A>(what: string, ms: number, promise: Promise<A>) =>
          Effect.promise(() =>
            Promise.race([
              promise,
              Bun.sleep(ms).then(() => {
                throw new Error(`${what} timed out; bridge stderr: ${stderr.join("").slice(-2000)}`)
              }),
            ]),
          )
        const initialized = yield* within(
          "initialize",
          60_000,
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "opencode-agenthq", version: "test" },
          }),
        )
        const created = yield* within(
          "session/new",
          60_000,
          connection.newSession({
            cwd: dir,
            mcpServers: [
              {
                name: workbench.name,
                command: workbench.command,
                args: [...workbench.args],
                env: Object.entries(workbench.env).map(([name, value]) => ({ name, value })),
              },
            ],
          }),
        )
        yield* Effect.sleep("1 second")
        // Nothing sensitive: the Workbench server's env is not printed.
        console.log(
          `SPICY_REAL_AGENTKIT status ${JSON.stringify({
            bridge: bin,
            protocolVersion: initialized.protocolVersion,
            agentInfo: initialized.agentInfo,
            agentCapabilities: initialized.agentCapabilities,
            authMethods: initialized.authMethods?.map((method) => method.id),
            sessionCreated: !!created.sessionId,
            modes: created.modes?.availableModes.map((mode) => mode.id),
            updates,
          })}`,
        )
        expect(created.sessionId).toBeTruthy()
      }),
    120_000,
  )
})
