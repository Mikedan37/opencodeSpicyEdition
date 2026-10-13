#!/usr/bin/env bun
// spicy: end-to-end smoke of the real desktop app, driven over the Chrome DevTools Protocol. No macOS screen
// recording is involved: screenshots come from Page.captureScreenshot. The model is scripts/spicy-model.ts, so
// nothing reaches a real provider.
//
//   bun scripts/spicy-smoke.ts [--mode built|dev] [--out DIR] [--root DIR]
//
// One isolated root, one fixture project (a git repo), every step through the UI:
// - Launch: isolated launch, sidecar reachable, Dock icon loaded, open the project, bottom panel Agents tab.
// - Agents: create "Felix" on the OpenCode provider, start a session, the reply streams (screenshots mid-stream and
//   after, plus the agenthq.session.event stream from the server), the session gets its generated title, cancel a
//   running turn with nothing recorded after it, close and reopen the panel with the conversation kept.
// - Tasks: an isolated task for Felix (and a second one that waits on it) from the Tasks view; started, its write
//   asks first and is answered "Allow once" in the task's session, the review gate's dry run, Approve (a click)
//   merges it and removes its worktree and branch.
// - Review: Felix edits two files, each write answered in the UI; Review > Agent changes: accept one hunk, reject the
//   other, reject the second file from the file view; the files on disk match.
// - Editor: README.md from the file tree; typing marks the tab unsaved and Cmd+S writes it; a save over a change on
//   disk shows the conflict bar and Reload from disk shows the disk; closing the window with an unsaved edit, answered
//   Cancel (OPENCODE_SPICY_UNSAVED_ANSWER), keeps the window, the text and the sidecar.
// - Problems and Output: Run checks fails on the fixture's type error (tsc from this tree), Output shows the run,
//   Problems lists the error.
// - Debug: debugpy (VS Code's bundled copy, on Homebrew Python) runs app.py from launch.json in a terminal: paused on
//   entry, the stop brings app.py forward, a click in the editor's gutter sets a breakpoint, F5 to it, the stack and
//   variables, a Debug Console evaluation, F5 to the end, the Run tab's exit code and output.
// - Activity: the tab renders (no investigations yet).
// - Tools: New tool drafts a tool (nothing runs), it waits under Drafts with the badge, Approve enables it, a Test run
//   returns its output, Disable, then Delete, which asks first.
// - Quit mid-turn the way the menu does (app.quit()) and restart on the same root: the record says interrupted right
//   after the quit, history recovered. After the restart (answer: discard), an unsaved edit does not stop the quit.
//   No process of the app is left after each quit. Afterwards the throwaway keychain is deleted, and the real
//   keychain and the crash reports folder are unchanged.
//
// A section that fails is recorded and the run goes on with the next one. Opening the project: the app adds projects
// through the native folder picker, which CDP cannot drive, so the smoke creates the project's first session through
// the server API (what the app does on the first prompt) and opens it through the app's own restore of the window's
// last URL. Apart from that the API and the disk are only read, to check what the UI did.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, symlink } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"
import { $ } from "bun"
import { alive, cleanup, DESKTOP_DIR, launch, processTree, type Launched, type Mode } from "./spicy-launch"
import { connectRenderer, CTRL, evaluateMain, META, query, type Renderer } from "./spicy-cdp"
import { demoConfig, INTRO, serveScriptedModel, SLOW, type Reply } from "./spicy-model"

// ---------------------------------------------------------------- fixture

const TEN = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((word) => `${word}\n`)
const A = TEN.join("")
const A_EDITED = A.replace("two\n", "TWO\n").replace("nine\n", "NINE\n")
const A_REVIEWED = A.replace("two\n", "TWO\n") // first hunk accepted, second rejected
const B = "alpha\nbeta\ngamma\n"
// The editor's file: saved once, changed on disk under an unsaved edit (conflict, reload), then kept through a
// cancelled window close and saved; after the restart an unsaved edit is discarded by the quit.
const README = "# Felix demo\n\nA scratch project for the Spicy desktop smoke run.\n"
const README_SAVED = README.replace("# Felix demo", "# Felix demo (edited)")
const THEIRS = "# Changed on disk\n\nBy the human.\n"
const README_KEPT = THEIRS.replace("# Changed on disk", "# Changed on disk (kept)")
const B_EDITED = B.replace("beta", "BETA")
const TASK = {
  title: "Write the task note",
  description: "WRITE notes/task.txt",
  file: "notes/task.txt",
  content: "A note from Felix's task.\n",
}
// Ends normally: nothing here aborts or crashes under the debugger.
const APP = [
  "def total(items):",
  "    result = 0",
  "    for item in items:",
  "        result += item",
  "    return result",
  "",
  "",
  "def main():",
  "    numbers = [3, 4, 5]",
  "    answer = total(numbers)",
  '    print(f"answer = {answer}")',
  "",
  "",
  "main()",
  "",
].join("\n")
const BREAKPOINT = APP.split("\n").findIndex((line) => line.includes("print(")) + 1
const SCRIPTS: Record<string, Reply[]> = {
  "Edit a.txt and b.txt": [
    { tool: "write", input: { filePath: "a.txt", content: A_EDITED } },
    { tool: "write", input: { filePath: "b.txt", content: B_EDITED } },
    { text: "Edited a.txt and b.txt." },
  ],
  [TASK.description]: [
    { tool: "write", input: { filePath: TASK.file, content: TASK.content } },
    { text: `Wrote ${TASK.file}.` },
  ],
}

// ---------------------------------------------------------------- run

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}
const mode = (arg("--mode") as Mode | undefined) ?? "built"
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")
const out = path.resolve(arg("--out") ?? path.join(import.meta.dir, "../../../docs/spicy/desktop-smoke", stamp))
await mkdir(out, { recursive: true })

type Check = { name: string; ok: boolean; ms: number; detail?: string; skipped?: true }
type Task = {
  id: string
  title: string
  status: string
  assignee: string
  isolated: boolean
  reason?: string
  worktree?: { path: string; branch: string }
  result?: { sessionID?: string }
}
type DebugSession = {
  id: string
  adapter: string
  state: string
  ptyID?: string
  error?: string
  stop?: { reason: string; frames: { name: string; line?: number }[] }
}
// Assistant message texts in the Agents workspace (the Markdown body, without the author label), with typographic
// quotes and whitespace normalized.
const ASSISTANT = `[...document.querySelectorAll('[data-row="message"][data-role="assistant"]')].map((row) => (row.querySelector(':scope > [data-component="markdown"]') ?? row).textContent.replace(/[‘’]/g, "'").replace(/\\s+/g, " ").trim())`
// The unsaved-changes dot of a side-panel tab.
const DIRTY = '#review-panel [data-slot="tab-unsaved"]'
const checks: Check[] = []
const shots: string[] = []
const model = serveScriptedModel({ scripts: SCRIPTS })
const config = demoConfig(model.url)
let app: Launched | undefined
let renderer: Renderer | undefined

async function step<T>(name: string, run: () => Promise<T>, detail?: (value: T) => string) {
  const started = Date.now()
  try {
    const value = await run()
    checks.push({ name, ok: true, ms: Date.now() - started, detail: detail?.(value) })
    console.log(`ok    ${name}${detail ? `: ${detail(value)}` : ""}`)
    return value
  } catch (error) {
    checks.push({ name, ok: false, ms: Date.now() - started, detail: String(error) })
    console.log(`FAIL  ${name}: ${error}`)
    if (renderer) await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {})
    throw error
  }
}

function skip(name: string, reason: string) {
  checks.push({ name, ok: true, ms: 0, detail: reason, skipped: true })
  console.log(`skip  ${name}: ${reason}`)
}

// A failed section is already recorded by its failing step; close whatever dialog it left open and go on.
async function section(run: () => Promise<unknown>) {
  await run().catch(() => renderer?.press("Escape", { code: "Escape", keyCode: 27 }).catch(() => {}))
}

