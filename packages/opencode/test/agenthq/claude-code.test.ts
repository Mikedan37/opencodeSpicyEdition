import { describe, expect } from "bun:test"
import type { McpServerConfig, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Effect } from "effect"
import { readFileSync } from "fs"
import type { AgentProvider } from "../../src/agenthq/provider"
import { ClaudeCodeProvider } from "../../src/agenthq/providers/claude-code"
import { AgentDetect } from "../../src/agenthq/providers/detect"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node])))

const available: AgentHQ.ProviderStatus = {
  id: "claude-code",
  name: "Claude Code",
  available: true,
  version: "2.1.296",
  auth: "unknown",
  capabilities: ClaudeCodeProvider.capabilities,
}

// The SDK's message types carry many transport fields the adapter never reads; tests build only what it reads.
const sdk = (value: object) => value as SDKMessage

/** A scripted stand-in for the SDK's `query()`: the user message text picks the script. */
function scripted(mcpErrors: Record<string, string> = {}) {
  const seen = {
    options: undefined as Options | undefined,
    closed: false,
    interrupts: 0,
    decisions: [] as PermissionResult[],
    mcp: [] as Record<string, McpServerConfig>[],
  }
  const run: ClaudeCodeProvider.Run = (params) => {
    seen.options = params.options
    let release: (() => void) | undefined
    const stream = (event: object) => sdk({ type: "stream_event", event, parent_tool_use_id: null })
    async function* messages(): AsyncGenerator<SDKMessage> {
      for await (const user of params.prompt) {
        const text = typeof user.message.content === "string" ? user.message.content : ""
        const result = (fields: object) =>
          sdk({
            type: "result",
            subtype: "success",
            is_error: false,
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
            total_cost_usd: 0.0012,
            user_message_uuid: user.uuid,
            ...fields,
          })
        if (text === "stream") {
          yield stream({ type: "message_start", message: { id: "msg_1" } })
          yield stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
          yield stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })
          yield stream({ type: "content_block_stop", index: 0 })
          yield stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
          yield stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "po" } })
          yield stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ng" } })
          yield stream({ type: "content_block_stop", index: 1 })
          // The complete message repeats what was streamed; it must not be emitted twice.
          yield sdk({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              id: "msg_1",
              content: [
                { type: "thinking", thinking: "hmm" },
                { type: "text", text: "pong" },
              ],
            },
          })
          yield result({})
        }
        if (text === "edit") {
          const input = { file_path: "/tmp/agenthq-a.ts", old_string: "a", new_string: "b" }
          const decision = await params.options.canUseTool!("Edit", input, {
            signal: new AbortController().signal,
            toolUseID: "toolu_1",
            requestId: "req_1",
            suggestions: [
              { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "localSettings" },
              { type: "setMode", mode: "acceptEdits", destination: "session" },
            ],
          })
          seen.decisions.push(decision ?? { behavior: "deny", message: "null" })
          const allowed = decision?.behavior === "allow"
          yield sdk({
            type: "assistant",
            parent_tool_use_id: null,
            message: { id: "msg_2", content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input }] },
          })
          yield sdk({
            type: "user",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: allowed ? "edited" : "denied",
                  is_error: !allowed,
                },
              ],
            },
          })
          yield result({})
        }
        if (text === "hang") {
          await new Promise<void>((resolve) => (release = resolve))
          yield result({ subtype: "error_during_execution", is_error: true, errors: ["interrupted"] })
        }
        if (text === "crash") throw new Error("claude exited with code 1")
      }
    }
    const iterator = messages()
    return Object.assign(iterator, {
      interrupt: async () => {
        seen.interrupts++
        release?.()
        return undefined
      },
      close: () => {
        seen.closed = true
      },
      setMcpServers: async (servers: Record<string, McpServerConfig>) => {
        seen.mcp.push(servers)
        return { added: Object.keys(servers), removed: [], errors: mcpErrors }
      },
    })
  }
  return { run, seen }
}

