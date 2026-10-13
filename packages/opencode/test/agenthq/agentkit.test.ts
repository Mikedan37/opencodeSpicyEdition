// AgentKit through its bridge's ACP mode (`agentkit-bridge acp`): detection, and the opt-in real validation against
// the bridge that ships in OpenCode Native. The scripted runs under the agentkit provider are AHQ-15 and AHQ-16 in
// agenthq.test.ts.
//
// The real validation always runs the bridge with `--local-only` (a private AgentKit daemon on local Ollama, $0): a
// shim in front of it adds the flag whatever Agent HQ passes, and logs the JSON-RPC exchange in both directions.
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { AppProcess } from "@opencode-ai/core/process"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { $ } from "bun"
import { Effect } from "effect"
import { existsSync, realpathSync, statSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AgentDetect } from "../../src/agenthq/providers/detect"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node])))

// agentkit-bridge 0.1.0 answers --help with its usage on stderr and exit 64, and --version on stdout.
const USAGE =
  "usage: agentkit-bridge app-server | mcp | acp [--local-only] | autopilot <project> --state <dir> | --version"
const bridgeScript = (usage: string) =>
  [`if [ "$1" = "--version" ]; then echo "agentkit-bridge 0.1.0"; exit 0; fi`, `echo "${usage}" >&2`, "exit 64"].join(
    "\n",
  )

/** A folder holding a fake `agentkit-bridge` with this body (or nothing), and that file's path. */
const fakeBridge = (body?: string) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const bin = path.join(dir, "agentkit-bridge")
    if (body)
      yield* Effect.promise(async () => {
        await fs.writeFile(bin, `#!/bin/sh\n${body}\n`)
        await fs.chmod(bin, 0o755)
      })
    return { dir, bin }
  })

const FIXTURE = path.join(import.meta.dir, "../fixture/agenthq/fake-acp-agent.ts")