async function shot(name: string) {
  const file = await renderer!.screenshot(path.join(out, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`))
  shots.push(file)
  return file
}

const lines: string[] = []
// Read-only snapshots of the owner's real keychain setup and crash reports, compared after the run.
const keychainBefore = realKeychain()
const reportsBefore = crashReports()
if (arg("--root")) await mkdir(arg("--root")!, { recursive: true })
const root = realpathSync(arg("--root") ?? (await mkdtemp(path.join(tmpdir(), "spicy-desktop-"))))
// Fixture git runs as the app's does: the fake home, no system config, so no owner hooks, signing or identity.
const gitEnv = { ...process.env, HOME: path.join(root, "home"), GIT_CONFIG_NOSYSTEM: "1" }
const project = await createProject(path.join(root, "felix-demo"))
const dir = `?directory=${encodeURIComponent(project)}`
const tscMissing = await provideTsc(project)
const debugpyMissing = await provideDebugpy(path.join(root, "home"))
const pluginMissing = await providePlugin(project)
const read = (file: string) => readFile(path.join(project, file), "utf8").catch(() => "")
const git = (...args: string[]) => spawnSync("git", args, { cwd: project, env: gitEnv, encoding: "utf8" }).stdout.trim()

try {
  // ---------------------------------------------------------------- launch
  app = await step(
    "launch isolated",
    () => launch({ mode, root, config, log: (line) => lines.push(line) }),
    (value) => `root ${value.root}, DevTools port ${value.port}`,
  )
  renderer = await step("renderer over CDP", () => connectRenderer(app!.port))
  const server = await step(
    "sidecar ready",
    () => sidecar(renderer!),
    (value) => value.url,
  )
  await step("sidecar reachable from the renderer", () =>
    renderer!
      .evaluate<number>(
        `window.api.awaitInitialization().then((s) => fetch(s.url + "/global/health", { headers: { authorization: "Basic " + btoa(s.username + ":" + s.password) } })).then((r) => r.status)`,
      )
      .then(expectEqual(200)),
  )
  await step(
    "server state is isolated",
    async () => {
      const paths = await api<{ home: string; state: string; config: string }>(server, "GET", "/path")
      for (const value of [paths.home, paths.state, paths.config])
        if (!value.startsWith(root)) throw new Error(`${value} is outside ${root}`)
      return paths
    },
    (paths) => `home ${paths.home}`,
  )
  await step("home shell rendered", () =>
    renderer!.waitFor(`document.querySelector('[data-component="home-session-search"]')`, "home"),
  )
  await shot("home")
  await step(
    "dock icon loaded (log)",
    () => dockIconLog(app!.userData),
    (value) => value,
  )

  // ---------------------------------------------------------------- project, Agents tab, Felix
  await step(
    "open project",
    async () => {
      const session = await api<{ id: string }>(server, "POST", `/session${dir}`, { title: "Felix demo" })
      await openUrl(renderer!, `/server/${btoa("sidecar").replace(/=/g, "")}/session/${session.id}`)
      await renderer!.waitFor(
        `document.querySelector('[data-component="session-prompt-dock"]')`,
        "session page",
        40_000,
      )
      return session.id
    },
    (id) => `${project} (session ${id})`,
  )
  await openAgentsTab(renderer)
  await shot("agents-empty")
  const felix = await step(
    "create Felix on the OpenCode provider",
    async () => {
      await renderer!.click('[data-action="agenthq-new"]')
      await renderer!.type('[data-component="agenthq-dialog"] input[name="name"]', "Felix")
      await step(
        "the new-agent dialog lists AgentKit (available with its Bridge note, or a reason)",
        async () => {
          const row = '[data-component="agenthq-dialog"] label[data-provider="agentkit"]'
          await renderer!.waitFor(exists(row), "the AgentKit row")
          const available = await renderer!.evaluate<boolean>(`!${query(`${row} input`)}?.disabled`)
          const text = (await renderer!.evaluate<string>(textOf(row))).replace(/\s+/g, " ").trim()
          if (available ? !text.includes("Bridge: ") : text === "AgentKit") throw new Error(`row: "${text}"`)
          if (available) await renderer!.click(`${row} input[type="radio"]`) // picked, then OpenCode below
          return `${available ? "available" : "unavailable"}: ${text}`
        },
        (value) => value,
      ).catch(() => {})
      await renderer!.click('[data-component="agenthq-dialog"] label[data-provider="opencode"] input[type="radio"]')
      await shot("create-dialog")
      await renderer!.click('[data-component="agenthq-dialog"] button[type="submit"]')
      await renderer!.waitFor(
        `document.querySelector('[data-component="agenthq-card"], [data-component="agenthq-workspace"]')`,
        "Felix in the roster",
      )
      const agents = await api<{ id: string; name: string; provider: string; projectDirectory: string }[]>(
        server,
        "GET",
        `/agenthq/agents${dir}`,
      )
      const felix = agents.find((agent) => agent.name === "Felix")
      if (!felix || felix.provider !== "opencode" || felix.projectDirectory !== project)
        throw new Error(`unexpected agents ${JSON.stringify(agents)}`)
      return felix
    },
    (felix) => felix.id,
  )
  const sessionID = await step(
    "start a session",
    async () => {
      if (!(await renderer!.evaluate(exists('[data-component="agenthq-workspace"]'))))
        await renderer!.click('[data-component="agenthq-card"]')
      await renderer!.click('[data-action="agenthq-start-session"]')
      await renderer!.waitFor(`document.querySelector('[data-component="agenthq-composer"] textarea')`, "composer")
      return renderer!.waitFor<string>(
        `document.querySelector('[data-session]')?.getAttribute("data-session")`,
        "session id",
      )
    },
    (id) => id,
  )

  // ---------------------------------------------------------------- agents: streamed reply, title, cancel
  await section(async () => {
    const events = listen(server, project, sessionID)
    await step("send a message", () => send(renderer!, "Hi Felix, introduce yourself."))
    await step("reply streams into the workspace", () =>
      renderer!.waitFor(
        `(() => { const text = ${ASSISTANT}.at(-1) ?? ""; return text.length > 15 && text.length < ${INTRO.length} && ${statusIs("working")} })()`,
        "partial assistant text while working",
      ),
    )
    await shot("streaming")
    await step("turn completes with the scripted reply", async () => {
      await renderer!.waitFor(statusIs("idle"), "idle after the turn", 30_000)
      // The finished message is re-rendered as Markdown off the main thread, so wait for its text to settle.
      await renderer!
        .waitFor(`${ASSISTANT}.at(-1)?.includes(${JSON.stringify(INTRO)})`, "the full scripted reply")
        .catch(async () => {
          throw new Error(`assistant text was: ${await renderer!.evaluate<string>(`${ASSISTANT}.at(-1) ?? ""`)}`)
        })
    })
    await shot("reply")
    await step(
      "server streamed agenthq.session.event envelopes",
      async () => {
        await Bun.sleep(300)
        const types = events.envelopes.map((item) => item.event.type)
        const seqs = events.envelopes.map((item) => item.seq)
        if (!types.includes("message.delta") || !types.includes("turn.completed"))
          throw new Error(`event types: ${types.join(", ")}`)
        if (seqs.some((seq, index) => index > 0 && seq !== seqs[index - 1] + 1))
          throw new Error(`seq gap: ${seqs.join(",")}`)
        const deltas = types.filter((type) => type === "message.delta").length
        events.stop()
        return `${events.envelopes.length} envelopes, ${deltas} deltas, seq ${seqs[0]}..${seqs.at(-1)}`
      },
      (value) => value,
    )
    await step(
      "the session has its generated title, not Untitled session",
      async () => {
        await renderer!.waitFor(
          `${textOf(`[data-component="agenthq-workspace"] [data-session="${sessionID}"]`)}.includes("Felix demo")`,
          "the title in the session list",
        )
        const detail = await api<{ session: { title?: string } }>(server, "GET", `/agenthq/sessions/${sessionID}${dir}`)
        if (detail.session.title !== "Felix demo") throw new Error(`title ${JSON.stringify(detail.session.title)}`)
        return detail.session.title
      },
      (title) => title,
    )
    await step("cancel a running turn", async () => {
      await send(renderer!, "Please give me a slow, very long answer.")
      await renderer!.waitFor(
        `document.querySelector('[data-action="agenthq-cancel"]') && ${ASSISTANT}.at(-1)?.includes("Paragraph 1")`,
        "slow reply streaming",
      )
      await renderer!.click('[data-action="agenthq-cancel"]')
      await renderer!.waitFor(statusIs("cancelled"), "cancelled")
      const request = model.requests.findLast((item) => item.kind === "chat" && item.prompt.includes("slow"))
      await until(() => request?.aborted === true, "the model request to be aborted")
    })
    await shot("cancelled")
    await step(
      "nothing arrives after the cancel (no repeated text)",
      async () => {
        await Bun.sleep(500) // a late delta would land in this window
        const text = await renderer!.evaluate<string>(`${ASSISTANT}.at(-1) ?? ""`)
        if (!text.startsWith("Paragraph 1") || !SLOW.startsWith(text))
          throw new Error(`the cancelled reply is not a prefix of the scripted text: "…${text.slice(-160)}"`)
        const detail = await api<{ history: { event: { type: string; status?: string } }[] }>(
          server,
          "GET",
          `/agenthq/sessions/${sessionID}${dir}`,
        )
        const at = detail.history.findLastIndex(
          (item) => item.event.type === "status" && item.event.status === "cancelled",
        )
        const late = detail.history.slice(at + 1).map((item) => item.event.type)
        if (at < 0 || late.length) throw new Error(`after "cancelled": ${late.join(", ") || "no cancelled status"}`)
        return `${text.length} characters shown, a prefix of the scripted reply; nothing recorded after "cancelled"`
      },
      (value) => value,
    )
    await step("close and reopen the panel keeps the conversation", async () => {
      await renderer!.press("`", { code: "Backquote", keyCode: 192, modifiers: CTRL })
      await renderer!.waitFor(`!document.querySelector('#terminal-panel')`, "panel closed")
      await openAgentsTab(renderer!)
      await openSession(renderer!, sessionID)
      await renderer!.waitFor(
        `${ASSISTANT}.some((text) => text.includes(${JSON.stringify(INTRO.slice(0, 40))}))`,
        "conversation after reopening",
      )
    })
    await shot("reopened")
  })

  // ---------------------------------------------------------------- tasks
  await section(async () => {
    await step("Tasks view", async () => {
      await backToList(renderer!)
      await renderer!.click('[data-agenthq-view="tasks"]')
      await renderer!.waitFor(exists('[data-component="agenthq-tasks"] [data-action="task-new"]'), "Tasks view")
    })
    const task = await step(
      "create an isolated task for Felix",
      async () => {
        await renderer!.click('[data-action="task-new"]')
        await renderer!.type('[data-component="task-dialog"] input[name="title"]', TASK.title)
        await renderer!.type('[data-component="task-dialog"] textarea[name="description"]', TASK.description)
        const form = await renderer!.evaluate<{ assignee: string; isolated: boolean }>(
          `(() => { const form = document.querySelector('[data-component="task-dialog"]'); return { assignee: form.querySelector('select[name="assignee"]').value, isolated: form.querySelector('input[name="isolated"]').checked } })()`,
        )
        if (form.assignee !== felix.id || !form.isolated) throw new Error(`dialog defaults ${JSON.stringify(form)}`)
        await shot("task-dialog")
        await renderer!.click('[data-component="task-dialog"] button[type="submit"]')
        await renderer!.waitFor(`!document.querySelector('[data-component="task-dialog"]')`, "the dialog to close")
        const tasks = await api<Task[]>(server, "GET", `/agenthq/tasks${dir}`)
        const created = tasks.find((item) => item.title === TASK.title)
        if (!created || created.status !== "ready" || !created.isolated || created.assignee !== felix.id)
          throw new Error(`tasks ${JSON.stringify(tasks)}`)
        return created
      },
      (value) => value.id,
    )
    const waiting = await step(
      "a second task that depends on it waits",
      async () => {
        await renderer!.click('[data-action="task-new"]')
        await renderer!.type('[data-component="task-dialog"] input[name="title"]', "Read the task note")
        await renderer!.click(`[data-component="task-dialog"] [data-depends-on="${task.id}"]`)
        await renderer!.click('[data-component="task-dialog"] button[type="submit"]')
        await renderer!.waitFor(`!document.querySelector('[data-component="task-dialog"]')`, "the dialog to close")
        return renderer!.waitFor<string>(
          `(() => { const row = [...document.querySelectorAll('button[data-task]')].find((el) => el.textContent.includes("Read the task note")); return row?.querySelector('[data-slot="task-reason"]')?.textContent.includes(${JSON.stringify(`Waiting on "${TASK.title}"`)}) && row.dataset.task })()`,
          "its waiting reason",
        )
      },
      (id) => id,
    ).catch(() => undefined)
    const started = await step(
      "start the task: a worktree and a session",
      async () => {
        await renderer!.click(`button[data-task="${task.id}"]`)
        await renderer!.click(`[data-component="agenthq-task"][data-task="${task.id}"] [data-action="task-start"]`)
        return pollTask(server, task.id, (item) => item.status === "running" && !!item.worktree, "running")
      },
      (value) => `${value.worktree!.branch} at ${value.worktree!.path}`,
    )
    await step("its write waits for approval; Allow once in the task's session", async () => {
      await renderer!.click(
        `[data-component="agenthq-task"][data-task="${task.id}"] [data-slot="task-approval"] button`,
      )
      await renderer!.waitFor(
        `document.querySelector('[data-component="agenthq-workspace"] [data-session="${started.result?.sessionID}"]')?.getAttribute("aria-current") === "true"`,
        "the task's session",
      )
      await renderer!.waitFor(exists('[data-row="permission"] [data-option="once"]'), "the permission request")
      await shot("task-permission")
      await renderer!.click('[data-row="permission"] [data-option="once"]')
      await pollTask(server, task.id, (item) => item.status === "review", "review")
    })
    const gate = `[data-component="agenthq-task"][data-task="${task.id}"] [data-component="agenthq-review"]`
    await step(
      "review gate: the dry run shows the branch, commit and file",
      async () => {
        await renderer!.click('[data-component="agenthq-workspace"] button[aria-label="Back to agents"]')
        await renderer!.waitFor(
          `${textOf(`${gate} [data-slot="review-files"]`)}.includes(${JSON.stringify(TASK.file)})`,
          "the dry run",
        )
        if (await renderer!.evaluate(`!!${query(`${gate} [data-action="task-approve"]`)}?.disabled`))
          throw new Error(
            `Approve is disabled: ${await renderer!.evaluate(textOf(`${gate} [data-slot="review-refusal"]`))}`,
          )
        await shot("task-review")
        return `${await renderer!.evaluate(textOf(`${gate} [data-slot="review-merge"]`))} ${await renderer!.evaluate(textOf(`${gate} [data-slot="review-commits"]`))}`
      },
      (value) => value,
    )
    await step("Approve (a click) merges the task", async () => {
      await renderer!.click(`${gate} [data-action="task-approve"]`)
      await renderer!.waitFor(
        `${query(`button[data-task="${task.id}"] [data-task-status]`)}?.getAttribute("data-task-status") === "done"`,
        "done",
      )
      await shot("task-done")
    })
    await step(
      "the project has the merge; no worktree or task branch is left",
      async () => {
        if ((await read(TASK.file)) !== TASK.content) throw new Error(`${TASK.file}: ${await read(TASK.file)}`)
        const subject = git("log", "-1", "--format=%s")
        const worktrees = git("worktree", "list", "--porcelain")
          .split("\n")
          .filter((line) => line.startsWith("worktree ")).length
        const branches = git("branch", "--list", "task-*")
        if (
          subject !== `Merge task: ${TASK.title}` ||
          worktrees !== 1 ||
          branches ||
          existsSync(started.worktree!.path)
        )
          throw new Error(`last commit "${subject}", ${worktrees} worktrees, branches "${branches}"`)
        return `"${subject}", 1 worktree, no task branch, ${started.worktree!.path} gone`
      },
      (value) => value,
    )
    if (waiting)
      await step("the dependent task is ready", () =>
        pollTask(server, waiting, (item) => item.status === "ready", "ready"),
      ).catch(() => {})
  })

  // ---------------------------------------------------------------- review: agent changes
  await section(async () => {
    await step("Felix edits a.txt and b.txt; each write is answered in the UI", async () => {
      await openSession(renderer!, sessionID)
      await send(renderer!, "Edit a.txt and b.txt, please.")
      for (const [file, content] of [
        ["a.txt", A_EDITED],
        ["b.txt", B_EDITED],
      ]) {
        await renderer!.click('[data-row="permission"] [data-option="once"]')
        await until(async () => (await read(file)) === content, `${file} written`)
      }
      await renderer!.waitFor(statusIs("idle"), "the turn to end")
    })
    await step("Review panel, Agent changes: Felix's changeset with both files pending", async () => {
      if (await renderer!.evaluate(exists('[aria-controls="review-panel"][aria-expanded="false"]')))
        await renderer!.click('[aria-controls="review-panel"][aria-expanded="false"]')
      await renderer!.click("#session-side-panel-review-tab")
      await renderer!.click('#review-panel [data-component="select-v2"]')
      await renderer!.click('[data-component="menu-v2-item"]', "Agent changes")
      await renderer!.waitFor(
        `${textOf('[data-component="review-changeset"] [data-component="review-agent"]')}.includes("Felix")`,
        "Felix's changeset",
      )
      for (const file of ["a.txt", "b.txt"])
        await renderer!.waitFor(`${stateOf(file)} === "pending"`, `${file} pending`)
    })
    await step("git bar: one line that says to review first while hunks are pending", async () => {
      await renderer!.waitFor(
        `${textOf('[data-component="git-commit-area"][data-state="collapsed"] [data-slot="git-unreviewed"]')} === "Review agent changes first"`,
        "the collapsed git bar",
      )
      const bar = await renderer!.evaluate<{ height: number; disabled: boolean }>(`(() => {
        const bar = document.querySelector('[data-component="git-commit-area"]')
        return { height: bar.getBoundingClientRect().height, disabled: bar.querySelector('[data-action="git-expand"]').disabled }
      })()`)
      if (bar.height > 40 || !bar.disabled) throw new Error(`bar ${JSON.stringify(bar)}`)
    })
    await step("a.txt: accept one hunk, reject the other", async () => {
      await renderer!.click('[data-component="review-file-row"][data-path="a.txt"]')
      await renderer!.waitFor(`${count('[data-component="review-hunk"]')} === 2`, "two hunks")
      await renderer!.waitFor(oneLine('[data-component="review-hunk"] button'), "hunk bar labels on one line")
      await shot("review-hunks")
      await renderer!.click('[data-component="review-hunk"] [data-action="accept"]')
      await renderer!.waitFor(`${count('[data-component="review-hunk"]')} === 1`, "one hunk left")
      if ((await read("a.txt")) !== A_EDITED) throw new Error("accepting a hunk changed a.txt")
      await renderer!.click('[data-component="review-hunk"] [data-action="reject"]')
      await until(async () => (await read("a.txt")) === A_REVIEWED, "a.txt to keep only the accepted hunk")
      // one hunk kept and one reverted: the file is partly kept (UX finding #9)
      await renderer!.waitFor(`${stateOf("a.txt")} === "partial"`, "a.txt reviewed")
      await shot("review-a")
    })
    await step("b.txt: reject the file from the file view", async () => {
      await renderer!.click('[data-component="review-file-row"][data-path="b.txt"]')
      await renderer!.click('[data-action="open-file"]')
      await renderer!.waitFor(
        exists('[data-component="review-file"][data-path="b.txt"] [data-component="review-bar"]'),
        "the review bar in the file view",
      )
      await renderer!.waitFor(oneLine('[data-component="review-bar"] button'), "review bar labels on one line")
      await shot("review-file-view")
      await renderer!.click('[data-component="review-file"][data-path="b.txt"] [data-action="reject-file"]')
      await until(async () => (await read("b.txt")) === B, "b.txt restored")
      await renderer!.click("#session-side-panel-review-tab")
      await renderer!.waitFor(`${stateOf("b.txt")} === "rejected"`, "b.txt rejected")
      await shot("review-done")
    })
    await step(
      "the files on disk and the changeset agree",
      async () => {
        if ((await read("a.txt")) !== A_REVIEWED || (await read("b.txt")) !== B) throw new Error("files changed since")
        const changesets = await api<{ counts: Record<string, number> }[]>(server, "GET", `/review/changesets${dir}`)
        const counts = changesets.map((item) => item.counts)
        if (counts.length !== 1 || counts[0].pending !== 0 || counts[0].accepted !== 1 || counts[0].rejected !== 2)
          throw new Error(JSON.stringify(counts))
        return `a.txt keeps TWO only, b.txt as committed; ${JSON.stringify(counts[0])}`
      },
      (value) => value,
    )
    await step(
      "git bar: Commit… opens the commit area once the review is done, within 40% of the panel",
      async () => {
        const area = '[data-component="git-commit-area"]'
        await renderer!.click(`${area} [data-action="git-expand"]`)
        await renderer!.waitFor(exists(`${area}[data-state="expanded"]`), "the commit area")
        const share = await renderer!.evaluate<number>(`(() => {
          const area = document.querySelector('${area}')
          return area.getBoundingClientRect().height / area.parentElement.getBoundingClientRect().height
        })()`)
        if (share > 0.41) throw new Error(`the commit area takes ${Math.round(share * 100)}% of the panel`)
        await shot("git-commit-area")
        // Back to the bar for the steps that follow.
        await renderer!.click(`${area} [data-action="git-collapse"]`)
        await renderer!.waitFor(exists(`${area}[data-state="collapsed"]`), "the bar again")
        return `${Math.round(share * 100)}% of the panel`
      },
      (value) => value,
    )
  })

  // ---------------------------------------------------------------- editor: save, conflict, unsaved close
  await section(async () => {
    const editor = '#review-panel [data-component="workbench-editor"][data-path="README.md"]'
    await step("README.md opens from the file tree in the editor", async () => {
      await openInEditor(renderer!, "README.md")
      if (await renderer!.evaluate(exists(DIRTY))) throw new Error("a fresh buffer is marked unsaved")
      if ((await renderer!.evaluate<string>(editorText(editor))) !== README)
        throw new Error("the editor text differs from disk")
    })
    await step("typing marks the tab unsaved; Cmd+S writes the file", async () => {
      await typeAtEnd(renderer!, editor, " (edited)")
      await renderer!.waitFor(exists(DIRTY), "the unsaved dot")
      await shot("editor-unsaved")
      await renderer!.press("s", { code: "KeyS", keyCode: 83, modifiers: META })
      await renderer!.waitFor(`!${exists(DIRTY)}`, "the dot to go")
      await until(async () => (await read("README.md")) === README_SAVED, "README.md on disk")
    })
    await step(
      "an unsaved edit over a change on disk: Cmd+S shows the conflict, Reload from disk shows the disk",
      async () => {
        await typeAtEnd(renderer!, editor, "!")
        await renderer!.waitFor(exists(DIRTY), "the unsaved dot")
        await Bun.write(path.join(project, "README.md"), THEIRS) // the human changes the file outside the app
        await renderer!.press("s", { code: "KeyS", keyCode: 83, modifiers: META })
        await renderer!.waitFor(exists(`${editor} [data-slot="editor-conflict"]`), "the conflict bar")
        if ((await read("README.md")) !== THEIRS) throw new Error("the refused save wrote the file")
        await shot("editor-conflict")
        await renderer!.click(`${editor} [data-slot="editor-conflict"] [data-action="reload"]`)
        await renderer!.waitFor(`!${exists(`${editor} [data-slot="editor-conflict"]`)}`, "the conflict bar to go")
        await renderer!.waitFor(`${editorText(editor)} === ${JSON.stringify(THEIRS)}`, "the editor to show the disk")
        if (await renderer!.evaluate(exists(DIRTY))) throw new Error("still unsaved after the reload")
      },
    )
    await step(
      "closing the window with an unsaved edit, answered Cancel, keeps it",
      async () => {
        await typeAtEnd(renderer!, editor, " (kept)")
        await renderer!.waitFor(exists(DIRTY), "the unsaved dot")
        await evaluateMain(
          app!.inspect,
          `require("electron").BrowserWindow.getAllWindows().find((win) => win.isVisible())?.close()`,
        )
        await Bun.sleep(1_000)
        const windows = await evaluateMain<number>(
          app!.inspect,
          `require("electron").BrowserWindow.getAllWindows().length`,
        )
        if (windows !== 1) throw new Error(`${windows} windows after the cancelled close`)
        if (!(await renderer!.evaluate(exists(DIRTY)))) throw new Error("the unsaved dot is gone")
        if (!(await renderer!.evaluate<string>(editorText(editor))).startsWith("# Changed on disk (kept)"))
          throw new Error("the unsaved text is gone")
        const health = await renderer!.evaluate<number>(
          `window.api.awaitInitialization().then((s) => fetch(s.url + "/global/health", { headers: { authorization: "Basic " + btoa(s.username + ":" + s.password) } })).then((r) => r.status)`,
        )
        if (health !== 200) throw new Error(`sidecar health ${health}`)
        await shot("editor-close-cancelled")
        await renderer!.press("s", { code: "KeyS", keyCode: 83, modifiers: META })
        await renderer!.waitFor(`!${exists(DIRTY)}`, "the dot to go")
        await until(async () => (await read("README.md")) === README_KEPT, "README.md saved after the cancel")
        return "1 window, text and dot kept, sidecar health 200; then saved"
      },
      (value) => value,
    )
  })

  // ---------------------------------------------------------------- problems and output
  if (tscMissing) skip("problems and output", tscMissing)
  else
    await section(async () => {
      await step(
        "Output: Run checks fails on the type error",
        async () => {
          await panelTab(renderer!, "output")
          await renderer!.click('[data-component="workbench-output"] button', "Run checks")
          const id = await renderer!.waitFor<string>(
            `[...document.querySelectorAll('[data-component="workbench-output"] section[data-run][data-status="failed"]')].find((el) => el.querySelector("button")?.textContent.includes("tsc"))?.dataset.run`,
            "a failed tsc run",
            90_000,
          )
          if (
            await renderer!.evaluate(
              `${query(`section[data-run="${id}"] > button`)}?.getAttribute("aria-expanded") === "false"`,
            )
          )
            await renderer!.click(`section[data-run="${id}"] > button`)
          await renderer!.waitFor(`${textOf(`section[data-run="${id}"]`)}.includes("broken.ts")`, "the run's output")
          await renderer!.waitFor(exists('[data-component="workbench-output"] [data-slot="report"]'), "the summary")
          await shot("output")
          return `${id}; ${await renderer!.evaluate(textOf('[data-component="workbench-output"] [data-slot="report"]'))}`
        },
        (value) => value,
      )
      await step(
        "Problems lists the error",
        async () => {
          await panelTab(renderer!, "problems")
          await renderer!.waitFor(
            `[...document.querySelectorAll('[data-component="workbench-problems"] [data-row="problem"]')].some((row) => row.textContent.includes("not assignable"))`,
            "the tsc problem",
          )
          const snapshot = await api<{
            problems: { file?: string; severity: string; message: string; source: { tool: string } }[]
          }>(server, "GET", `/workbench/problems${dir}`)
          const problem = snapshot.problems.find(
            (item) => item.source.tool === "tsc" && !!item.file?.endsWith("/src/broken.ts"),
          )
          if (problem?.severity !== "error") throw new Error(JSON.stringify(snapshot.problems))
          await shot("problems")
          return `${problem.severity}: ${problem.message}`
        },
        (value) => value,
      )
    })

  // ---------------------------------------------------------------- debug
  if (debugpyMissing) skip("debug", debugpyMissing)
  else
    await section(async () => {
      const dialog = '[data-component="debug-start-dialog"]'
      await step(
        "F5: app.py from launch.json, paused on entry",
        async () => {
          await renderer!.press("F5", { code: "F5", keyCode: 116 })
          await renderer!.waitFor(
            `${query(`${dialog} select[name="configuration"]`)}?.value === "App in terminal"`,
            "the launch.json configuration",
          )
          await renderer!.click(`${dialog} [data-slot="checkbox-v2-control"]`)
          await renderer!.waitFor(
            exists(`${dialog} [data-slot="checkbox-v2"][data-checked]`),
            "Pause on the first line",
          )
          await shot("debug-start")
          await renderer!.click(`${dialog} button[type="submit"]`)
          const outcome = await renderer!.waitFor<string>(
            `(() => { const error = ${query(`${dialog} [data-slot="debug-start-error"]`)}; if (error) return "refused: " + error.textContent; return !${query(dialog)} && "started" })()`,
            "the debugger to start",
            60_000,
          )
          if (outcome !== "started") throw new Error(outcome)
          return pollDebug(
            server,
            (item) => item.state === "stopped" && item.stop?.reason === "entry",
            "paused on entry",
          )
        },
        (value) => `${value.id} (${value.adapter}), program in pty ${value.ptyID ?? "none"}`,
      )
      const appEditor = '#review-panel [data-component="workbench-editor"][data-path="app.py"]'
      const tab = '#review-panel [role="tab"]'
      const front = await step("the stop brings app.py forward", () =>
        renderer!.waitFor(`!!${query(tab, "app.py")}?.hasAttribute("data-selected")`, "app.py's tab in front", 10_000),
      ).then(
        () => true,
        () => false,
      )
      await step(
        `a click in the editor's gutter sets a breakpoint on line ${BREAKPOINT}`,
        async () => {
          if (!front) await renderer!.click(tab, "app.py")
          await renderer!.waitFor(exists(`${appEditor} .cm-line[data-spicy-exec]`), "app.py at the paused line")
          await shot("debug-entry")
          await renderer!.click(`${appEditor} .cm-lineNumbers .cm-gutterElement`, String(BREAKPOINT))
          await renderer!.waitFor(
            exists(`${appEditor} [data-spicy-glyph][data-line="${BREAKPOINT}"][data-spicy-breakpoint="line"]`),
            "the breakpoint dot",
          )
          return front ? "app.py came forward by itself" : "after clicking app.py's tab"
        },
        (value) => value,
      )
      await step(
        "F5 runs to the breakpoint",
        async () => {
          await Bun.sleep(1_500) // ponytail: the breakpoint request shows no pending state; a missed stop fails below
          await renderer!.press("F5", { code: "F5", keyCode: 116 })
          const session = await pollDebug(
            server,
            (item) => item.stop?.reason === "breakpoint" || item.state === "terminated" || item.state === "failed",
            "a breakpoint stop",
          )
          const frame = session.stop?.frames[0]
          if (session.state !== "stopped" || frame?.line !== BREAKPOINT)
            throw new Error(`${session.state} ${session.error ?? ""} at ${JSON.stringify(frame)}`)
          return `${frame.name} app.py:${frame.line}`
        },
        (value) => value,
      )
      const side = '#review-panel [data-component="workbench-debug"]'
      await step(
        "Debug tab: stack and variables",
        async () => {
          await renderer!.click('#review-panel [data-workbench-side-tab="debug"]')
          await renderer!.waitFor(
            `${textOf(`${side} [data-slot="debug-status"]`)} === "Paused: breakpoint"`,
            "the status",
          )
          await renderer!.waitFor(`${count(`${side} [data-frame]`)} >= 2`, "the call stack")
          await renderer!.waitFor(`${textOf(`${side} [data-variable="answer"]`)}.includes("12")`, "answer = 12")
          await shot("debug-breakpoint")
          return renderer!.evaluate<string>(
            `[...document.querySelectorAll('${side} [data-frame] [data-slot="frame"]')].map((el) => el.textContent.trim()).join(" < ")`,
          )
        },
        (value) => value,
      )
      const debugConsole = '[data-component="workbench-debug-console"]'
      await step("Debug Console evaluates in the paused frame", async () => {
        await panelTab(renderer!, "debug")
        await renderer!.waitFor(
          `${query(`${debugConsole} [data-slot="debug-console-input"]`)}?.disabled === false`,
          "input",
        )
        await renderer!.type(`${debugConsole} [data-slot="debug-console-input"]`, "answer * 2")
        await Bun.sleep(500) // completions are debounced; an open list would take the Enter
        if (await renderer!.evaluate(exists(`${debugConsole} [data-slot="debug-console-input"][aria-controls]`)))
          await renderer!.press("Escape", { code: "Escape", keyCode: 27 })
        await renderer!.press("Enter", { code: "Enter", keyCode: 13 })
        await renderer!.waitFor(
          `[...document.querySelectorAll('${debugConsole} [data-console-row][data-kind="result"]')].some((row) => row.textContent.includes("24"))`,
          "the result 24",
        )
        await shot("debug-console")
      })
      await step(
        "F5 to the end: Run tab shows the exit code, output in the console",
        async () => {
          await renderer!.press("F5", { code: "F5", keyCode: 116 })
          const session = await pollDebug(
            server,
            (item) => item.state === "terminated" || item.state === "failed",
            "the end",
          )
          if (session.state !== "terminated") throw new Error(`${session.state}: ${session.error}`)
          await panelTab(renderer!, "run")
          await renderer!.waitFor(
            `${textOf('[data-component="workbench-run"] [data-slot="run-status"]')} === "Exited with code 0"`,
            "Exited with code 0",
          )
          await renderer!.waitFor(
            `${textOf('[data-component="workbench-run"]')}.includes("answer = 12")`,
            "the program's output in the Run tab",
          )
          await shot("debug-run")
          const rows = await api<{ kind: string; text: string }[]>(
            server,
            "GET",
            `/workbench/debug/sessions/${session.id}/output${dir}&after=0`,
          )
          if (!rows.some((row) => row.kind === "stdout" && row.text.includes("answer = 12")))
            throw new Error(`no "answer = 12" in ${JSON.stringify(rows.map((row) => `${row.kind}: ${row.text}`))}`)
          const left = (await processTree(app!.child.pid!)).filter((item) => /debugpy|app\.py/.test(item.command))
          if (left.length) throw new Error(`still running: ${left.map((item) => item.command).join("; ")}`)
          return `${rows.length} console rows; no debugpy process left`
        },
        (value) => value,
      )
    })

  // ---------------------------------------------------------------- activity
  await section(() =>
    step("Activity tab renders (no investigations yet)", async () => {
      await panelTab(renderer!, "activity")
      await renderer!.waitFor(
        `${textOf('[data-component="workbench-activity"]')}.includes("No investigations yet")`,
        "the empty state",
      )
      const list = await api<unknown[]>(server, "GET", `/workbench/investigations${dir}`)
      if (list.length) throw new Error(`${list.length} investigations`)
      await shot("activity")
    }),
  )

  // ---------------------------------------------------------------- tools: draft, approve, test run, disable, delete
  if (pluginMissing) skip("tools", pluginMissing)
  else
    await section(async () => {
      const panel = '[data-component="workbench-tools"]'
      const detail = `${panel} [data-component="workbench-tool"][data-tool="greet"]`
      const status = `${query(detail)}?.getAttribute("data-status")`
      const onDisk = (file: string) => existsSync(path.join(project, ".opencode", file))
      await step("Tools: New tool drafts greet; it waits under Drafts and nothing runs", async () => {
        await panelTab(renderer!, "tools")
        await renderer!.waitFor(`${textOf(panel)}.includes("No tools yet")`, "the empty Tools tab")
        await renderer!.click(`${panel} [data-action="tool-new"]`)
        const form = `${panel} [data-component="workbench-tool-new"]`
        await renderer!.waitFor(`${textOf(`${form} .cm-content`)}.includes("@opencode-ai/plugin")`, "the template")
        await renderer!.type(`${form} input[name="name"]`, "greet")
        await renderer!.type(`${form} input[name="description"]`, "Greets someone")
        await shot("tools-new")
        await renderer!.click(`${form} [data-action="tool-save"]`)
        await renderer!.waitFor(`${status} === "draft"`, "the draft")
        await renderer!.waitFor(
          `${textOf(`${panel} [data-tool-group="draft"] [data-tool="greet"]`)}.includes("You")`,
          "greet under Drafts, by You",
        )
        await renderer!.waitFor(`${textOf('[data-workbench-tab="tools"]')}.includes("1")`, "the tab's badge")
        if (!onDisk("tool-drafts/greet.ts") || onDisk("tool/custom_greet.ts"))
          throw new Error("expected only the draft file before approval")
        await shot("tools-draft")
      })
      await step(
        "Approve (a click) enables custom_greet; a Test run returns its output",
        async () => {
          await renderer!.click(`${detail} [data-action="tool-approve"]`)
          await renderer!.waitFor(`${status} === "enabled"`, "enabled")
          await renderer!.waitFor(exists(`${panel} [data-tool-group="enabled"] [data-tool="greet"]`), "under Enabled")
          if (!onDisk("tool/custom_greet.ts") || onDisk("tool-drafts/greet.ts"))
            throw new Error("the files did not move")
          const listed = await api<{ name: string; status: string; inputSchema?: unknown }[]>(
            server,
            "GET",
            `/workbench/tools${dir}`,
          )
          if (listed.find((tool) => tool.name === "greet")?.inputSchema === undefined)
            throw new Error(`no inputSchema: ${JSON.stringify(listed)}`)
          await renderer!.type(`${detail} [data-slot="tool-run"] input[name="name"]`, "Ada")
          await renderer!.click(`${detail} [data-slot="tool-run"] [data-action="tool-run"]`)
          await renderer!.waitFor(
            `${textOf(`${detail} [data-slot="tool-run-result"] pre`)} === "hello Ada"`,
            "the test run's output",
          )
          await shot("tools-run")
          return "hello Ada"
        },
        (value) => value,
      )
      await step("Disable, then Delete (it asks first; answered in the UI)", async () => {
        await renderer!.click(`${detail} [data-action="tool-disable"]`)
        await renderer!.waitFor(`${status} === "disabled"`, "disabled")
        if (!onDisk("tool/custom_greet.ts.disabled")) throw new Error("no disabled file")
        await renderer!.click(`${detail} [data-action="tool-delete"]`)
        await renderer!.waitFor(`${textOf('[role="dialog"]')}.includes("Delete custom_greet?")`, "the delete question")
        await shot("tools-delete")
        await renderer!.click('[role="dialog"] button', "Delete")
        await renderer!.waitFor(`!${exists(`${panel} [data-tool-group] [data-tool="greet"]`)}`, "greet gone")
        const listed = await api<unknown[]>(server, "GET", `/workbench/tools${dir}`)
        if (listed.length || onDisk("tool/custom_greet.ts.disabled") || onDisk("tool-drafts/greet.ts"))
          throw new Error(`left: ${JSON.stringify(listed)}`)
      })
    })

  // ---------------------------------------------------------------- quit mid-turn, restart, recover
  await section(async () => {
    await step("send a turn and quit while it streams", async () => {
      await openSession(renderer!, sessionID)
      await send(renderer!, "One more slow story, please.")
      await renderer!.waitFor(statusIs("working"), "working")
      await renderer!.waitFor(`${ASSISTANT}.at(-1)?.includes("Paragraph 1")`, "streaming before quit")
    })
    // A quit failure is recorded; the app is stopped either way, so the restart still runs.
    await step(
      "no processes left after quitting",
      () => quitAndCheck(),
      (value) => value,
    ).catch(() => {})
    await step(
      "the session's history is on disk after the quit",
      () => persisted(sessionID),
      (value) => value,
    )
    renderer!.close()
    renderer = undefined

    app = await step("restart on the same state (unsaved-edits answer: discard)", () =>
      launch({
        mode,
        root,
        config,
        env: { OPENCODE_SPICY_UNSAVED_ANSWER: "discard" },
        log: (line) => lines.push(line),
      }),
    )
    renderer = await step("renderer over CDP after restart", () => connectRenderer(app!.port))
    const restarted = await step(
      "sidecar ready after restart",
      () => sidecar(renderer!),
      (value) => value.url,
    )
    await step("app restores the project session", () =>
      renderer!.waitFor(
        `document.querySelector('[data-component="session-prompt-dock"]')`,
        "restored session page",
        40_000,
      ),
    )
    await step(
      "session history recovered as interrupted",
      async () => {
        await openSession(renderer!, sessionID)
        await renderer!.waitFor(
          exists(`[data-session="${sessionID}"] [data-status="interrupted"]`),
          "interrupted status in the session list",
        )
        // The conversation is a virtual list that follows its end: scroll to its start, as a human would (again on
        // each poll, since it follows the end while the history loads).
        await renderer!.waitFor(
          `(() => { const list = ${query('[data-component="agenthq-workspace"] [role="region"][aria-label="Conversation"]')}; if (list) list.scrollTop = 0; return ${ASSISTANT}.some((text) => text.includes(${JSON.stringify(INTRO.slice(0, 40))})) })()`,
          "first reply in the recovered history",
        )
        const detail = await api<{
          session: { status: string }
          history: { event: { type: string; status?: string } }[]
        }>(restarted, "GET", `/agenthq/sessions/${sessionID}${dir}`)
        const statuses = detail.history.flatMap((item) => (item.event.type === "status" ? [item.event.status] : []))
        if (detail.session.status !== "interrupted") throw new Error(`status ${detail.session.status}`)
        if (!statuses.includes("cancelled") || !statuses.includes("interrupted"))
          throw new Error(`history statuses ${statuses.join(",")}`)
        return `${detail.history.length} history entries, statuses ${[...new Set(statuses)].join(" > ")}`
      },
      (value) => value,
    )
    await shot("restored")
    await step(
      "the session's history is on disk after the restart",
      () => persisted(sessionID),
      (value) => value,
    ).catch(() => {})
    await step(
      "an unsaved edit, then quit (answer: discard): the quit goes through, no processes left",
      async () => {
        const editor = '#review-panel [data-component="workbench-editor"][data-path="README.md"]'
        await openInEditor(renderer!, "README.md")
        await typeAtEnd(renderer!, editor, " (discarded)")
        await renderer!.waitFor(exists(DIRTY), "the unsaved dot")
        const result = await quitAndCheck()
        if ((await read("README.md")) !== README_KEPT) throw new Error("the discarded edit reached the disk")
        return `${result}; README.md unchanged`
      },
      (value) => value,
    )
  })
} catch {
  // the failing step is recorded; fall through to cleanup and the summary
} finally {
  renderer?.close()
  if (app && app.child.exitCode === null) await app.stop().catch(() => {})
  model.stop()
}

