// spicy: the git panel routes against real temporary repositories: stage, commit, branches, the dirty-switch refusal,
// push to a local bare remote (and a rejected push), pull requests with a fake gh on PATH (never the real one), and
// commit messages from the config's small_model only.
import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../../src/server/server"
import { clean, parseStatus } from "../../../src/workbench/git/panel"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { testProviderConfig } from "../../lib/test-provider"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function client(directory: string) {
  const app = Server.Default().app
  const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await app.request(`/workbench/git${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as any }
  }
  return {
    status: () => call("GET", "/status"),
    stage: (paths: string[]) => call("POST", "/stage", { paths }),
    unstage: (paths: string[]) => call("POST", "/unstage", { paths }),
    commit: (message: string) => call("POST", "/commit", { message }),
    push: (body: { setUpstream?: boolean; remote?: string } = {}) => call("POST", "/push", body),
    branches: () => call("GET", "/branches"),
    create: (name: string, switching?: boolean) =>
      call("POST", "/branches", { name, ...(switching ? { switch: true } : {}) }),
    switch: (name: string) => call("POST", "/switch", { name }),
    pr: (body: { title?: string; body?: string } = {}) => call("POST", "/pr", body),
    message: () => call("POST", "/message"),
  }
}

const sh =
  (cwd: string) =>
  (strings: TemplateStringsArray, ...values: string[]) =>
    $(strings, ...values)
      .cwd(cwd)
      .quiet()
      .text()
      .then((text) => text.trim())

// A bare repository as origin, with an extra clone for pushing from "someone else".
async function remote(repo: string) {
  const bare = path.join(repo, "..", path.basename(repo) + "-origin.git")
  await $`git init -q --bare ${bare}`.quiet()
  await $`git remote add origin ${bare}`.cwd(repo).quiet()
  return bare
}

describe("workbench git panel", () => {
  test("status, stage and unstage inside the repository only, commit", async () => {
    await using tmp = await tmpdir({ git: true })
    const api = client(tmp.path)
    const git = sh(tmp.path)
    await Bun.write(path.join(tmp.path, "a.txt"), "one\n")

    const first = await api.status()
    expect(first.status).toBe(200)
    expect(first.body.branch).toBe(await git`git branch --show-current`)
    expect(first.body.untracked).toContainEqual({ path: "a.txt", state: "untracked" })
    expect(first.body.generate.available).toBe(false)
    expect(first.body.generate.reason).toContain("small_model")

    const staged = await api.stage(["a.txt"])
    expect(staged.status).toBe(200)
    expect(staged.body.staged).toEqual([{ path: "a.txt", state: "added" }])
    expect((await api.unstage(["a.txt"])).body.untracked).toContainEqual({ path: "a.txt", state: "untracked" })

    for (const outside of ["../escape.txt", "/etc/hosts", ""]) {
      const refused = await api.stage([outside])
      expect(refused.status).toBe(400)
    }
    expect((await api.stage([])).status).toBe(400)

    expect((await api.commit("anything")).status).toBe(409) // nothing staged
    await api.stage(["a.txt"])
    expect((await api.commit("  ")).status).toBe(400)
    const committed = await api.commit("Add a.txt\n\nThe first file.")
    expect(committed.status).toBe(200)
    expect(committed.body.subject).toBe("Add a.txt")
    expect(committed.body.sha).toBe(await git`git rev-parse HEAD`)
    expect(await git`git log -1 --format=%B`).toBe("Add a.txt\n\nThe first file.")

    // Modified (unstaged), then staged; a rename shows its old path.
    await Bun.write(path.join(tmp.path, "a.txt"), "two\n")
    expect((await api.status()).body.unstaged).toEqual([{ path: "a.txt", state: "modified" }])
    await api.stage(["a.txt"])
    await api.commit("Change a.txt")
    await git`git mv a.txt b.txt`
    expect((await api.status()).body.staged).toEqual([{ path: "b.txt", state: "renamed", from: "a.txt" }])
  })

  test("branches: create, switch, refuse a dirty switch with a reason, refuse bad names", async () => {
    await using tmp = await tmpdir({ git: true })
    const api = client(tmp.path)
    const git = sh(tmp.path)
    const main = await git`git branch --show-current`
    await Bun.write(path.join(tmp.path, "a.txt"), "one\n")
    await api.stage(["a.txt"])
    await api.commit("Add a.txt")

    const created = await api.create("feature")
    expect(created.status).toBe(200)
    expect(created.body.current).toBe(main)
    expect(created.body.branches.map((item: { name: string }) => item.name).sort()).toEqual([main, "feature"].sort())
    expect((await api.create("feature")).status).toBe(409)
    for (const bad of ["bad..name", "-x", "", "a b"]) expect((await api.create(bad)).status).toBe(400)
    expect((await api.switch("missing")).status).toBe(404)

    // A tracked change blocks the switch, with the files named; nothing moves.
    await Bun.write(path.join(tmp.path, "a.txt"), "edited\n")
    const refused = await api.switch("feature")
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain("uncommitted changes")
    expect(JSON.stringify(refused.body)).toContain("a.txt")
    expect(await git`git branch --show-current`).toBe(main)
    expect(await fs.readFile(path.join(tmp.path, "a.txt"), "utf8")).toBe("edited\n")

    // An untracked file does not block it.
    await git`git checkout -- a.txt`
    await Bun.write(path.join(tmp.path, "note.txt"), "untracked\n")
    const switched = await api.switch("feature")
    expect(switched.status).toBe(200)
    expect(switched.body.current).toBe("feature")
    expect(await git`git branch --show-current`).toBe("feature")

    // Create and switch in one step keeps the working tree.
    const topic = await api.create("topic", true)
    expect(topic.body.current).toBe("topic")
    expect(await fs.readFile(path.join(tmp.path, "note.txt"), "utf8")).toBe("untracked\n")
  })

  test("push: an explicit --set-upstream choice, then the upstream; a rejected push is reported, never forced", async () => {
    await using tmp = await tmpdir({ git: true })
    const api = client(tmp.path)
    const git = sh(tmp.path)
    const branch = await git`git branch --show-current`
    expect(JSON.stringify((await api.push()).body)).toContain("no remote")
    const bare = await remote(tmp.path)

    const asked = await api.push()
    expect(asked.status).toBe(409)
    expect(JSON.stringify(asked.body)).toContain("--set-upstream")
    expect((await api.push({ setUpstream: true, remote: "nope" })).status).toBe(400)

    const published = await api.push({ setUpstream: true })
    expect(published.status).toBe(200)
    expect(published.body.upstream).toBe(`origin/${branch}`)
    expect((await api.status()).body.upstream).toBe(`origin/${branch}`)

    await Bun.write(path.join(tmp.path, "a.txt"), "one\n")
    await api.stage(["a.txt"])
    await api.commit("Add a.txt")
    expect((await api.status()).body.ahead).toBe(1)
    const pushed = await api.push()
    expect(pushed.status).toBe(200)
    expect(await $`git --git-dir ${bare} log -1 --format=%s ${branch}`.quiet().text()).toBe("Add a.txt\n")
    expect((await api.status()).body.ahead).toBe(0)

    // Someone else pushes first: ours is rejected with git's reason and the remote keeps their commit.
    const other = path.join(tmp.path, "..", path.basename(tmp.path) + "-other")
    await $`git clone -q ${bare} ${other}`.quiet()
    try {
      await $`git -c user.email=o@o -c user.name=O -c commit.gpgsign=false commit -q --allow-empty -m theirs`
        .cwd(other)
        .quiet()
      await $`git push -q origin HEAD:${branch}`.cwd(other).quiet()
      await Bun.write(path.join(tmp.path, "a.txt"), "ours\n")
      await api.stage(["a.txt"])
      await api.commit("Ours")
      const rejected = await api.push()
      expect(rejected.status).toBe(409)
      expect(JSON.stringify(rejected.body)).toMatch(/rejected|fetch first|non-fast-forward/)
      expect(await $`git --git-dir ${bare} log -1 --format=%s ${branch}`.quiet().text()).toBe("theirs\n")
    } finally {
      await fs.rm(other, { recursive: true, force: true })
      await fs.rm(bare, { recursive: true, force: true })
    }
  })

  test("pull requests go through gh on PATH (a fake one here) once the branch is pushed", async () => {
    await using tmp = await tmpdir({ git: true })
    const api = client(tmp.path)
    const bin = path.join(tmp.path, "..", path.basename(tmp.path) + "-bin")
    const calls = path.join(bin, "calls.txt")
    await fs.mkdir(bin, { recursive: true })
    await Bun.write(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${calls}"`,
        'if [ "$FAKE_GH_FAIL" = "1" ]; then echo "a pull request for this branch already exists" >&2; exit 1; fi',
        "echo 'Creating pull request for feature into main'",
        "echo 'https://github.com/acme/demo/pull/7'",
      ].join("\n"),
    )
    await fs.chmod(path.join(bin, "gh"), 0o755)
    const saved = process.env.PATH
    try {
      expect(JSON.stringify((await api.pr()).body)).toContain("no remote")
      const bare = await remote(tmp.path)
      try {
        expect(JSON.stringify((await api.pr()).body)).toContain("push")
        await api.push({ setUpstream: true })

        process.env.PATH = "/usr/bin:/bin"
        const missing = await api.pr()
        expect(missing.status).toBe(409)
        expect(JSON.stringify(missing.body)).toContain("gh")

        process.env.PATH = `${bin}:${saved}`
        const filled = await api.pr()
        expect(filled.status).toBe(200)
        expect(filled.body.url).toBe("https://github.com/acme/demo/pull/7")
        const titled = await api.pr({ title: "Add the parser", body: "Details" })
        expect(titled.status).toBe(200)
        expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toEqual([
          "pr create --fill",
          "pr create --title Add the parser --body Details",
        ])
        process.env.FAKE_GH_FAIL = "1"
        const failed = await api.pr()
        expect(failed.status).toBe(409)
        expect(JSON.stringify(failed.body)).toContain("already exists")
      } finally {
        await fs.rm(bare, { recursive: true, force: true })
      }
    } finally {
      process.env.PATH = saved
      delete process.env.FAKE_GH_FAIL
      await fs.rm(bin, { recursive: true, force: true })
    }
  })

  test("commit messages come from the config's small_model only", async () => {
    const prompts: string[] = []
    const model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { messages?: { content?: unknown }[] }
        prompts.push(JSON.stringify(body.messages))
        const chunk = (delta: object, finish?: string) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
        return new Response(
          chunk({ role: "assistant", content: "```\nAdd the greeting\n\nSays hello.\n```" }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      // A model is configured, but no small_model: nothing is picked automatically.
      await using plain = await tmpdir({
        git: true,
        config: { ...testProviderConfig(`http://127.0.0.1:${model.port}/v1`), model: "test/test-model" },
      })
      const off = client(plain.path)
      expect((await off.status()).body.generate.available).toBe(false)
      await Bun.write(path.join(plain.path, "hello.txt"), "hello\n")
      await off.stage(["hello.txt"])
      expect((await off.message()).status).toBe(409)
      // A small_model that does not resolve is not replaced by another model either.
      await using missing = await tmpdir({
        git: true,
        config: { ...testProviderConfig(`http://127.0.0.1:${model.port}/v1`), small_model: "test/no-such-model" },
      })
      const unresolved = client(missing.path)
      expect((await unresolved.status()).body.generate).toMatchObject({ available: false, model: "test/no-such-model" })
      await Bun.write(path.join(missing.path, "hello.txt"), "hello\n")
      await unresolved.stage(["hello.txt"])
      expect((await unresolved.message()).status).toBe(409)
      expect(prompts).toEqual([])

      await using tmp = await tmpdir({
        git: true,
        config: { ...testProviderConfig(`http://127.0.0.1:${model.port}/v1`), small_model: "test/test-model" },
      })
      const api = client(tmp.path)
      const status = (await api.status()).body
      expect(status.generate).toEqual({ available: true, model: "test/test-model" })
      expect((await api.message()).status).toBe(409) // nothing staged
      await Bun.write(path.join(tmp.path, "hello.txt"), "hello\n")
      await api.stage(["hello.txt"])
      const generated = await api.message()
      expect(generated.status).toBe(200)
      expect(generated.body).toEqual({ message: "Add the greeting\n\nSays hello.", model: "test/test-model" })
      expect(prompts.at(-1)).toContain("hello.txt")
    } finally {
      model.stop(true)
    }
  })
})

test("parseStatus reads porcelain v2", () => {
  const text = [
    "# branch.oid 1234",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
    "1 .M N... 100644 100644 100644 aaa bbb with space.txt",
    "1 MD N... 100644 100644 000000 aaa bbb both.txt",
    "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt",
    "old.txt",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
    "? fresh.txt",
    "",
  ].join("\0")
  expect(parseStatus(text)).toEqual({
    branch: "main",
    head: "1234",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    staged: [
      { path: "staged.txt", state: "modified" },
      { path: "both.txt", state: "modified" },
      { path: "new.txt", state: "renamed", from: "old.txt" },
    ],
    unstaged: [
      { path: "with space.txt", state: "modified" },
      { path: "both.txt", state: "deleted" },
      { path: "conflict.txt", state: "conflicted" },
    ],
    untracked: [{ path: "fresh.txt", state: "untracked" }],
  })
  expect(clean('<think>hm</think>\n"Fix the bug"')).toBe("Fix the bug")
})