/** A folder under the home folder (the test home), where found copies of OpenCode Native may live; resolved. */
const homeScoped = Effect.acquireRelease(
  Effect.promise(async () => realpathSync(await fs.mkdtemp(path.join(Global.Path.home, "agentkit-")))),
  (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
)

/**
 * An `OpenCode Native.app` copy at `<root>/<name>` whose bridge has this usage (none: no bridge) and mtime. The bridge
 * logs every run's first argument to `<bridge>.runs`; `acp` runs the scripted ACP agent.
 */
const nativeApp = (root: string, name: string, usage: string | undefined, minutesAgo = 0) =>
  Effect.promise(async () => {
    const bundle = path.join(root, name, "OpenCode Native.app")
    const bin = path.join(bundle, "Contents", "MacOS", "agentkit-bridge")
    await fs.mkdir(path.dirname(bin), { recursive: true })
    await fs.chmod(path.dirname(bin), 0o755)
    if (usage !== undefined) {
      await fs.writeFile(
        bin,
        [
          "#!/bin/sh",
          `echo "$1" >> '${bin}.runs'`,
          `if [ "$1" = "acp" ]; then exec '${process.execPath}' '${FIXTURE}'; fi`,
          bridgeScript(usage),
        ].join("\n"),
      )
      await fs.chmod(bin, 0o755)
      const at = new Date(Date.now() - minutesAgo * 60_000)
      await fs.utimes(bin, at, at)
    }
    const runs = () =>
      fs.readFile(`${bin}.runs`, "utf8").then(
        (text) => text.split("\n").filter(Boolean),
        () => [] as string[],
      )
    return { bundle, bin, runs }
  })

const kit = (projectDirectory: string): AgentHQ.AgentIdentity => ({
  id: AgentHQ.AgentID.create(),
  name: "Kit",
  avatar: { kind: "initials", value: "K" },
  provider: "agentkit",
  projectDirectory,
  createdAt: 0,
  updatedAt: 0,
})

describe("agenthq agentkit (agentkit-bridge acp)", () => {
  it.live("is available only when the bridge's usage lists an ACP mode", () =>
    Effect.gen(function* () {
      // No bridge on PATH, in Applications or in LaunchServices' index, whatever this machine has.
      const nowhere = { PATH: "", applications: [], finder: Effect.succeed([]) }
      const ready = yield* fakeBridge(bridgeScript(USAGE))
      const status = yield* (yield* AgentDetect.agentkit({ ...nowhere, PATH: ready.dir })).status
      expect(status).toMatchObject({
        id: "agentkit",
        name: "AgentKit",
        available: true,
        version: "0.1.0",
        auth: "unknown",
      })
      expect(status.capabilities).toMatchObject({
        streaming: true,
        permissionRequests: true,
        cancel: true,
        mcpTools: true,
      })

      // A bridge from before the ACP mode.
      const old = yield* fakeBridge(bridgeScript("usage: agentkit-bridge app-server | mcp | --version"))
      expect(yield* (yield* AgentDetect.agentkit({ ...nowhere, PATH: old.dir })).status).toMatchObject({
        available: false,
        reason: "this AgentKit bridge has no ACP mode yet",
      })

      const missing = yield* AgentDetect.agentkit(nowhere)
      expect(yield* missing.status).toMatchObject({ available: false, reason: "AgentKit bridge not found" })
      const dir = yield* tmpdirScoped()
      const failure = yield* missing
        .createSession({
          agent: {
            id: AgentHQ.AgentID.create(),
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

  it.live("finds the bridge the human chose: OPENCODE_AGENTKIT_BRIDGE, then PATH", () =>
    Effect.gen(function* () {
      const explicit = yield* fakeBridge(bridgeScript(USAGE))
      const onPath = yield* fakeBridge(bridgeScript(USAGE))
      const find = AgentDetect.agentkitBridge
      expect(find({ OPENCODE_AGENTKIT_BRIDGE: explicit.bin, PATH: onPath.dir })).toBe(explicit.bin)
      // An explicit setting that points nowhere is not silently replaced by another bridge.
      expect(find({ OPENCODE_AGENTKIT_BRIDGE: path.join(onPath.dir, "gone"), PATH: onPath.dir })).toBeUndefined()
      expect(find({ PATH: onPath.dir })).toBe(onPath.bin)
      expect(find({ PATH: "" })).toBeUndefined()
    }),
  )

  it.live("otherwise picks OpenCode Native.app in Applications, else the newest bridge LaunchServices knows", () =>
    Effect.gen(function* () {
      const root = yield* homeScoped
      const older = yield* nativeApp(root, "older", USAGE, 30)
      const newer = yield* nativeApp(root, "newer", USAGE, 10)
      const newest = yield* nativeApp(root, "no-acp", "usage: agentkit-bridge app-server | mcp | --version", 1)
      const empty = yield* nativeApp(root, "no-bridge", undefined)
      const finder = Effect.succeed([older.bundle, newest.bundle, empty.bundle, newer.bundle])
      const provider = yield* AgentDetect.agentkit({ PATH: "", applications: [], finder })
      const status = yield* provider.status
      // The newest copy has no ACP mode and one has no bridge at all: the newer of the other two wins, and the status
      // says which binary will run.
      expect(status).toMatchObject({ available: true, version: "0.1.0" })
      expect(status.capabilities.notes?.[0]).toBe(`Bridge: ${newer.bin}`)

      // A session starts the bridge the provider list chose.
      const session = yield* provider.createSession({ agent: kit(yield* tmpdirScoped()), emit: () => {} })
      yield* Effect.addFinalizer(() => session.close)
      expect(yield* Effect.promise(newer.runs)).toEqual(["--help", "--version", "acp"])
      expect(yield* Effect.promise(older.runs)).toEqual(["--help", "--version"])

      // A copy in an Applications folder comes before LaunchServices' newer ones.
      const installed = yield* AgentDetect.agentkit({ PATH: "", applications: [path.join(root, "older")], finder })
      expect((yield* installed.status).capabilities.notes?.[0]).toBe(`Bridge: ${older.bin}`)

      // Nothing indexed, or an index that fails, finds nothing.
      for (const none of [Effect.succeed([]), Effect.fail(new Error("mdfind failed")), Effect.die("mdfind crashed")])
        expect(yield* (yield* AgentDetect.agentkit({ PATH: "", applications: [], finder: none })).status).toMatchObject(
          {
            available: false,
            reason: "AgentKit bridge not found",
          },
        )
    }),
  )

  it.live("never runs a found copy that is quarantined, on a mounted image, outside home, or not the human's own", () =>
    Effect.gen(function* () {
      const root = yield* homeScoped
      const good = yield* nativeApp(root, "good", USAGE, 30)
      // The newest copy: it wins unless the check stops it, so a run of it would show in its log.
      const bad = yield* nativeApp(root, "bad", USAGE, 1)
      const finder = Effect.succeed([good.bundle, bad.bundle])
      const chosen = (env: Partial<AgentDetect.AgentKitEnv> = {}) =>
        Effect.gen(function* () {
          const provider = yield* AgentDetect.agentkit({ PATH: "", applications: [], finder, ...env })
          return (yield* provider.status).capabilities.notes?.[0]
        })
      const stat = (uid: (file: string) => number | undefined) => (file: string) => {
        const facts = statSync(file)
        return {
          uid: uid(file) ?? facts.uid,
          mode: facts.mode,
          size: facts.size,
          mtimeMs: facts.mtimeMs,
          ino: facts.ino,
        }
      }

      // Quarantined (downloaded, never opened): the app or only its bridge.
      for (const marked of [bad.bundle, bad.bin])
        expect(yield* chosen({ quarantined: (paths) => Effect.succeed(paths.includes(marked)) })).toBe(
          `Bridge: ${good.bin}`,
        )
      // On a mounted image, even one that holds the home folder: skipped before anything else is asked of it.
      const asked: string[] = []
      const mounted = {
        realpath: (file: string) => `/Volumes/Image${realpathSync(file)}`,
        stat: (file: string) => statSync(file.replace(/^\/Volumes\/Image/, "")),
      }
      const onImage = yield* AgentDetect.agentkit({
        PATH: "",
        applications: [],
        finder,
        files: mounted,
        quarantined: (paths) => Effect.sync(() => (asked.push(...paths), false)),
      })
      expect(yield* onImage.status).toMatchObject({ available: false, reason: "AgentKit bridge not found" })
      expect(asked).toEqual([])
      // Owned by someone else.
      expect(
        yield* chosen({
          files: { realpath: realpathSync, stat: stat((file) => (file === bad.bin ? 4242 : undefined)) },
        }),
      ).toBe(`Bridge: ${good.bin}`)
      // Writable by others, or its folder writable by the group.
      for (const [file, mode, restore] of [
        [bad.bin, 0o757, 0o755],
        [path.dirname(bad.bin), 0o775, 0o755],
      ] as const) {
        yield* Effect.promise(() => fs.chmod(file, mode))
        expect(yield* chosen()).toBe(`Bridge: ${good.bin}`)
        yield* Effect.promise(() => fs.chmod(file, restore))
      }
      // Outside the home folder and /Applications.
      const away = yield* nativeApp(yield* tmpdirScoped(), "away", USAGE, 0)
      expect(yield* chosen({ finder: Effect.succeed([good.bundle, away.bundle]) })).toBe(`Bridge: ${good.bin}`)
      expect(yield* Effect.promise(away.runs)).toEqual([])
      expect(yield* Effect.promise(bad.runs)).toEqual([])

      // A chosen copy is checked again right before a session runs it.
      let quarantine = false
      const provider = yield* AgentDetect.agentkit({
        PATH: "",
        applications: [],
        finder: Effect.succeed([good.bundle]),
        quarantined: () => Effect.sync(() => quarantine),
      })
      expect((yield* provider.status).capabilities.notes?.[0]).toBe(`Bridge: ${good.bin}`)
      quarantine = true
      const refused = yield* provider
        .createSession({ agent: kit(yield* tmpdirScoped()), emit: () => {} })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ message: "AgentKit bridge not found" })
      expect(yield* Effect.promise(good.runs)).not.toContain("acp")

      // The control: with nothing wrong, the bad copy is the one chosen and asked.
      expect(yield* chosen()).toBe(`Bridge: ${bad.bin}`)
      expect(yield* Effect.promise(bad.runs)).toEqual(["--help", "--version"])
    }),
  )

  it.live("never touches a copy LaunchServices lists in a folder macOS guards, and says why none was chosen", () =>
    Effect.gen(function* () {
      // The newest copies, with an ACP mode, in the home folder's Documents, Desktop, Downloads and iCloud Drive.
      const tag = `agentkit-${Math.random().toString(36).slice(2)}`
      const folders = [...AgentDetect.PROTECTED_FOLDERS, "Applications"].map((name) =>
        path.join(Global.Path.home, name, tag),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all(folders.map((dir) => fs.rm(dir, { recursive: true, force: true })))),
      )
      const copies = yield* Effect.forEach(folders.slice(0, -1), (dir) => nativeApp(dir, "Codex", USAGE, 1))
      // Every path discovery resolves, stats or asks xattr about.
      const touched: string[] = []
      const spy = {
        files: {
          realpath: (file: string) => (touched.push(file), realpathSync(file)),
          stat: (file: string) => (touched.push(file), statSync(file)),
        },
        quarantined: (paths: readonly string[]) => Effect.sync(() => (touched.push(...paths), false)),
      }
      const guarded = () =>
        touched.filter((file) =>
          AgentDetect.PROTECTED_FOLDERS.some((name) => file.toLowerCase().includes(`/${name.toLowerCase()}/`)),
        )
      // As the index lists them, one spelled in another case (the same folder on macOS), and one by the resolved home.
      const indexed = [
        ...copies.map((copy) => copy.bundle),
        copies[0]!.bundle.replace("/Documents/", "/documents/"),
        copies[1]!.bundle.replace(Global.Path.home, realpathSync(Global.Path.home)),
      ]
      const reason =
        "OpenCode Native was found only in a protected folder (Documents, Desktop, Downloads, Library/Mobile Documents); install it in Applications or set OPENCODE_AGENTKIT_BRIDGE"
      const provider = yield* AgentDetect.agentkit({
        PATH: "",
        applications: [],
        finder: Effect.succeed(indexed),
        ...spy,
      })
      expect(yield* provider.status).toMatchObject({ available: false, reason })
      const refused = yield* provider
        .createSession({ agent: kit(yield* tmpdirScoped()), emit: () => {} })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ message: reason })

      // A copy in ~/Applications is still chosen: listed by LaunchServices beside them, or found in the folder.
      const installed = yield* nativeApp(folders.at(-1)!, ".", USAGE, 60)
      for (const env of [
        { applications: [], finder: Effect.succeed([...indexed, installed.bundle]) },
        { applications: [folders.at(-1)!], finder: Effect.succeed(indexed) },
      ]) {
        const found = yield* (yield* AgentDetect.agentkit({ PATH: "", ...env, ...spy })).status
        expect(found.capabilities.notes?.[0]).toBe(`Bridge: ${realpathSync(installed.bin)}`)
      }
      expect(guarded()).toEqual([])
      for (const copy of copies) expect(yield* Effect.promise(copy.runs)).toEqual([])
    }),
  )

  it.live("asks a bridge about itself once per binary, until it changes", () =>
    Effect.gen(function* () {
      const root = yield* homeScoped
      const only = yield* nativeApp(root, "only", USAGE, 5)
      const provider = yield* AgentDetect.agentkit({
        PATH: "",
        applications: [],
        finder: Effect.succeed([only.bundle]),
      })
      for (let i = 0; i < 5; i++) expect(yield* provider.status).toMatchObject({ available: true, version: "0.1.0" })
      expect(yield* Effect.promise(only.runs)).toEqual(["--help", "--version"])
      // A new mtime is a new binary.
      yield* Effect.promise(() => fs.utimes(only.bin, new Date(), new Date()))
      for (let i = 0; i < 3; i++) expect(yield* provider.status).toMatchObject({ available: true })
      expect(yield* Effect.promise(only.runs)).toEqual(["--help", "--version", "--help", "--version"])
      // A session start asks nothing more; it only runs the bridge.
      const session = yield* provider.createSession({ agent: kit(yield* tmpdirScoped()), emit: () => {} })
      yield* Effect.addFinalizer(() => session.close)
      expect(yield* Effect.promise(only.runs)).toEqual(["--help", "--version", "--help", "--version", "acp"])
    }),
  )

  const darwin = process.platform === "darwin" ? it.live : it.live.skip
  darwin("reads the quarantine attribute with the system's xattr, and an unreadable answer counts as quarantined", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // A plain data file: nothing ever opens or runs it.
      const file = path.join(dir, "download.txt")
      yield* Effect.promise(() => fs.writeFile(file, "data"))
      expect(yield* AgentDetect.quarantined([dir, file])).toBe(false)
      yield* Effect.promise(() =>
        $`/usr/bin/xattr -w com.apple.quarantine "0081;00000000;agenthq-test;" ${file}`.quiet(),
      )
      expect(yield* AgentDetect.quarantined([dir, file])).toBe(true)
      expect(yield* AgentDetect.quarantined([path.join(dir, "gone")])).toBe(true)
    }),
  )
})

