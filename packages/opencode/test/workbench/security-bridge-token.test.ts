// The Workbench MCP bridge's token (BridgeToken), against a real listener with a password, the way the desktop app
// runs the server. The inverse of the security review's repros: a token reaches only the bridge's endpoints, always as
// an agent, and only in its own session; the server password keeps reaching everything as the person; Agent HQ gives
// a bridge a token, never the password, and ends it with the session.
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Workbench } from "@opencode-ai/schema/workbench"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { BridgeToken } from "../../src/server/bridge-token"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { auth, listener } from "../fixture/agenthq/listener"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.promise(() => resetDatabase()),
        () => Effect.promise(() => resetDatabase()),
      ),
    ),
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)

// An exec-class repository check that drops a marker the moment it runs project code (the review's repro).
const config: Partial<ConfigV1.Info> = {
  workbench: {
    checks: { lint: { command: [process.execPath, "check.js"], files: ["src/**/*.txt"], format: "plain" } },
  },
}
const files = {
  "check.js": `require("fs").writeFileSync("RAN", "ran\\n")\nconsole.log("src/a.txt:1:1: error: boom")\nprocess.exit(1)\n`,
  "src/a.txt": "one\n",
}

const PASSWORD = `Basic ${btoa(`${auth.username}:${auth.password}`)}`