if (app) {
  const home = app.home
  const keychain = app.keychain
  await step("throwaway keychain: no Safe Storage item (mock keychain)", async () => {
    const found = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "OpenCode Dev Safe Storage", keychain],
      {
        env: { HOME: home, CFFIXED_USER_HOME: home, PATH: "/usr/bin:/bin" },
      },
    )
    if (found.status === 0) throw new Error("Chromium wrote its Safe Storage key despite --use-mock-keychain")
  }).catch(() => {})
  await step("throwaway keychain deleted", async () => {
    cleanup(home)
    if (existsSync(keychain)) throw new Error(`${keychain} still exists`)
  }).catch(() => {})
}
const keychainAfter = realKeychain()
await step("real keychain untouched", async () => {
  if (JSON.stringify(keychainBefore) !== JSON.stringify(keychainAfter))
    throw new Error(`before ${JSON.stringify(keychainBefore)} after ${JSON.stringify(keychainAfter)}`)
}).catch(() => {})
await step(
  "no process left with the isolated root on its command line",
  async () => {
    const found = (await $`pgrep -fl ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`.nothrow().text())
      .trim()
      .split("\n")
      .filter((line) => line && !line.startsWith(`${process.pid} `))
    if (found.length) throw new Error(found.join("; "))
    return "none"
  },
  (value) => value,
).catch(() => {})
await Bun.sleep(2_000) // crash reports are written asynchronously
const reportsAfter = crashReports()
const newReports = reportsAfter.filter((name) => !reportsBefore.includes(name))
await step(
  "no crash report from the run",
  async () => {
    const ours = newReports.filter((name) => /electron|opencode|python|node|bun|git|tsc|mypy|ruff|debugpy/i.test(name))
    if (ours.length) throw new Error(ours.join(", "))
    return `${reportsBefore.length} before, ${reportsAfter.length} after${newReports.length ? ` (unrelated: ${newReports.join(", ")})` : ""}`
  },
  (value) => value,
).catch(() => {})