const agent = (dir: string, model?: string): AgentHQ.AgentIdentity => ({
  id: AgentHQ.AgentID.create(),
  name: "Claude",
  avatar: { kind: "preset", value: "owl" },
  provider: "claude-code",
  projectDirectory: dir,
  ...(model ? { model } : {}),
  createdAt: 0,
  updatedAt: 0,
})

const start = (input: {
  run?: ClaudeCodeProvider.Run
  status?: AgentHQ.ProviderStatus
  resume?: string
  model?: string
  workbench?: AgentProvider.McpServer
}) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const events: AgentHQ.AgentEvent[] = []
    const provider = yield* ClaudeCodeProvider.make({
      status: Effect.succeed(input.status ?? available),
      binary: () => "/opt/fake/claude",
      ...(input.run ? { run: input.run } : {}),
    })
    const emit = (event: AgentHQ.AgentEvent) => void events.push(event)
    const base = { agent: agent(dir, input.model), emit, ...(input.workbench ? { workbench: input.workbench } : {}) }
    const session = input.resume
      ? yield* provider.resumeSession({ ...base, providerSessionID: input.resume })
      : yield* provider.createSession(base)
    yield* Effect.addFinalizer(() => session.close)
    return { dir, events, session }
  })

const bridge = (directory: string): AgentProvider.McpServer => ({
  name: "opencode-workbench",
  command: "/opt/opencode",
  args: ["workbench", "mcp", "--url", "http://127.0.0.1:4096", "--directory", directory],
  env: { OPENCODE_SERVER_TOKEN: "s3cret" },
})

const waitFor = <A>(
  events: AgentHQ.AgentEvent[],
  pick: (events: AgentHQ.AgentEvent[]) => A | undefined,
  message: string,
) =>
  pollWithTimeout(
    Effect.sync(() => pick(events)),
    message,
  )

const ofType = <T extends AgentHQ.AgentEvent["type"]>(events: AgentHQ.AgentEvent[], type: T) =>
  events.flatMap((event) => (event.type === type ? [event as Extract<AgentHQ.AgentEvent, { type: T }>] : []))

