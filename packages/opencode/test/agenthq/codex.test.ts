// Codex through Zed's ACP bridge (codex-acp): detection, the command line Agent HQ runs, and an opt-in free check
// against the real bridge. No test ever sends Codex a prompt: that would spend the owner's ChatGPT quota.
import { describe, expect } from "bun:test"
import type { Client, SessionNotification } from "@agentclientprotocol/sdk"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentProvider } from "../../src/agenthq/provider"
import { AgentDetect } from "../../src/agenthq/providers/detect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node])))

const fixture = path.join(import.meta.dir, "../fixture/agenthq/fake-acp-agent.ts")
const POLICY = [
  "-c",
  'approval_policy="untrusted"',
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  'approvals_reviewer="user"',
]

/**
 * A PATH with a fake `codex` (logged in or not) and, optionally, a fake bridge (`npx` or `codex-acp`) that records how
 * it was started and then runs the scripted ACP agent, which records its session/new params.
 */
const fakePath = (input: { loggedIn: boolean; bridge?: "npx" | "codex-acp"; codex?: boolean }) =>
  Effect.gen(function* () {
    const bin = yield* tmpdirScoped()
    const record = path.join(bin, "record")
    yield* Effect.promise(async () => {
      const script = async (name: string, body: string) => {
        await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`)
        await fs.chmod(path.join(bin, name), 0o755)
      }
      if (input.codex !== false)
        await script(
          "codex",
          [
            'if [ "$1" = "--version" ]; then echo "codex-cli 0.162.1"; exit 0; fi',
            `if [ "$1 $2" = "login status" ]; then echo "Logged in using ChatGPT" >&2; exit ${input.loggedIn ? 0 : 1}; fi`,
            "exit 2",
          ].join("\n"),
        )
      if (input.bridge)
        await script(
          input.bridge,
          [
            `printf '%s\\n' "$@" > '${record}.args'`,
            `printf '%s' "$OPENCODE_SERVER_PASSWORD" > '${record}.password'`,
            `export FAKE_ACP_RECORD='${record}.session.json'`,
            `exec '${process.execPath}' '${fixture}'`,
          ].join("\n"),
        )
    })
    return { bin, record }
  })

const agent = (dir: string): AgentHQ.AgentIdentity => ({
  id: AgentHQ.AgentID.create(),
  name: "Codex",
  avatar: { kind: "preset", value: "robot" },
  provider: "codex",
  projectDirectory: dir,
  createdAt: 0,
  updatedAt: 0,
})

describe("agenthq codex (Zed's ACP bridge)", () => {
  it.live("is available only when codex is installed, logged in, and the bridge can run", () =>
    Effect.gen(function* () {
      const ready = yield* fakePath({ loggedIn: true, bridge: "npx" })
      const status = yield* (yield* AgentDetect.codex({ PATH: ready.bin })).status
      expect(status).toMatchObject({ id: "codex", available: true, auth: "ok", version: "0.162.1" })
      expect(status.capabilities).toMatchObject({ streaming: true, permissionRequests: true, mcpTools: true })

      const loggedOut = yield* fakePath({ loggedIn: false, bridge: "npx" })
      expect(yield* (yield* AgentDetect.codex({ PATH: loggedOut.bin })).status).toMatchObject({
        available: false,
        auth: "required",
        reason: "Codex is not logged in; run `codex login`",
      })

      const noBridge = yield* fakePath({ loggedIn: true })
      expect(yield* (yield* AgentDetect.codex({ PATH: noBridge.bin })).status).toMatchObject({
        available: false,
        auth: "ok",
        reason: "Codex needs Zed's codex-acp bridge: put codex-acp or npx on PATH",
      })

      const missing = yield* fakePath({ loggedIn: true, bridge: "npx", codex: false })
      expect(yield* (yield* AgentDetect.codex({ PATH: missing.bin })).status).toMatchObject({
        available: false,
        auth: "unknown",
        reason: "codex not found on PATH",
      })
    }),
  )

  it.live(
    "starts the pinned bridge with an explicit approval policy and the Workbench server, no secret in its arguments",
    () =>
      Effect.gen(function* () {
        const saved = process.env.OPENCODE_SERVER_PASSWORD
        process.env.OPENCODE_SERVER_PASSWORD = "parent-secret"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (saved === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
            else process.env.OPENCODE_SERVER_PASSWORD = saved
          }),
        )
        const { bin, record } = yield* fakePath({ loggedIn: true, bridge: "npx" })
        const dir = yield* tmpdirScoped()
        const provider = yield* AgentDetect.codex({ PATH: bin })
        const workbench: AgentProvider.McpServer = {
          name: "opencode-workbench",
          command: "/opt/opencode",
          args: ["workbench", "mcp", "--url", "http://127.0.0.1:4096", "--directory", dir],
          env: { OPENCODE_SERVER_TOKEN: "s3cret" },
        }
        const session = yield* provider.createSession({ agent: agent(dir), emit: () => {}, workbench })
        yield* Effect.addFinalizer(() => session.close)
        expect(session.providerSessionID).toBe("fake-session")

        const read = (suffix: string) => Effect.promise(() => fs.readFile(`${record}.${suffix}`, "utf8"))
        const args = (yield* read("args")).trim().split("\n")
        // The pinned bridge through npx, and Codex's approval policy, sandbox and reviewer set explicitly.
        expect(args).toEqual(["-y", "@zed-industries/codex-acp@0.16.0", ...POLICY])
        expect(args.join(" ")).not.toContain("s3cret")
        expect(args.join(" ")).not.toContain("parent-secret")
        // The bridge never gets this server's password; as for every ACP agent it gets a password of its own.
        expect(yield* read("password")).toMatch(/^[0-9a-f-]{36}$/)
        // The Workbench server goes to the bridge in session/new, its token only in its env.
        const created = JSON.parse(yield* read("session.json"))
        expect(created.cwd).toBe(dir)
        expect(created.mcpServers).toEqual([
          {
            name: "opencode-workbench",
            command: "/opt/opencode",
            args: workbench.args,
            env: [{ name: "OPENCODE_SERVER_TOKEN", value: "s3cret" }],
          },
        ])
      }),
  )

  it.live("prefers codex-acp from PATH over npx", () =>
    Effect.gen(function* () {
      const { bin } = yield* fakePath({ loggedIn: true, bridge: "codex-acp" })
      expect(AgentDetect.codexLaunch({ PATH: bin })).toEqual({ command: path.join(bin, "codex-acp"), args: POLICY })
    }),
  )
})

// The free check against the real bridge, opt-in like the real Claude session: it runs Zed's codex-acp (one npx
// download of the pinned version), initializes it, and creates one session with the Workbench MCP server. It never
// sends a prompt.
const realCodex = process.env.SPICY_REAL_CODEX === "status" ? it.live : it.live.skip

describe("agenthq codex (real, opt-in)", () => {
  realCodex(
    "REAL: Zed's codex-acp starts a Codex session with the Workbench MCP server [skipped unless SPICY_REAL_CODEX=status; never sends a prompt]",
    () =>
      Effect.gen(function* () {
        const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = yield* Effect.promise(
          () => import("@agentclientprotocol/sdk"),
        )
        const { resetDatabase } = yield* Effect.promise(() => import("../fixture/db"))
        const { listener } = yield* Effect.promise(() => import("../fixture/agenthq/listener"))
        const { AgentWorkbench } = yield* Effect.promise(() => import("../../src/agenthq/workbench"))
        yield* Effect.acquireRelease(Effect.promise(resetDatabase), () => Effect.promise(resetDatabase))
        yield* listener
        const dir = yield* tmpdirScoped({ git: true })

        const status = yield* (yield* AgentDetect.codex()).status
        const launch = AgentDetect.codexLaunch()!
        // What the manager gives a session in `dir`, plus this test's XDG dirs, so the bridge's Workbench server stays
        // out of the owner's opencode data whatever environment Codex gives it.
        const configured = (yield* AgentWorkbench.server(dir))!
        const isolation = Object.fromEntries(
          ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "OPENCODE_TEST_HOME"].flatMap(
            (key) => (process.env[key] ? [[key, process.env[key]!]] : []),
          ),
        )
        const workbench = { ...configured, env: { ...configured.env, ...isolation } }
        // Only for this check: the bridge stores and looks up credentials in files, never the keychain, so it cannot
        // raise a system prompt. Agent HQ itself passes just the policy.
        const args = [
          ...launch.args,
          "-c",
          'cli_auth_credentials_store="file"',
          "-c",
          'mcp_oauth_credentials_store="file"',
        ]
        const child = Bun.spawn([launch.command, ...args], {
          cwd: dir,
          env: { ...AgentProvider.agentEnv(), OPENCODE_SERVER_PASSWORD: crypto.randomUUID() },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
        const stderr: string[] = []
        void new Response(child.stderr).text().then((text) => stderr.push(text))
        // npx starts the bridge, which starts the Workbench server: stop the whole tree, found before npx exits.
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
          sessionUpdate: async (notification: SessionNotification) =>
            void updates.push(notification.update.sessionUpdate),
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
          240_000,
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "opencode-agenthq", version: "test" },
          }),
        )
        const created = yield* within(
          "session/new",
          120_000,
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
        yield* Effect.sleep("2 seconds")
        // Nothing sensitive: the launch carries no secret, and the Workbench server's env is not printed.
        const evidence = {
          status: { available: status.available, auth: status.auth, version: status.version, reason: status.reason },
          launch: { command: path.basename(launch.command), args: launch.args },
          protocolVersion: initialized.protocolVersion,
          agentInfo: initialized.agentInfo,
          agentCapabilities: initialized.agentCapabilities,
          authMethods: initialized.authMethods?.map((method) => method.id),
          sessionCreated: !!created.sessionId,
          modes: created.modes
            ? {
                current: created.modes.currentModeId,
                available: created.modes.availableModes.map((mode) => mode.id),
              }
            : undefined,
          configOptions: created.configOptions?.map((option) => option.id),
          updates,
        }
        console.log(`SPICY_REAL_CODEX status ${JSON.stringify(evidence)}`)
        expect(status).toMatchObject({ available: true, auth: "ok" })
        expect(created.sessionId).toBeTruthy()
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true)
      }),
    300_000,
  )
})