const failed = checks.filter((item) => !item.ok)
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      mode,
      root,
      project,
      keychain: { before: keychainBefore, after: keychainAfter },
      crashReports: { before: reportsBefore.length, after: reportsAfter.length, new: newReports },
      screenshots: shots,
      modelRequests: model.requests.map((item) => ({
        kind: item.kind,
        tool: item.tool,
        prompt: item.prompt.slice(0, 80),
        aborted: item.aborted,
      })),
      skipped: checks.filter((item) => item.skipped).map((item) => `${item.name}: ${item.detail}`),
      failed: failed.map((item) => `${item.name}: ${item.detail}`),
      checks,
      appLogTail: failed.length ? lines.slice(-60) : undefined,
    },
    null,
    2,
  ),
)
process.exit(failed.length ? 1 : 0)

// ---------------------------------------------------------------- helpers

// A file in a side-panel editor tab: its tab if open, else from the file tree ("Open file").
async function openInEditor(renderer: Renderer, file: string) {
  const editor = `#review-panel [data-component="workbench-editor"][data-path="${file}"]`
  if (await renderer.evaluate(exists(`${editor} .cm-content`))) return
  if (await renderer.evaluate(exists('#review-panel [role="tab"]', file)))
    await renderer.click('#review-panel [role="tab"]', file)
  else {
    await renderer.click('#review-panel button[aria-label="Open file"]')
    await renderer.click(`#review-panel [data-slot="file-tree-v2-row"][data-path="${file}"]`)
  }
  await renderer.waitFor(exists(`${editor} .cm-content`), `${file} in the editor`)
}