describe("agenthq claude code adapter (scripted SDK)", () => {
  it.live("runs isolated: installed binary, no owner settings or MCP, manual permissions, own session id", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run, model: "haiku" })
      const options = fake.seen.options!
      expect(started.session.providerSessionID).toMatch(/^[0-9a-f-]{36}$/)
      expect(options).toMatchObject({
        cwd: started.dir,
        pathToClaudeCodeExecutable: "/opt/fake/claude",
        sessionId: started.session.providerSessionID,
        model: "haiku",
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "default",
        includePartialMessages: true,
      })
      // No MCP server at all without a Workbench bridge.
      expect(options.mcpServers).toBeUndefined()
      expect(fake.seen.mcp).toEqual([])
      expect(options.resume).toBeUndefined()
      expect(options.allowDangerouslySkipPermissions).toBeUndefined()
      expect(typeof options.canUseTool).toBe("function")
    }),
  )

  it.live("gets the Workbench MCP server over the control channel, never on the claude command line", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const workbench = bridge("/projects/app")
      const started = yield* start({ run: fake.run, workbench })
      // Connected before createSession returns, so the first message already has the tools.
      expect(fake.seen.mcp).toEqual([
        {
          "opencode-workbench": {
            type: "stdio",
            command: "/opt/opencode",
            args: ["workbench", "mcp", "--url", "http://127.0.0.1:4096", "--directory", "/projects/app"],
            env: { OPENCODE_SERVER_TOKEN: "s3cret" },
          },
        },
      ])
      // `options` become the claude command line: no MCP config and no secret there.
      expect(fake.seen.options!.mcpServers).toBeUndefined()
      expect(JSON.stringify(fake.seen.options)).not.toContain("s3cret")
      expect(started.events).toEqual([])

      // Resuming gives the resumed session the same server.
      yield* start({ run: fake.run, workbench, resume: started.session.providerSessionID })
      expect(fake.seen.mcp).toHaveLength(2)
    }),
  )

  it.live("the claude process does not inherit the opencode server's credentials; only the bridge gets its token", () =>
    Effect.gen(function* () {
      const saved = [process.env.OPENCODE_SERVER_USERNAME, process.env.OPENCODE_SERVER_PASSWORD] as const
      process.env.OPENCODE_SERVER_USERNAME = "opencode"
      process.env.OPENCODE_SERVER_PASSWORD = "parent-secret"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (saved[0] === undefined) delete process.env.OPENCODE_SERVER_USERNAME
          else process.env.OPENCODE_SERVER_USERNAME = saved[0]
          if (saved[1] === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
          else process.env.OPENCODE_SERVER_PASSWORD = saved[1]
        }),
      )
      const fake = scripted()
      yield* start({ run: fake.run, workbench: bridge("/projects/app") })
      // `env` replaces the claude process's whole environment: everything else is still there.
      const env = fake.seen.options!.env!
      expect(Object.keys(env)).not.toContain("OPENCODE_SERVER_USERNAME")
      expect(Object.keys(env)).not.toContain("OPENCODE_SERVER_PASSWORD")
      expect(Object.keys(env)).not.toContain("OPENCODE_SERVER_TOKEN")
      expect(env.PATH).toBe(process.env.PATH)
      expect(fake.seen.mcp[0]?.["opencode-workbench"]).toEqual(
        expect.objectContaining({ env: { OPENCODE_SERVER_TOKEN: "s3cret" } }),
      )
    }),
  )

  it.live("a Workbench server that fails to connect is reported without its secret", () =>
    Effect.gen(function* () {
      const fake = scripted({ "opencode-workbench": "MCP error: auth s3cret rejected" })
      const started = yield* start({ run: fake.run, workbench: bridge("/projects/app") })
      expect(started.events).toEqual([
        { type: "error", message: "Workbench tools unavailable: MCP error: auth *** rejected" },
      ])
    }),
  )

  it.live("maps streamed text and thinking once, and reports usage on turn.completed", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run })
      yield* started.session.send("stream")
      yield* waitFor(started.events, (list) => ofType(list, "turn.completed")[0], "turn never completed")
      expect(ofType(started.events, "message.delta")).toEqual([
        { type: "message.delta", messageID: "msg_1-1", text: "po" },
        { type: "message.delta", messageID: "msg_1-1", text: "ng" },
      ])
      expect(ofType(started.events, "message")).toEqual([
        { type: "message", messageID: "msg_1-1", role: "assistant", text: "pong" },
      ])
      expect(ofType(started.events, "reasoning")).toEqual([{ type: "reasoning", messageID: "msg_1-0", text: "hmm" }])
      expect(ofType(started.events, "turn.completed")).toEqual([
        {
          type: "turn.completed",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 2, costUSD: 0.0012 },
        },
      ])
    }),
  )

  it.live("a permission prompt waits for the human; always is scoped to the session", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run })
      yield* started.session.send("edit")
      const request = yield* waitFor(started.events, (list) => ofType(list, "permission.requested")[0], "never asked")
      expect(request).toMatchObject({ requestID: "cc_toolu_1", tool: "Edit", title: "Edit: /tmp/agenthq-a.ts" })
      expect(request.options.map((option) => [option.id, option.kind])).toEqual([
        ["allow", "allow_once"],
        ["always", "allow_always"],
        ["deny", "reject_once"],
      ])
      yield* Effect.sleep("200 millis")
      expect(fake.seen.decisions).toEqual([])
      expect(ofType(started.events, "tool")).toEqual([])

      const respond = started.session.respondPermission
      expect((yield* respond("cc_nope", "allow").pipe(Effect.flip))._tag).toBe("AgentHQ.NotFoundError")
      expect((yield* respond(request.requestID, "maybe").pipe(Effect.flip))._tag).toBe("AgentHQ.InvalidInputError")
      yield* respond(request.requestID, "always")
      yield* waitFor(started.events, (list) => ofType(list, "turn.completed")[0], "turn never completed")
      // Only the allow rule, moved to the in-memory session; the mode switch is never applied.
      expect(fake.seen.decisions).toEqual([
        {
          behavior: "allow",
          updatedPermissions: [
            { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" },
          ],
        },
      ])
      expect(ofType(started.events, "permission.resolved")).toEqual([
        { type: "permission.resolved", requestID: "cc_toolu_1", outcome: "allowed" },
      ])
      expect(ofType(started.events, "tool").map((event) => [event.state, event.output])).toEqual([
        ["started", undefined],
        ["completed", "edited"],
      ])
      expect(ofType(started.events, "file.changed")).toEqual([{ type: "file.changed", path: "/tmp/agenthq-a.ts" }])
    }),
  )

  it.live("a rejected prompt reaches Claude Code as deny", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run })
      yield* started.session.send("edit")
      const request = yield* waitFor(started.events, (list) => ofType(list, "permission.requested")[0], "never asked")
      yield* started.session.respondPermission(request.requestID, "deny")
      yield* waitFor(started.events, (list) => ofType(list, "turn.completed")[0], "turn never completed")
      expect(fake.seen.decisions).toEqual([{ behavior: "deny", message: "The user rejected this action." }])
      expect(ofType(started.events, "tool").at(-1)).toMatchObject({ state: "error", output: "denied" })
      expect(ofType(started.events, "file.changed")).toEqual([])
    }),
  )

  it.live("cancel interrupts the turn quietly and the session keeps working", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run })
      yield* started.session.send("hang")
      yield* Effect.sleep("100 millis")
      yield* started.session.cancel
      expect(fake.seen.interrupts).toBe(1)
      yield* Effect.sleep("200 millis")
      expect(ofType(started.events, "error")).toEqual([])
      expect(ofType(started.events, "status")).toEqual([])
      expect(ofType(started.events, "turn.completed")).toEqual([])
      yield* started.session.send("stream")
      yield* waitFor(started.events, (list) => ofType(list, "turn.completed")[0], "turn after cancel never completed")
    }),
  )

  it.live("a crashed Claude Code is reported as disconnected and refuses further turns", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run })
      yield* started.session.send("crash")
      yield* waitFor(started.events, (list) => ofType(list, "status")[0], "crash never reported")
      expect(ofType(started.events, "status")).toEqual([{ type: "status", status: "disconnected" }])
      expect(ofType(started.events, "error")[0]?.message).toContain("claude exited with code 1")
      expect((yield* started.session.send("again").pipe(Effect.flip))._tag).toBe("AgentHQ.ProviderError")
    }),
  )

  it.live("close stops the query without reporting a disconnect; resume passes the Claude session id", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const started = yield* start({ run: fake.run })
      yield* started.session.close
      expect(fake.seen.closed).toBe(true)
      expect(ofType(started.events, "status")).toEqual([])

      const again = scripted()
      const resumed = yield* start({ run: again.run, resume: "6f1c1f9e-2a5b-4d3c-9e8f-0a1b2c3d4e5f" })
      expect(resumed.session.providerSessionID).toBe("6f1c1f9e-2a5b-4d3c-9e8f-0a1b2c3d4e5f")
      expect(again.seen.options).toMatchObject({ resume: "6f1c1f9e-2a5b-4d3c-9e8f-0a1b2c3d4e5f" })
      expect(again.seen.options?.sessionId).toBeUndefined()
    }),
  )

  it.live("an unavailable claude fails with a typed error and starts nothing", () =>
    Effect.gen(function* () {
      const fake = scripted()
      const failure = yield* start({
        run: fake.run,
        status: { ...available, available: false, reason: "claude not found on PATH" },
      }).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "AgentHQ.UnsupportedError", message: "claude not found on PATH" })
      expect(fake.seen.options).toBeUndefined()
    }),
  )
})