// The free, read-only check of this Mac's LaunchServices index: no session, only the provider status.
const realIndex = process.env.SPICY_REAL_AGENTKIT === "index" ? it.live : it.live.skip

/** The real checks see this Mac as the server does outside tests: found copies must be under the user's real home. */
const realHome = Effect.acquireRelease(
  Effect.sync(() => {
    const testHome = process.env.OPENCODE_TEST_HOME
    delete process.env.OPENCODE_TEST_HOME
    return testHome
  }),
  (testHome) =>
    Effect.sync(() => {
      if (testHome !== undefined) process.env.OPENCODE_TEST_HOME = testHome
    }),
)

describe("agenthq agentkit (real index, opt-in)", () => {
  realIndex(
    "REAL: AgentKit discovery on this Mac, touching nothing in protected folders [skipped unless SPICY_REAL_AGENTKIT=index; status only]",
    () =>
      Effect.gen(function* () {
        // As the server sees it: nothing configured, nothing on PATH. Every path discovery resolves or stats is recorded.
        yield* realHome
        const touched: string[] = []
        const files = {
          realpath: (file: string) => (touched.push(file), realpathSync(file)),
          stat: (file: string) => (touched.push(file), statSync(file)),
        }
        const status = yield* (yield* AgentDetect.agentkit({ PATH: "", files })).status
        const guarded = touched.filter((file) =>
          AgentDetect.PROTECTED_FOLDERS.some((name) => file.startsWith(path.join(os.homedir(), name) + "/")),
        )
        console.log(
          `SPICY_REAL_AGENTKIT index ${JSON.stringify({ available: status.available, version: status.version, reason: status.reason, bridge: status.capabilities.notes?.[0], touched: [...new Set(touched)], guarded })}`,
        )
        expect(guarded).toEqual([])
        // Found and runnable, or found only where macOS would ask the human first.
        if (status.available)
          expect(status.capabilities.notes?.[0]).toMatch(
            /^Bridge: .*OpenCode Native\.app\/Contents\/MacOS\/agentkit-bridge$/,
          )
        else expect(status.reason).toMatch(/^OpenCode Native was found only in a protected folder \(/)
      }),
  )
})

// ---------------------------------------------------------------- real, opt-in

// SPICY_REAL_AGENTKIT=status: start one session (initialize + session/new with the Workbench MCP server), no prompt.
// SPICY_REAL_AGENTKIT=1: the whole validation below. Both use the bridge the product finds (OPENCODE_AGENTKIT_BRIDGE,
// PATH, Applications, LaunchServices), as the provider status names it, and run it only with --local-only.
const mode = process.env.SPICY_REAL_AGENTKIT
const realAgentKit = mode === "status" || mode === "1" ? it.live : it.live.skip

// A Swift package whose only file does not build (a function that never closes): AgentKit plans its edits for Swift
// and verifies them with `swift build`, and so does this test.
const FILE = "Sources/Math/Math.swift"
const PROJECT = {
  "Package.swift":
    '// swift-tools-version:5.9\nimport PackageDescription\n\nlet package = Package(name: "Math", targets: [.target(name: "Math")])\n',
  [FILE]:
    "public func add(_ a: Int, _ b: Int) -> Int {\n    return a + b\n\npublic func sub(_ a: Int, _ b: Int) -> Int {\n    return a - b\n}\n",
}

describe("agenthq agentkit (real, opt-in)", () => {
  realAgentKit(
    "REAL: AgentKit (--local-only) through the Agent HQ HTTP API [skipped unless SPICY_REAL_AGENTKIT=status or 1; $0, local Ollama only]",
    () =>
      Effect.gen(function* () {
        yield* realHome
        const { resetDatabase } = yield* Effect.promise(() => import("../fixture/db"))
        const { auth, freePort, listener } = yield* Effect.promise(() => import("../fixture/agenthq/listener"))
        const { Server } = yield* Effect.promise(() => import("../../src/server/server"))
        yield* Effect.acquireRelease(Effect.promise(resetDatabase), () => Effect.promise(resetDatabase))
        const first = yield* listener
        let server = first.server

        // A temp git project with two files that do not parse.
        const dir = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(async () => {
          for (const [file, text] of Object.entries(PROJECT)) {
            await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
            await fs.writeFile(path.join(dir, file), text)
          }
          await fs.writeFile(path.join(dir, ".gitignore"), ".build/\n")
          await $`git add -A && git commit -q -m broken`.cwd(dir).quiet()
        })
        const untouched = Effect.promise(() => $`git status --porcelain ${FILE}`.cwd(dir).quiet().text()).pipe(
          Effect.map((text) => text.trim() === ""),
        )
        // The whole project (.build is ignored).
        const porcelain = Effect.promise(() =>
          $`git status --porcelain --untracked-files=all`.cwd(dir).quiet().text(),
        ).pipe(Effect.map((text) => text.split("\n").filter((line) => line.trim())))
        const builds = Effect.promise(() => $`swift build`.cwd(dir).nothrow().quiet()).pipe(
          Effect.map((result) => result.exitCode === 0),
        )
        expect(yield* builds).toBe(false)

        // The shim: AgentKit local-only, whatever it is asked, with the JSON-RPC exchange logged both ways.
        // SPICY_REAL_AGENTKIT_LOGS keeps the exchange after the run; otherwise it goes with the temp dir.
        const logs = process.env.SPICY_REAL_AGENTKIT_LOGS ?? (yield* tmpdirScoped())
        yield* Effect.promise(() => fs.mkdir(logs, { recursive: true }))
        const shim = path.join(logs, "agentkit-local-only")
        // Set from the provider status in step a.
        let bridge = ""
        // AgentKit state that must never land in the project, and the daemons' temp state folders that must go.
        const blaze = () => existsSync(path.join(dir, ".blaze"))
        const stateHomes = new Set<string>()
        const scratch = () =>
          Promise.all(
            [os.tmpdir(), "/tmp"].map((folder) =>
              fs
                .readdir(folder)
                .then((names) =>
                  names
                    .filter((name) => /ocn|blaze|agentkit-acp-\d/i.test(name))
                    .map((name) => path.join(folder, name)),
                )
                .catch(() => [] as string[]),
            ),
          ).then((lists) => lists.flat())
        const tmpBefore = new Set(yield* Effect.promise(scratch))
        const rpc = (file: "in" | "out") =>
          Effect.promise(() =>
            fs
              .readFile(path.join(logs, `${file}.jsonl`), "utf8")
              .catch(() => "")
              .then((text) =>
                text.split("\n").flatMap((line): Record<string, any>[] => {
                  try {
                    return line ? [JSON.parse(line)] : []
                  } catch {
                    return []
                  }
                }),
              ),
          )

        const call = (route: string, init: RequestInit = {}) =>
          Effect.promise(async () => {
            const headers = new Headers(init.headers)
            headers.set("authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`)
            headers.set("x-opencode-directory", dir)
            if (init.body) headers.set("content-type", "application/json")
            const response = await fetch(new URL(route, server.url), { ...init, headers })
            const text = await response.text()
            return { status: response.status, body: (text ? JSON.parse(text) : undefined) as any }
          })
        const post = (route: string, body: unknown) => call(route, { method: "POST", body: JSON.stringify(body) })
        type Detail = { session: AgentHQ.AgentSessionInfo; history: AgentHQ.AgentEventEnvelope[] }
        const detail = (id: string) =>
          call(`/agenthq/sessions/${id}`).pipe(Effect.map((result) => result.body as Detail))
        const ofType = <T extends AgentHQ.AgentEvent["type"]>(list: readonly AgentHQ.AgentEventEnvelope[], type: T) =>
          list.flatMap((item) =>
            item.event.type === type ? [item.event as Extract<AgentHQ.AgentEvent, { type: T }>] : [],
          )
        const waitFor = <A>(id: string, pick: (detail: Detail) => A | undefined, what: string, seconds = 360) =>
          pollWithTimeout(detail(id).pipe(Effect.map(pick)), `AgentKit: ${what}`, `${seconds} seconds`)
        const since = (list: readonly AgentHQ.AgentEventEnvelope[], seq: number) =>
          list.filter((item) => item.seq > seq)

        // Every process the bridge starts (the private daemon among them), found while it runs.
        const tree = (pid: number): { pid: number; command: string }[] =>
          Bun.spawnSync(["pgrep", "-P", String(pid)])
            .stdout.toString()
            .split("\n")
            .filter(Boolean)
            .map(Number)
            .flatMap((kid) => [
              {
                pid: kid,
                command: Bun.spawnSync(["ps", "-o", "command=", "-p", String(kid)])
                  .stdout.toString()
                  .trim(),
              },
              ...tree(kid),
            ])
        // Only this test's bridges (its server spawns them through the shim): others may run the same app.
        const parents = (pid: number): number[] => {
          const parent = Number(
            Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
              .stdout.toString()
              .trim(),
          )
          return parent > 1 ? [parent, ...parents(parent)] : []
        }
        const bridges = () =>
          Bun.spawnSync(["pgrep", "-f", `${bridge} acp --local-only`])
            .stdout.toString()
            .split("\n")
            .filter(Boolean)
            .map(Number)
            .filter((pid) => parents(pid).includes(process.pid))
        const alive = (pid: number) => Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0
        const sockets = () =>
          Effect.promise(() =>
            fs.readdir("/tmp").then((names) => names.filter((name) => /^ocn-acp-\d+\.sock$/.test(name))),
          )
        const seen = new Map<number, string>()
        // The private daemon is a child, or at least the holder of /tmp/ocn-acp-<bridge pid>.sock.
        const holders = (pid: number) =>
          Bun.spawnSync(["lsof", "-t", `/tmp/ocn-acp-${pid}.sock`])
            .stdout.toString()
            .split("\n")
            .filter(Boolean)
            .map(Number)
        const remember = () => {
          for (const pid of seen.keys()) {
            const env = Bun.spawnSync(["ps", "-E", "-ww", "-p", String(pid), "-o", "command="]).stdout.toString()
            const home = env.match(/(?:^|\s)BLAZE_STATE_HOME=(\S+)/)?.[1]
            if (home) stateHomes.add(home)
          }
          for (const pid of bridges()) {
            seen.set(pid, "agentkit-bridge acp --local-only")
            for (const item of tree(pid)) seen.set(item.pid, item.command)
            for (const holder of holders(pid))
              if (!seen.has(holder))
                seen.set(
                  holder,
                  Bun.spawnSync(["ps", "-o", "command=", "-p", String(holder)])
                    .stdout.toString()
                    .trim(),
                )
          }
        }
        const left = Effect.gen(function* () {
          const processes = [...seen.keys()].filter(alive)
          const ours = new Set([...seen.keys()].map((pid) => `ocn-acp-${pid}.sock`))
          return { processes, sockets: (yield* sockets()).filter((name) => ours.has(name)) }
        })
        // Nothing of ours may outlive the test, whatever happens.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [...seen.keys()].filter(alive)) Bun.spawnSync(["kill", String(pid)])
          }),
        )

        const report: Record<string, unknown> = {}
        // Every check is recorded and the run goes on, so one run reports everything that works and what does not.
        const checks: { name: string; ok: boolean; evidence?: unknown }[] = []
        report.checks = checks
        const check = (name: string, ok: boolean, evidence: unknown) => {
          checks.push({ name, ok, ...(ok ? {} : { evidence }) })
          return ok
        }
        // Printed however the run ends, so a failure still shows everything seen up to it.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            console.log(`SPICY_REAL_AGENTKIT ${mode} ${JSON.stringify(report)}`)
            console.log(`SPICY_REAL_AGENTKIT rpc logs ${logs}`)
          }),
        )
        const time = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const started = Date.now()
            const result = yield* effect
            report[`${label}Ms`] = Date.now() - started
            return result
          })

        // ---- a. status: the provider, then initialize + session/new with the Workbench MCP server.
        const providers = (yield* call("/agenthq/providers")).body as AgentHQ.ProviderStatus[]
        const status = providers.find((item) => item.id === "agentkit")
        bridge = status?.capabilities.notes?.[0]?.replace(/^Bridge: /, "") ?? ""
        report.status = status && {
          available: status.available,
          version: status.version,
          reason: status.reason,
          bridge,
        }
        expect(status).toMatchObject({ available: true })
        expect(existsSync(bridge)).toBe(true)
        // The same discovery, watched: every path it resolves or stats, and whether it asks LaunchServices at all.
        const touched: string[] = []
        let indexAsked = false
        const watched = yield* (yield* AgentDetect.agentkit({
          PATH: "",
          finder: Effect.sync(() => {
            indexAsked = true
            return [] as string[]
          }),
          files: {
            realpath: (file: string) => (touched.push(file), realpathSync(file)),
            stat: (file: string) => (touched.push(file), statSync(file)),
          },
        })).status
        report.discovery = { touched: [...new Set(touched)], indexAsked }
        const installed = path.join(os.homedir(), "Applications", "OpenCode Native.app", "Contents", "MacOS")
        check("a (0.15): OPENCODE_AGENTKIT_BRIDGE is not set", !process.env.OPENCODE_AGENTKIT_BRIDGE, undefined)
        check(
          "a (0.15): the bridge is ~/Applications/OpenCode Native.app's",
          bridge === path.join(installed, "agentkit-bridge"),
          bridge,
        )
        check(
          "a (0.15): found by the Applications lookup, LaunchServices not asked",
          !indexAsked && watched.capabilities.notes?.[0] === `Bridge: ${bridge}`,
          report.discovery,
        )
        check(
          "a (0.15): nothing in Documents or another protected folder touched",
          !touched.some((file) =>
            AgentDetect.PROTECTED_FOLDERS.some((name) => file.startsWith(path.join(os.homedir(), name) + "/")),
          ),
          report.discovery,
        )
        yield* Effect.promise(async () => {
          await fs.writeFile(
            shim,
            [
              "#!/bin/sh",
              '[ "$1" = "acp" ] || exit 64',
              `tee -a '${logs}/in.jsonl' | '${bridge}' acp --local-only | tee -a '${logs}/out.jsonl'`,
            ].join("\n"),
          )
          await fs.chmod(shim, 0o755)
        })
        const created = yield* post("/agenthq/agents", {
          name: "Kit",
          avatar: { kind: "initials", value: "K" },
          provider: "agentkit",
          launch: { command: shim, args: [] },
        })
        expect(created.status).toBe(200)
        const agentID = created.body.id as string
        const started = yield* time("sessionStart", post(`/agenthq/agents/${agentID}/sessions`, {}))
        expect(started.status).toBe(200)
        const session = started.body as AgentHQ.AgentSessionInfo
        remember()
        const exchange = { in: yield* rpc("in"), out: yield* rpc("out") }
        const initialize = exchange.out.find(
          (item) => item.id === exchange.in.find((x) => x.method === "initialize")?.id,
        )
        const opened = exchange.in.find((item) => item.method === "session/new")
        report.initialize = initialize?.result
        report.sessionNew = {
          cwd: opened?.params?.cwd,
          mcpServers: opened?.params?.mcpServers?.map((item: { name: string }) => item.name),
          result: exchange.out.find((item) => item.id === opened?.id)?.result,
        }
        remember()
        report.processes = [...seen.values()]
        report.socketsWhileRunning = yield* sockets()
        expect(initialize?.result?.agentCapabilities?.loadSession).toBe(false)
        expect(session.status).toBe("idle")

        if (mode === "1") {
          let mark = -1
          const ask = (text: string) =>
            Effect.gen(function* () {
              mark = (yield* detail(session.id)).history.at(-1)?.seq ?? -1
              const sent = Date.now()
              expect((yield* post(`/agenthq/sessions/${session.id}/messages`, { text })).status).toBe(200)
              remember()
              return sent
            })
          type Request = Extract<AgentHQ.AgentEvent, { type: "permission.requested" }>
          const proposal = (what: string) =>
            waitFor(
              session.id,
              (current): { request?: Request } | undefined => {
                const fresh = since(current.history, mark)
                const request = ofType(fresh, "permission.requested").find(
                  (item) => !ofType(fresh, "permission.resolved").some((done) => done.requestID === item.requestID),
                )
                if (request) return { request }
                if (ofType(fresh, "turn.completed").length || ["failed", "cancelled"].includes(current.session.status))
                  return {}
              },
              what,
            )
          const turnEnd = (what: string) =>
            waitFor(
              session.id,
              (current) =>
                ofType(since(current.history, mark), "turn.completed")[0] ??
                (["failed", "cancelled", "disconnected"].includes(current.session.status)
                  ? current.session.status
                  : undefined),
              what,
            )
          const answer = (request: Request, kind: string) =>
            post(`/agenthq/sessions/${session.id}/permissions/${request.requestID}`, {
              optionID: request.options.find((option) => option.kind === kind)!.id,
            })
          type Listed = { id: string; owner: { id: string }; files: { path: string; hunks: unknown[] }[] }
          const changesets = () =>
            call("/review/changesets").pipe(
              Effect.map((result) => (result.body as Listed[]).filter((item) => item.owner.id === session.id)),
            )
          // Everything the agent left in the project, apart from build output.
          const changed = Effect.promise(() =>
            $`git status --porcelain --untracked-files=all`.cwd(dir).quiet().text(),
          ).pipe(Effect.map((text) => text.split("\n").filter((line) => line.trim() && !line.includes(".build/"))))

          // ---- c. A declined proposal changes nothing.
          const askedSkip = yield* ask(`fix the build error in ${FILE}`)
          const decline = yield* proposal("no proposal to decline")
          report.skipProposalMs = Date.now() - askedSkip
          report.skipProposal = decline.request && { title: decline.request.title, options: decline.request.options }
          if (check("c: a fix is proposed (apply / skip)", !!decline.request, report.skipProposal)) {
            yield* answer(decline.request!, "reject_once")
            const skipEnd = yield* turnEnd("the declined turn never ended")
            check(
              "c: the declined turn ends with end_turn",
              (skipEnd as { stopReason?: string }).stopReason === "end_turn",
              skipEnd,
            )
            check(`c: ${FILE} is untouched`, yield* untouched, undefined)
            const rest = yield* changed
            check("c: nothing else changed in the project", rest.length === 0, rest)
            const status = yield* porcelain
            check("c (new): git status --porcelain is empty", status.length === 0, status)
            check("c (new): no .blaze in the project", !blaze(), undefined)
            const sets = yield* changesets()
            check(
              "c: no review changeset",
              sets.length === 0,
              sets.map((item) => item.files.map((file) => file.path)),
            )
          }

          // ---- d. Cancel in the middle of a turn: nothing recorded after it, nothing left on disk.
          const before = yield* changed
          const askedCancel = yield* ask(`fix the build error in ${FILE}`)
          // Mid-turn: a proposal waiting for the human, or the model still at work after three seconds.
          report.cancelAt = yield* waitFor(
            session.id,
            (current) => {
              const fresh = since(current.history, mark)
              if (ofType(fresh, "permission.requested").length) return "pending proposal"
              if (ofType(fresh, "turn.completed").length) return "turn already over"
              if (Date.now() - askedCancel > 3_000) return current.session.status
            },
            "the turn to cancel never started",
          )
          const cancelled = yield* post(`/agenthq/sessions/${session.id}/cancel`, {})
          check("d: cancel answers cancelled", cancelled.body?.status === "cancelled", cancelled.body?.status)
          yield* Effect.sleep("5 seconds")
          const afterCancel = (yield* detail(session.id)).history
          const at = afterCancel.findIndex((item) => item.event.type === "status" && item.event.status === "cancelled")
          const recorded = afterCancel.slice(at + 1).map((item) => item.event.type)
          check("d: nothing recorded after cancelled", at >= 0 && recorded.length === 0, recorded)
          check(`d: ${FILE} is untouched`, yield* untouched, undefined)
          const stray = (yield* changed).filter((line) => !before.includes(line))
          check("d: no stray edits", stray.length === 0, stray)
          check("d (new): no .blaze in the project", !blaze(), undefined)

          // ---- b. A fix is proposed, applied by the human, reviewed and accepted, and the package builds.
          const askedFix = yield* ask(`fix the build error in ${FILE}`)
          const fix = yield* proposal("no proposal for the fix")
          report.fixProposalMs = Date.now() - askedFix
          report.fixProposal = fix.request && { title: fix.request.title, options: fix.request.options }
          if (check("b: a fix is proposed", !!fix.request, report.fixProposal)) {
            const applied = Date.now()
            yield* answer(fix.request!, "allow_once")
            // An edit outside the approved places asks again; it is answered like any other request.
            let outside = yield* proposal("the fix never finished")
            while (outside.request) {
              report.outsideRequest = { title: outside.request.title, options: outside.request.options }
              yield* answer(outside.request, "allow_once")
              outside = yield* proposal("the fix never finished")
            }
            const fixEnd = yield* turnEnd("the fix turn never ended")
            report.fixApplyToEndMs = Date.now() - applied
            const fixed = since((yield* detail(session.id)).history, mark)
            report.fixTurn = {
              end: fixEnd,
              tools: ofType(fixed, "tool").map((item) => ({ tool: item.tool, state: item.state, title: item.title })),
              fileChanged: ofType(fixed, "file.changed").map((item) => item.path),
              answer: ofType(fixed, "message").at(-1)?.text?.slice(0, 400),
            }
            check(
              "b: the apply tool call completes",
              ofType(fixed, "tool").some((item) => item.state === "completed" && /apply/i.test(item.title ?? "")),
              report.fixTurn,
            )
            check(
              `b: file.changed reaches the session for ${FILE}`,
              ofType(fixed, "file.changed").some((item) => item.path === FILE),
              ofType(fixed, "file.changed").map((item) => item.path),
            )
            const set = (yield* changesets())[0]
            report.review = set?.files.map((file) => ({ path: file.path, hunks: file.hunks.length }))
            const listed = set?.files.find((file) => file.path === FILE)
            if (check(`b: review lists ${FILE} with hunks`, !!listed && listed.hunks.length > 0, report.review)) {
              const accepted = yield* post(`/review/changesets/${set!.id}/all`, { action: "accept" })
              check("b: review accepts the change", accepted.status === 200, accepted.status)
            }
            report.builds = yield* builds
            check("b: the package builds after the fix", report.builds === true, undefined)
            const status = yield* porcelain
            check(`b (new): only ${FILE} changed`, status.length === 1 && status[0] === ` M ${FILE}`, status)
            check(
              `b (new): review shows only ${FILE}`,
              JSON.stringify(set?.files.map((file) => file.path)) === JSON.stringify([FILE]),
              report.review,
            )
            check("b (new): no .blaze in the project", !blaze(), undefined)
          }

          // ---- e. Restart the IDE server: no session/load, a new AgentKit session, and the session says so.
          remember()
          yield* Effect.promise(() => server.stop(true))
          yield* Effect.sleep("2 seconds")
          report.afterStop = yield* left
          server = yield* Effect.promise(async () => Server.listen({ hostname: "127.0.0.1", port: await freePort() }))
          const restarted = server
          yield* Effect.addFinalizer(() => Effect.promise(() => restarted.stop(true)))
          report.afterRestart = (yield* detail(session.id)).session.status
          const askedAgain = yield* ask(`In one sentence: what does ${FILE} define?`)
          const replied = yield* proposal("the question after the restart never ended")
          if (replied.request) {
            // AgentKit's chat mode sometimes answers a question with a proposal; recorded, declined, not a failure.
            report.quirk = { title: replied.request.title }
            yield* answer(replied.request, "reject_once")
          }
          const questionEnd = yield* turnEnd("the question after the restart never ended")
          report.questionMs = Date.now() - askedAgain
          const resumed = since((yield* detail(session.id)).history, mark)
          report.restartTurn = {
            end: questionEnd,
            notice: ofType(resumed, "error").map((item) => item.message),
            answer: ofType(resumed, "message").at(-1)?.text?.slice(0, 300),
          }
          const methods = (yield* rpc("in")).flatMap((item) => (item.method ? [item.method] : []))
          report.methods = Object.fromEntries(
            [...new Set(methods)].map((name) => [name, methods.filter((m) => m === name).length]),
          )
          check("e: no session/load", !methods.includes("session/load"), report.methods)
          check(
            "e: a new AgentKit session after the restart",
            methods.filter((name) => name === "session/new").length === 2,
            report.methods,
          )
          check(
            "e: the session records that its history was not restored",
            ofType(resumed, "error").some((item) =>
              item.message.startsWith("This agent cannot restore a conversation"),
            ),
            report.restartTurn,
          )
          check(
            "e: the question after the restart is answered",
            (questionEnd as { type?: string }).type === "turn.completed",
            questionEnd,
          )
          check("e (new): no .blaze in the project", !blaze(), undefined)

          // ---- g. Crashes. A bridge starts its private daemon and a watcher (`agentkit-bridge watch <bridge pid> ...`),
          // each in a process group of its own. g1: SIGKILL the bridge; the watcher stops the daemon and removes the
          // socket and the state folder, with no new session. g2: SIGKILL a bridge and its watcher; the daemon and its
          // state stay until the next local-only session sweeps them.
          const crashOf = (pid: number | undefined) => {
            const kids = pid ? tree(pid) : []
            const daemons = [
              ...new Set([
                ...kids.filter((item) => /AgentDaemon/.test(item.command)).map((item) => item.pid),
                ...(pid ? holders(pid) : []),
              ]),
            ]
            const watchers = kids.filter((item) => /agentkit-bridge watch /.test(item.command)).map((item) => item.pid)
            const folder = path.join(os.tmpdir(), `agentkit-acp-${pid}`)
            const socket = `/tmp/ocn-acp-${pid}.sock`
            const left = () => ({
              daemons: daemons.filter(alive),
              watchers: watchers.filter(alive),
              socket: existsSync(socket),
              folder: existsSync(folder),
            })
            const gone = () => {
              const now = left()
              return !now.daemons.length && !now.watchers.length && !now.socket && !now.folder
            }
            return { pid, daemons, watchers, before: left(), left, gone }
          }
          const goneWithin = (crash: ReturnType<typeof crashOf>, seconds: number) =>
            Effect.gen(function* () {
              const from = Date.now()
              const done = yield* pollWithTimeout(
                Effect.sync(() => (crash.gone() ? true : undefined)),
                "the dead agent's state",
                `${seconds} seconds`,
              ).pipe(Effect.orElseSucceed(() => false))
              return { gone: done, ms: Date.now() - from, left: crash.left() }
            })
          const started = (crash: ReturnType<typeof crashOf>) =>
            crash.daemons.length > 0 &&
            crash.watchers.length === 1 &&
            Object.values(crash.before).every((value) => (Array.isArray(value) ? value.length > 0 : value))

          // g1: the bridge alone.
          remember()
          const first = crashOf(bridges()[0])
          if (first.pid) process.kill(first.pid, "SIGKILL")
          const firstAfter = yield* goneWithin(first, 15)
          report.crash = { pid: first.pid, daemons: first.daemons, watchers: first.watchers, ...firstAfter }
          check("g1 (0.15.1): the bridge had its private daemon and one watcher", started(first), first.before)
          check(
            "g1 (0.15.1): after SIGKILL of the bridge its daemon, watcher, socket and folder are gone, no new session",
            firstAfter.gone,
            firstAfter,
          )

          // g2: the bridge of a new session and its watcher, once both it and its daemon run.
          const second = yield* time("sessionAfterCrash", post(`/agenthq/agents/${agentID}/sessions`, {}))
          const ready = yield* pollWithTimeout(
            Effect.sync(() =>
              bridges().find((pid) => {
                const kids = tree(pid).map((item) => item.command)
                return (
                  pid !== first.pid &&
                  kids.some((command) => /AgentDaemon/.test(command)) &&
                  kids.some((command) => /agentkit-bridge watch /.test(command))
                )
              }),
            ),
            "the new session's bridge never ran its daemon and watcher",
            "15 seconds",
          ).pipe(Effect.orElseSucceed(() => undefined))
          remember()
          const victim = crashOf(ready)
          if (victim.pid) process.kill(victim.pid, "SIGKILL")
          for (const pid of victim.watchers) process.kill(pid, "SIGKILL")
          yield* Effect.sleep("3 seconds")
          const orphaned = victim.left()
          const third = yield* time("sessionAfterOrphan", post(`/agenthq/agents/${agentID}/sessions`, {}))
          remember()
          const swept = yield* goneWithin(victim, 20)
          report.orphan = { pid: victim.pid, daemons: victim.daemons, watchers: victim.watchers, orphaned, ...swept }
          check("g2 (0.15.1): new sessions start after the crashes", second.status === 200 && third.status === 200, [
            second.status,
            third.status,
          ])
          check("g2 (0.15.1): the second bridge had its private daemon and one watcher", started(victim), victim.before)
          check(
            "g2 (0.15.1): with bridge and watcher killed, the daemon, socket and folder stay until a new session",
            orphaned.daemons.length > 0 && orphaned.socket && orphaned.folder,
            orphaned,
          )
          check(
            "g2 (0.15.1): the next session's sweep stops the orphaned daemon and removes its socket and folder",
            swept.gone,
            swept,
          )
          // Stop whatever the crashes left (ours), so that f checks the rest on its own.
          for (const pid of [...first.daemons, ...first.watchers, ...victim.daemons].filter(alive))
            process.kill(pid, "SIGTERM")
        }

        // ---- f. Removing the identity ends the bridge's whole process group: nothing of ours is left.
        remember()
        const daemons = [...seen.values()].filter((command) => /AgentDaemon/.test(command))
        report.daemons = [...new Set(daemons)]
        check(
          "f (0.15): the private daemons are the app's own Contents/MacOS/AgentDaemon",
          daemons.length > 0 &&
            daemons.every(
              (command) =>
                command.startsWith(path.join(path.dirname(bridge), "AgentDaemon")) && !command.includes("ProjectBlaze"),
            ),
          report.daemons,
        )
        expect((yield* call(`/agenthq/agents/${agentID}`, { method: "DELETE" })).status).toBe(200)
        const cleanup = yield* pollWithTimeout(
          left.pipe(Effect.map((rest) => (rest.processes.length || rest.sockets.length ? undefined : rest))),
          "AgentKit processes or sockets survived",
          "20 seconds",
        ).pipe(Effect.catch(() => left))
        report.left = cleanup
        check(
          "f: no bridge or daemon process left, socket gone",
          cleanup.processes.length === 0 && cleanup.sockets.length === 0,
          cleanup,
        )
        report.stateHomes = [...stateHomes]
        check("f (new): the daemons' temp state folders were seen", stateHomes.size > 0, undefined)
        const kept = [...stateHomes].filter((home) => existsSync(home))
        check("f (new): the daemons' temp state folders are gone", kept.length === 0, kept)
        // New since the start, and ours: named after a bridge of this run (agentkit-acp-<pid>), or ocn-*/blaze.
        const tmpLeft = (yield* Effect.promise(scratch)).filter((item) => {
          if (tmpBefore.has(item)) return false
          const pid = path.basename(item).match(/agentkit-acp-(\d+)/)?.[1]
          return pid ? seen.has(Number(pid)) : true
        })
        report.tmpLeft = tmpLeft
        const locks = tmpLeft.filter((item) => item.endsWith(".lock"))
        const folders = tmpLeft.filter((item) => !item.endsWith(".lock"))
        check("f (new): no temp state of ours left in TMPDIR or /tmp", folders.length === 0, folders)
        check("f (new): no SwiftPM lock files of ours left in TMPDIR or /tmp", locks.length === 0, locks)
        expect(checks.filter((item) => !item.ok).map((item) => item.name)).toEqual([])
      }),
    1_800_000,
  )
})