// Click the editor's first line, go to its end and type there, as the keyboard does.
async function typeAtEnd(renderer: Renderer, editor: string, text: string) {
  await renderer.click(`${editor} .cm-line`)
  await renderer.press("End", { code: "End", keyCode: 35 })
  await renderer.send("Input.insertText", { text })
}

// The editor's text: its lines joined (a short file is rendered whole).
function editorText(editor: string) {
  return `[...document.querySelectorAll(${JSON.stringify(`${editor} .cm-line`)})].map((line) => line.textContent).join("\\n")`
}

// Page expressions over the first visible match of a selector (see query in spicy-cdp.ts).
function exists(selector: string, text?: string) {
  return `!!${query(selector, text)}`
}

function textOf(selector: string) {
  return `(${query(selector)}?.textContent ?? "")`
}

// Every visible match has each text node on one line (no label wrapped mid-word); false when nothing matches.
function oneLine(selector: string) {
  return `(() => {
    const list = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.getClientRects().length > 0)
    return list.length > 0 && list.every((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        if (range.getClientRects().length > 1) return false
      }
      return true
    })
  })()`
}

function count(selector: string) {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.getClientRects().length > 0).length`
}

function stateOf(file: string) {
  return `${query(`[data-component="review-file-row"][data-path="${file}"]`)}?.getAttribute("data-state")`
}

// An Agent HQ session as the server stored it: its record's status and its history file (the restart recovers from
// these). Fails when the history file is unreadable.
async function persisted(id: string) {
  const store = path.join(root, "xdg", "data", "opencode", "storage", "agenthq")
  const info = JSON.parse(await readFile(path.join(store, "session", `${id}.json`), "utf8")) as { status: string }
  const text = await readFile(path.join(store, "events", `${id}.json`), "utf8")
  const history = JSON.parse(text) as { seq: number; event: { type: string; status?: string } }[]
  const statuses = history.flatMap((item) => (item.event.type === "status" ? [item.event.status] : []))
  if (!history.length) throw new Error(`empty history file (${text.length} bytes), record ${info.status}`)
  return `record ${info.status}; history ${history.length} entries (${text.length} bytes), seq ${history[0].seq}..${history.at(-1)!.seq}, statuses ${statuses.join(" > ")}`
}

// The owner's keychain setup as the real HOME sees it: attributes only, never secrets.
function realKeychain() {
  const run = (...args: string[]) => spawnSync("/usr/bin/security", args, { encoding: "utf8" })
  const item = run("find-generic-password", "-s", "OpenCode Dev Safe Storage")
  return {
    prefsFile: existsSync(path.join(userInfo().homedir, "Library", "Preferences", "com.apple.security.plist")),
    searchList: run("list-keychains", "-d", "user").stdout.replace(/\s+/g, " ").trim(),
    defaultKeychain: run("default-keychain", "-d", "user").stdout.trim(),
    safeStorageItem:
      item.status === 0
        ? item.stdout
            .split("\n")
            .filter((line) => /"(cdat|mdat)"/.test(line))
            .map((line) => line.trim().replace(/^"(\w+)".*"(\d+Z)\\000"$/, "$1=$2"))
            .join(" ")
        : "absent",
  }
}

// Names in the owner's crash reports folder (read only).
function crashReports() {
  return readdirSync(path.join(userInfo().homedir, "Library", "Logs", "DiagnosticReports")).filter(
    (name) => !name.startsWith("."),
  )
}

// A git repo: two text files for the review, app.py with a launch.json for the debugger, one TypeScript type error.
async function createProject(dir: string) {
  const files = {
    "README.md": README,
    "a.txt": A,
    "b.txt": B,
    "app.py": APP,
    "src/broken.ts": 'export const answer: number = "forty-two"\n',
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["src"] }),
    ".vscode/launch.json": JSON.stringify({
      version: "0.2.0",
      configurations: [
        {
          name: "App in terminal",
          type: "debugpy",
          request: "launch",
          program: "${workspaceFolder}/app.py",
          console: "integratedTerminal",
        },
      ],
    }),
    ".gitignore": "node_modules/\n.mypy_cache/\n",
  }
  for (const [name, content] of Object.entries(files)) await Bun.write(path.join(dir, name), content)
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Spicy Smoke"],
    ["config", "user.email", "smoke@spicy.local"],
    ["add", "-A"],
    ["commit", "-qm", "init"],
  ]) {
    const result = spawnSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  }
  return realpathSync(dir)
}

// @opencode-ai/plugin in the project's .opencode as npm ships it (tsc's JS with JS exports, zod beside it), with the
// manifest and lockfile config looks for, so approving a tool installs nothing. Not a link to the repo's TypeScript
// source as the e2e spec does: the desktop sidecar runs under Node, which cannot load that source (its imports name
// ./tool.js). The reason to skip otherwise.
async function providePlugin(project: string) {
  const source = path.resolve(DESKTOP_DIR, "../plugin")
  const opencode = path.join(project, ".opencode")
  const plugin = path.join(opencode, "node_modules", "@opencode-ai", "plugin")
  const built = spawnSync(
    path.join(source, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.json", "--outDir", path.join(plugin, "dist")],
    {
      cwd: source,
      encoding: "utf8",
    },
  )
  if (!existsSync(path.join(plugin, "dist", "index.js")) || !existsSync(path.join(plugin, "dist", "tool.js")))
    return `could not build @opencode-ai/plugin: ${built.stdout}${built.stderr}`.trim()
  const entry = (name: string) => ({ import: `./dist/${name}.js`, types: `./dist/${name}.d.ts` })
  await Bun.write(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "@opencode-ai/plugin",
      type: "module",
      exports: { ".": entry("index"), "./tool": entry("tool") },
    }),
  )
  await symlink(
    realpathSync(path.join(source, "node_modules", "zod")),
    path.join(opencode, "node_modules", "zod"),
    "dir",
  )
  const dependencies = { "@opencode-ai/plugin": "*" }
  await Bun.write(path.join(opencode, "package.json"), JSON.stringify({ dependencies }))
  await Bun.write(path.join(opencode, "package-lock.json"), JSON.stringify({ packages: { "": { dependencies } } }))
}

// tsc from this tree as the project's own (the checker prefers node_modules/.bin/tsc); the reason to skip otherwise.
async function provideTsc(project: string) {
  const tsc = path.resolve(DESKTOP_DIR, "../../node_modules/typescript/bin/tsc")
  if (!existsSync(tsc)) return `no TypeScript in this tree (${tsc})`
  await mkdir(path.join(project, "node_modules", ".bin"), { recursive: true })
  await symlink(realpathSync(tsc), path.join(project, "node_modules", ".bin", "tsc"))
}

// VS Code's bundled debugpy, cloned (APFS clonefile) into the fake home, where the server looks
// (~/.vscode/extensions), so nothing is written into the owner's extension; the reason to skip otherwise. The server
// picks Homebrew's Python first and never Apple's.
async function provideDebugpy(home: string) {
  if (!existsSync("/opt/homebrew/bin/python3")) return "no Homebrew Python at /opt/homebrew/bin/python3"
  const extensions = path.join(userInfo().homedir, ".vscode", "extensions")
  const name = (await readdir(extensions).catch(() => [] as string[]))
    .filter((item) => item.startsWith("ms-python.debugpy-"))
    .sort()
    .at(-1)
  const libs = name ? path.join(extensions, name, "bundled", "libs") : ""
  if (!name || !existsSync(path.join(libs, "debugpy")))
    return "no VS Code Python Debugger extension (ms-python.debugpy) under ~/.vscode/extensions"
  const target = path.join(home, ".vscode", "extensions", name, "bundled")
  await mkdir(target, { recursive: true })
  const copied = spawnSync("cp", ["-cR", libs, target], { encoding: "utf8" })
  if (copied.status !== 0) return `could not clone ${libs}: ${copied.stderr.trim()}`
}

async function sidecar(renderer: Renderer) {
  const init = await renderer.waitFor<{ url: string; username: string; password: string }>(
    "window.api && window.api.awaitInitialization()",
    "sidecar credentials",
    60_000,
  )
  return { url: init.url, auth: "Basic " + btoa(`${init.username}:${init.password}`) }
}

async function api<T>(server: { url: string; auth: string }, method: string, route: string, body?: unknown) {
  const res = await fetch(server.url + route, {
    method,
    headers: { authorization: server.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

function pollTask(server: { url: string; auth: string }, id: string, ok: (task: Task) => boolean, label: string) {
  return until(
    async () => {
      const task = await api<Task>(server, "GET", `/agenthq/tasks/${id}${dir}`)
      return ok(task) ? task : undefined
    },
    `task ${id} ${label}`,
    60_000,
  )
}

function pollDebug(server: { url: string; auth: string }, ok: (session: DebugSession) => boolean, label: string) {
  return until(
    async () => (await api<DebugSession[]>(server, "GET", `/workbench/debug/sessions${dir}`)).find(ok),
    label,
    60_000,
  )
}

// The server's directory-scoped event stream, filtered to one Agent HQ session.
function listen(server: { url: string; auth: string }, directory: string, sessionID: string) {
  const envelopes: { seq: number; event: { type: string } }[] = []
  const abort = new AbortController()
  void fetch(`${server.url}/event?directory=${encodeURIComponent(directory)}`, {
    headers: { authorization: server.auth, accept: "text/event-stream" },
    signal: abort.signal,
  })
    .then(async (res) => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value
        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""
        for (const part of parts) {
          const data = part
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("")
          if (!data) continue
          const event = JSON.parse(data) as {
            type: string
            properties?: { envelope?: { sessionID: string; seq: number; event: { type: string } } }
          }
          const envelope = event.properties?.envelope
          if (event.type === "agenthq.session.event" && envelope?.sessionID === sessionID) envelopes.push(envelope)
        }
      }
    })
    .catch(() => {})
  return { envelopes, stop: () => abort.abort() }
}

// Open a route the way the app restores a window: store it as the window's last URL and reload.
async function openUrl(renderer: Renderer, url: string) {
  await renderer.evaluate(
    `window.api.getWindowID().then((id) => { localStorage.setItem("opencode.desktop.window." + id + ".last-active-url", ${JSON.stringify(url)}); location.reload(); return id })`,
  )
}

// A tab of the bottom panel, opening the panel first (ctrl+`) when it is closed.
async function panelTab(renderer: Renderer, tab: string) {
  if (!(await renderer.evaluate(exists("#terminal-panel")))) {
    await renderer.press("`", { code: "Backquote", keyCode: 192, modifiers: CTRL })
    await renderer.waitFor(`document.querySelector('#terminal-panel [data-workbench-tab="agents"]')`, "workbench tabs")
    // Opening the panel starts a terminal whose focus request hands the tab bar back to the terminals; let it settle.
    await renderer.waitFor(`document.querySelector('#terminal-panel [data-component="terminal"]')`, "terminal")
    await Bun.sleep(1_500)
  }
  await renderer.click(`[data-workbench-tab="${tab}"]`)
  await renderer.waitFor(
    `document.querySelector('[data-workbench-tab="${tab}"]')?.getAttribute("aria-selected") === "true"`,
    `the ${tab} tab`,
  )
}