// The opt-in real Claude Code session, through the installed `claude` and the owner's login. SPICY_REAL_CLAUDE=1 runs
// one haiku turn and spends tokens; SPICY_REAL_CLAUDE=status stops before anything reaches the model.
const mode = process.env.SPICY_REAL_CLAUDE
const real = mode === "1" || mode === "status" ? it.live : it.live.skip
const DOCTOR = "mcp__opencode-workbench__workbench_doctor"
const ISOLATION = [
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_TEST_HOME",
  "OPENCODE_TEST_MANAGED_CONFIG_DIR",
]

/** The command line and environment of the first process matching `pattern` (macOS `ps`, Linux `/proc`). */
const inspect = (pattern: string) => {
  const pid = Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString().trim().split("\n")[0]
  if (!pid) return { command: "", environment: "" }
  const proc = (file: string) => readFileSync(`/proc/${pid}/${file}`, "utf8").replaceAll("\0", " ")
  const ps = (...flags: string[]) =>
    Bun.spawnSync(["ps", ...flags, "-ww", "-p", pid, "-o", "command="]).stdout.toString()
  return process.platform === "linux"
    ? { command: proc("cmdline"), environment: proc("environ") }
    : { command: ps(), environment: ps("-E") }
}

describe("agenthq claude code adapter (real, opt-in)", () => {
  real(
    "REAL: the installed claude gets the Workbench MCP server of a password-protected listener [skipped unless SPICY_REAL_CLAUDE=1 (one haiku turn, spends tokens) or =status (no model call); needs an authenticated claude]",
    () =>
      Effect.gen(function* () {
        const { query } = yield* Effect.promise(() => import("@anthropic-ai/claude-agent-sdk"))
        const { resetDatabase } = yield* Effect.promise(() => import("../fixture/db"))
        const { auth, listener } = yield* Effect.promise(() => import("../fixture/agenthq/listener"))
        const { AgentWorkbench } = yield* Effect.promise(() => import("../../src/agenthq/workbench"))
        yield* Effect.acquireRelease(Effect.promise(resetDatabase), () => Effect.promise(resetDatabase))
        const { server } = yield* listener
        const dir = yield* tmpdirScoped({ git: true })

        // What the manager gives a session in `dir`: this listener, the directory and a bridge token. The test adds
        // its own XDG dirs, so the bridge stays out of the owner's opencode data whatever claude passes it.
        const configured = (yield* AgentWorkbench.server(dir))!
        expect(configured.args).toEqual(expect.arrayContaining(["--url", server.url.origin, "--directory", dir]))
        const isolation = Object.fromEntries(
          ISOLATION.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
        )
        const workbench = { ...configured, env: { ...configured.env, ...isolation } }

        let sdk: ReturnType<typeof query> | undefined
        const provider = yield* ClaudeCodeProvider.make({
          status: yield* AgentDetect.prober("claude-code", ClaudeCodeProvider.capabilities),
          binary: () => AgentDetect.binary("claude-code"),
          // The real SDK, kept at hand for its MCP status call.
          run: (params) => (sdk = query(params)),
          // A tool call and the reply take two turns; nothing is written to the owner's ~/.claude/projects.
          options: { maxTurns: 3, persistSession: false },
        })
        const events: AgentHQ.AgentEvent[] = []
        const started = Date.now()
        const session = yield* provider.createSession({
          agent: agent(dir, "haiku"),
          workbench,
          emit: (event) => {
            events.push(event)
            // The test plays the human: it allows the Workbench doctor once and nothing else.
            if (event.type !== "permission.requested") return
            const choice = event.tool === DOCTOR || event.tool === "ToolSearch" ? "allow" : "deny"
            Effect.runFork(session.respondPermission(event.requestID, choice).pipe(Effect.ignore))
          },
        })
        yield* Effect.addFinalizer(() => session.close)
        const connectMs = Date.now() - started

        // Before any prompt, so nothing reaches the model: the server is connected and lists its tools.
        const first = (yield* Effect.promise(() => sdk!.mcpServerStatus())).find(
          (item) => item.name === "opencode-workbench",
        )
        const status = yield* pollWithTimeout(
          Effect.promise(() => sdk!.mcpServerStatus()).pipe(
            Effect.map((list) => list.find((item) => item.name === "opencode-workbench" && item.status !== "pending")),
          ),
          "the Workbench MCP server never left pending",
          "60 seconds",
        )
        const tools = (status.tools ?? []).map((tool) => tool.name)
        // The processes: claude without the server's credentials, the bridge with its token only in its environment and
        // never the server password.
        const claude = inspect(session.providerSessionID)
        const bridge = inspect(`workbench mcp --url ${server.url.origin} --directory ${dir}`)
        const report = {
          connectMs,
          firstStatus: first?.status,
          // Never `config`: it holds the bridge token.
          server: { name: status.name, status: status.status, source: status.source, serverInfo: status.serverInfo },
          error: status.error,
          tools,
          claudeFound: claude.command !== "",
          // Strict mode is on, and the Workbench server is not on the claude command line.
          claudeStrict: claude.command.includes("--strict-mcp-config"),
          claudeMcpConfigArg: claude.command.includes("--mcp-config "),
          claudeHasPassword: claude.environment.includes(auth.password),
          bridgeFound: bridge.command !== "",
          bridgeArgsHavePassword: bridge.command.includes(auth.password),
          bridgeEnvHasPassword: bridge.environment.includes(auth.password),
          bridgeEnvHasToken: bridge.environment.includes(
            `OPENCODE_SERVER_TOKEN=${configured.env.OPENCODE_SERVER_TOKEN}`,
          ),
          bridgeGotClaudeEnv: bridge.environment.includes("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM="),
        }
        console.log(`SPICY_REAL_CLAUDE status ${JSON.stringify(report)}`)
        expect(status.status).toBe("connected")
        expect(tools).toEqual(expect.arrayContaining(["workbench_problems", "workbench_check", "workbench_doctor"]))
        expect(tools.some((name) => name.startsWith("debug_"))).toBe(true)
        expect(report).toMatchObject({ claudeFound: true, claudeStrict: true, claudeMcpConfigArg: false })
        expect(report).toMatchObject({ claudeHasPassword: false, bridgeFound: true })
        expect(report).toMatchObject({
          bridgeArgsHavePassword: false,
          bridgeEnvHasPassword: false,
          bridgeEnvHasToken: true,
        })
        if (mode === "status") return

        // The one model call: Claude asks to run the doctor, the test allows it once, the result comes back.
        yield* session.send(`Call the ${DOCTOR} tool exactly once with no arguments, then reply with exactly: done`)
        const end = yield* pollWithTimeout(
          Effect.sync(() =>
            events.find(
              (event) => event.type === "turn.completed" || (event.type === "status" && event.status !== "working"),
            ),
          ),
          "the real Claude Code turn did not finish",
          "240 seconds",
        )
        const asked = ofType(events, "permission.requested")
        const ran = ofType(events, "tool").filter((event) => event.tool === DOCTOR)
        const answer = ofType(events, "message").at(-1)?.text ?? ""
        const transcript = {
          durationMs: Date.now() - started,
          deltas: ofType(events, "message.delta").length,
          permissionRequests: asked.map((event) => ({ tool: event.tool, title: event.title })),
          permissionResolved: ofType(events, "permission.resolved").map((event) => event.outcome),
          tools: ofType(events, "tool").map((event) => ({
            tool: event.tool,
            state: event.state,
            output: event.output?.slice(0, 400),
          })),
          errors: ofType(events, "error").map((event) => event.message.slice(0, 400)),
          answer,
          end,
        }
        console.log(`SPICY_REAL_CLAUDE transcript ${JSON.stringify(transcript)}`)
        // The doctor asked exactly once and was allowed; anything else could only be the tool search.
        const doctor = asked.filter((event) => event.tool === DOCTOR)
        expect(doctor).toHaveLength(1)
        expect(asked.every((event) => event.tool === DOCTOR || event.tool === "ToolSearch")).toBe(true)
        expect(ofType(events, "permission.resolved")).toContainEqual({
          type: "permission.resolved",
          requestID: doctor[0]!.requestID,
          outcome: "allowed",
        })
        expect(ran.at(-1)?.state).toBe("completed")
        expect(ran.at(-1)?.output?.length).toBeGreaterThan(0)
        expect(end.type).toBe("turn.completed")
        expect(answer.toLowerCase()).toContain("done")
      }),
    300_000,
  )
})