/** A request to the listener as `authorization`, in `dir`; the status and the body. */
const as =
  (url: URL, dir: string, authorization: string) =>
  (route: string, init: { method?: string; body?: unknown } = {}) =>
    Effect.promise(async () => {
      const response = await fetch(new URL(route, url), {
        method: init.method ?? "GET",
        headers: {
          authorization,
          "x-opencode-directory": dir,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as any }
    })

/** A token for `directory`, ended when the test is over. */
const token = (directory: string) =>
  Effect.acquireRelease(
    Effect.sync(() => BridgeToken.mint(directory)),
    (minted) => Effect.sync(() => BridgeToken.revoke(minted)),
  )

describe("workbench bridge token", () => {
  it.live("a token always checks as an agent, whatever the body says; the server password checks as the person", () =>
    Effect.gen(function* () {
      const { server } = yield* listener
      const dir = yield* tmpdirScoped({ git: true, config })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body)
      })
      const ran = Effect.promise(() => fs.readFile(path.join(dir, "RAN"), "utf8").catch(() => ""))
      const check = (authorization: string) =>
        as(server.url, dir, authorization)("/workbench/check", { method: "POST", body: { unit: ".", trigger: "user" } })

      // The review's bypass, with a token: trigger "user" in the body, and still skipped until the human approves.
      const agent = yield* check(`Bearer ${yield* token(dir)}`)
      expect(agent.status).toBe(200)
      const skipped = (agent.body as Workbench.VerificationReport).checks.map((item) => [
        item.run.status,
        item.run.reason,
      ])
      expect(skipped).toEqual([["skipped", "needs approval in the IDE"]])
      expect(yield* ran).toBe("")

      // The person (the server password) still runs it at once.
      const person = yield* check(PASSWORD)
      expect(person.status).toBe(200)
      const runs = (person.body as Workbench.VerificationReport).checks.map((item) => [
        item.run.checker,
        item.run.status,
      ])
      expect(runs).toEqual([["lint", "failed"]])
      expect(yield* ran).toBe("ran\n")
    }),
  )

  it.live(
    "a token reaches only the bridge's endpoints and its own session; anything else is 403, a dead token 401",
    () =>
      Effect.gen(function* () {
        const { server } = yield* listener
        const dir = yield* tmpdirScoped({ git: true })
        const minted = yield* token(dir)
        const bridge = as(server.url, dir, `Bearer ${minted}`)
        const person = as(server.url, dir, PASSWORD)

        // The bridge's endpoints.
        expect((yield* bridge("/workbench/problems")).status).toBe(200)
        expect((yield* bridge("/workbench/doctor")).status).toBe(200)
        expect((yield* bridge("/workbench/tools")).status).toBe(200)
        const own = yield* bridge("/workbench/session", { method: "POST", body: {} })
        expect(own.status).toBe(200)
        expect((yield* bridge("/workbench/session", { method: "POST", body: {} })).body).toEqual(own.body)
        // Its agent tools run in its own session (here tool_create refuses the empty arguments: 400), never in another
        // one, such as a session of the person's with the approvals saved there.
        const tool = { tool: "tool_create", args: {} }
        expect(
          (yield* bridge("/workbench/tools/agent", { method: "POST", body: { ...tool, sessionID: own.body.id } }))
            .status,
        ).toBe(400)
        const theirs = (yield* person("/session", { method: "POST", body: { title: "the person's" } })).body
          .id as string
        const foreign = { method: "POST", body: { ...tool, sessionID: theirs } }
        expect((yield* bridge("/workbench/tools/agent", foreign)).status).toBe(403)
        const debug = { method: "POST", body: { sessionID: theirs, action: "status" } }
        expect((yield* bridge("/workbench/debug/agent", debug)).status).toBe(403)

        // Everything else, the person's routes above all.
        const denied = [
          ["POST", "/agenthq/sessions/ags_x/permissions/req_x", { optionID: "allow" }],
          ["GET", "/agenthq/agents"],
          ["POST", "/workbench/debug/sessions", {}],
          ["GET", "/workbench/file?path=check.js"],
          ["GET", "/workbench/search?query=x"],
          ["PUT", "/workbench/file", { path: "a.txt", content: "x", baseHash: "x" }],
          ["GET", "/workbench/runs"],
          // An agent cannot turn on auto-approve, not even for the session it works in.
          ["PUT", `/workbench/sessions/${own.body.id}/auto-approve`, { edits: true, commands: true }],
          ["GET", `/workbench/sessions/${own.body.id}/auto-approve`],
          // Nor save, list or remove "Always allow in this project" rules.
          ["POST", "/workbench/permissions/per_x/save", {}],
          ["GET", "/workbench/approvals"],
          ["DELETE", "/workbench/approvals", { permission: "bash", pattern: "*" }],
          ["POST", "/workbench/tools", { name: "x", description: "x", source: "x" }],
          ["GET", "/session"],
          ["POST", "/session", { title: "mine" }],
          ["POST", `/session/${theirs}/permissions/per_x`, { response: "always" }],
          ["GET", "/permission"],
          ["GET", "/global/health"],
        ] as const
        for (const [method, route, body] of denied)
          expect([route, (yield* bridge(route, { method, body })).status]).toEqual([route, 403])
        // The server password keeps reaching them.
        expect((yield* person("/session")).status).toBe(200)
        expect((yield* person("/agenthq/agents")).status).toBe(200)

        // A token that ended, or one never made, is no credential at all.
        BridgeToken.revoke(minted)
        expect((yield* bridge("/workbench/problems")).status).toBe(401)
        expect((yield* as(server.url, dir, "Bearer made-up")("/workbench/problems")).status).toBe(401)
      }),
  )

  it.live("a token reaches only its own directory: another project, a subfolder, a worktree or its parent is 403", () =>
    Effect.gen(function* () {
      const { server } = yield* listener
      const project = yield* tmpdirScoped({ git: true })
      const other = yield* tmpdirScoped({ git: true })
      // A worktree of the project, the way an isolated task gets one, and a symlink to the project.
      const place = yield* tmpdirScoped()
      const worktree = path.join(place, "worktree")
      const link = path.join(place, "link")
      const sub = path.join(project, "src")
      yield* Effect.promise(async () => {
        await $`git worktree add -q ${worktree}`.cwd(project).quiet()
        await fs.symlink(project, link)
        await fs.mkdir(sub)
      })
      const own = yield* token(project)
      const tree = yield* token(worktree)
      const check = { method: "POST", body: { files: [] } }
      const reach = (minted: string, directory: string, route = "/workbench/problems", init = {}) =>
        as(server.url, directory, `Bearer ${minted}`)(route, init).pipe(Effect.map((result) => result.status))

      // Its own directory, however it is spelled: as given, through a symlink, URI-encoded as the instance decodes it.
      expect(yield* reach(own, project)).toBe(200)
      expect(yield* reach(own, project, "/workbench/check", check)).toBe(200)
      expect(yield* reach(own, link)).toBe(200)
      expect(yield* reach(own, encodeURIComponent(project))).toBe(200)
      // Another project, a folder inside its own, a worktree of it; and the worktree's token on the project.
      expect(yield* reach(own, other)).toBe(403)
      expect(yield* reach(own, other, "/workbench/check", check)).toBe(403)
      expect(yield* reach(own, other, "/workbench/session", { method: "POST", body: {} })).toBe(403)
      expect(yield* reach(own, sub)).toBe(403)
      expect(yield* reach(own, worktree)).toBe(403)
      expect(yield* reach(tree, project)).toBe(403)
      expect(yield* reach(tree, project, "/workbench/check", check)).toBe(403)
      expect(yield* reach(tree, worktree)).toBe(200)
      // `?directory=` wins over the header, as in routing; another workspace is never its own; no directory at all is
      // this server's working directory, not the project.
      expect(yield* reach(own, project, `/workbench/problems?directory=${encodeURIComponent(other)}`)).toBe(403)
      expect(yield* reach(own, other, `/workbench/problems?directory=${encodeURIComponent(project)}`)).toBe(200)
      expect(yield* reach(own, project, "/workbench/problems?workspace=wrk_x")).toBe(403)
      const bare = yield* Effect.promise(() =>
        fetch(new URL("/workbench/problems", server.url), { headers: { authorization: `Bearer ${own}` } }),
      )
      expect(bare.status).toBe(403)
    }),
  )

  it.live("Agent HQ gives the bridge a token, never the server password, and ends it with the session", () =>
    Effect.gen(function* () {
      const { server } = yield* listener
      const dir = yield* tmpdirScoped({ git: true })
      const person = as(server.url, dir, PASSWORD)
      // A scripted ACP agent that records the session/new params it gets.
      const record = path.join(dir, "..", `${path.basename(dir)}-session.json`)
      const agentScript = path.join(dir, "..", `${path.basename(dir)}-agent`)
      yield* Effect.promise(async () => {
        await fs.writeFile(
          agentScript,
          [
            "#!/bin/sh",
            `export FAKE_ACP_RECORD='${record}'`,
            `exec '${process.execPath}' '${path.join(import.meta.dir, "../fixture/agenthq/fake-acp-agent.ts")}'`,
          ].join("\n"),
        )
        await fs.chmod(agentScript, 0o755)
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all([fs.rm(record, { force: true }), fs.rm(agentScript, { force: true })])),
      )
      const created = yield* person("/agenthq/agents", {
        method: "POST",
        body: {
          name: "Relay",
          avatar: { kind: "preset", value: "robot" },
          provider: "acp",
          launch: { command: agentScript, args: [] },
        },
      })
      expect(created.status).toBe(200)
      expect((yield* person(`/agenthq/agents/${created.body.id}/sessions`, { method: "POST", body: {} })).status).toBe(
        200,
      )

      const text = yield* Effect.promise(() => fs.readFile(record, "utf8"))
      expect(text).not.toContain(auth.password)
      const [workbench] = JSON.parse(text).mcpServers as { args: string[]; env: { name: string; value: string }[] }[]
      expect(workbench.env.map((item) => item.name)).toEqual(["OPENCODE_SERVER_TOKEN"])
      expect(workbench.args.join(" ")).not.toContain(workbench.env[0]!.value)
      const bridge = as(server.url, dir, `Bearer ${workbench.env[0]!.value}`)
      expect((yield* bridge("/workbench/problems")).status).toBe(200)
      expect((yield* bridge("/agenthq/agents")).status).toBe(403)

      // Removing the identity closes its session, and the token ends with it.
      expect((yield* person(`/agenthq/agents/${created.body.id}`, { method: "DELETE" })).status).toBe(200)
      expect((yield* bridge("/workbench/problems")).status).toBe(401)

      // An agent that works in a worktree of the project (as an isolated task does) gets a token for the worktree.
      const place = yield* tmpdirScoped()
      const worktree = path.join(place, "worktree")
      yield* Effect.promise(() => $`git worktree add -q ${worktree}`.cwd(dir).quiet())
      const isolated = yield* person("/agenthq/agents", {
        method: "POST",
        body: {
          name: "Isolated",
          avatar: { kind: "preset", value: "robot" },
          provider: "acp",
          projectDirectory: dir,
          workingDirectory: worktree,
          launch: { command: agentScript, args: [] },
        },
      })
      expect(isolated.status).toBe(200)
      expect((yield* person(`/agenthq/agents/${isolated.body.id}/sessions`, { method: "POST", body: {} })).status).toBe(
        200,
      )
      const [inTree] = JSON.parse(yield* Effect.promise(() => fs.readFile(record, "utf8"))).mcpServers as {
        args: string[]
        env: { name: string; value: string }[]
      }[]
      expect(inTree.args.at(-1)).toBe(worktree)
      const treeToken = `Bearer ${inTree.env[0]!.value}`
      expect((yield* as(server.url, worktree, treeToken)("/workbench/problems")).status).toBe(200)
      expect((yield* as(server.url, dir, treeToken)("/workbench/problems")).status).toBe(403)
      expect((yield* person(`/agenthq/agents/${isolated.body.id}`, { method: "DELETE" })).status).toBe(200)
    }),
  )
})