async function openAgentsTab(renderer: Renderer) {
  await step("Agents tab", async () => {
    await panelTab(renderer, "agents")
    await renderer.waitFor(
      `document.querySelector('[data-component="workbench-panel"][data-tab="agents"] [data-component="agenthq-panel"]')`,
      "Agents panel",
    )
    await renderer.waitFor(
      `document.querySelector('[data-action="agenthq-new"], [data-component="agenthq-workspace"]')`,
      "roster or workspace",
    )
  })
}

// Leave an agent's workspace for the roster or the Tasks view.
async function backToList(renderer: Renderer) {
  if (await renderer.evaluate(exists('[data-component="agenthq-workspace"]')))
    await renderer.click('[data-component="agenthq-workspace"] button[aria-label="Back to agents"]')
}

// Felix's workspace on one of his sessions.
async function openSession(renderer: Renderer, id: string) {
  if (!(await renderer.evaluate(exists('[data-component="agenthq-panel"]')))) await openAgentsTab(renderer)
  if (!(await renderer.evaluate(exists('[data-component="agenthq-workspace"]')))) {
    if (await renderer.evaluate(`${query('[data-agenthq-view="agents"]')}?.getAttribute("aria-selected") === "false"`))
      await renderer.click('[data-agenthq-view="agents"]')
    await renderer.click('[data-component="agenthq-card"]')
  }
  await renderer.click(`[data-component="agenthq-workspace"] [data-session="${id}"]`)
  await renderer.waitFor(
    `document.querySelector('[data-session="${id}"]')?.getAttribute("aria-current") === "true"`,
    "the session selected",
  )
}

async function send(renderer: Renderer, text: string) {
  await renderer.type('[data-component="agenthq-composer"] textarea', text)
  await renderer.click('[data-action="agenthq-send"]')
}

function statusIs(status: string) {
  return `document.querySelector('[data-component="agenthq-workspace"] [data-status]')?.getAttribute("data-status") === ${JSON.stringify(status)}`
}

async function dockIconLog(userData: string) {
  const logs = path.join(userData, "logs")
  const runs = (await readdir(logs)).sort()
  const text = await readFile(path.join(logs, runs.at(-1)!, "window.log"), "utf8")
  const match = text.match(/dock icon \{[^}]*?path: '([^']+)'[^}]*?loaded: (true|false)/)
  if (!match) throw new Error("no dock icon entry in window.log")
  if (match[2] !== "true") throw new Error(`dock icon not loaded from ${match[1]}`)
  return `loaded ${match[1]}`
}

// Quit the way the menu does, app.quit() in the main process: the windows close first (unsaved edits are answered by
// OPENCODE_SPICY_UNSAVED_ANSWER), then will-quit waits for the sidecar to stop. Then prove that every process of the app
// is gone: the recorded tree (renderer, GPU, network, the "opencode server" sidecar and the terminal shells it spawned)
// and anything still running from this checkout's Electron binary.
async function quitAndCheck() {
  // This checkout's Electron, never another install's processes. pgrep takes a regex and the path holds "+"
  // (electron@42.3.3+...), so it is escaped.
  const binary = realpathSync(path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "Electron.app"))
  const pattern = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const running = async () => (await $`pgrep -fl ${pattern}`.nothrow().text()).trim().split("\n").filter(Boolean)
  const before = await running()
  if (before.length === 0)
    throw new Error(`pgrep finds nothing for ${binary} while the app runs; the check would prove nothing`)
  const tree = await processTree(app!.child.pid!)
  const sidecarPid = tree.find((item) => item.command.includes("node.mojom.NodeService"))?.pid
  const shells = tree.filter((item) => sidecarPid && item.ppid === sidecarPid)
  const asked = await evaluateMain(app!.inspect, `require("electron").app.quit()`).then(
    () => "",
    (error) => `: ${error}`,
  )
  const code = await Promise.race([app!.exited, Bun.sleep(20_000).then(() => "timeout" as const)])
  // A quit that hangs is a failure, but the app is stopped (SIGTERM, then SIGKILL) and checked all the same.
  const hung =
    code === "timeout"
      ? `the app did not quit within 20 s of app.quit()${asked}; SIGTERM: ${(await app!.stop()) === "killed" ? "no exit within 20 s either, SIGKILL" : "exited"}`
      : ""
  await until(() => tree.every((item) => !alive(item.pid)), "the app's processes to exit", 10_000)
  const after = await running()
  if (after.length) throw new Error(`${hung ? `${hung}; ` : ""}still running: ${after.join("; ")}`)
  const gone = `${tree.length + 1} processes gone (sidecar pid ${sidecarPid ?? "?"}, ${shells.length} child process(es) of it); pgrep matched ${before.length} before, 0 after`
  if (hung) throw new Error(`${hung} (${gone})`)
  return gone
}

// The first truthy value of `probe`, polled until the timeout.
async function until<T>(probe: () => T | Promise<T>, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(150)
  }
}

function expectEqual<T>(expected: T) {
  return (value: T) => {
    if (value !== expected) throw new Error(`expected ${expected}, got ${value}`)
    return value
  }
}
