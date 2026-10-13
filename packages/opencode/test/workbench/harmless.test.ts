import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { parser } from "@/tool/shell"
import { WorkbenchHarmless } from "@/workbench/harmless"
import { testEffect } from "../lib/effect"
import { harness, json, layer } from "./fixture/session-api"

// Commands that only read run without the blanket bash ask; everything else, and every way around the list, asks.
const ROOT = "/repo"
const inside = (file: string) => {
  const resolved = path.resolve(ROOT, file.replace(/^~(?=$|\/)/, "/home/me"))
  return resolved === ROOT || resolved.startsWith(ROOT + "/")
}
const harmless = async (command: string) => {
  const tree = (await parser()).bash.parse(command)
  if (!tree) throw new Error(`could not parse ${command}`)
  try {
    return WorkbenchHarmless.harmless(tree.rootNode, { inside })
  } finally {
    tree.delete()
  }
}

const HARMLESS = [
  "ls",
  "ls -la src",
  "pwd",
  "cat src/a.ts",
  "cat src/*.ts",
  "cat .env.example",
  "head -n 5 README.md",
  "tail -20 log.txt",
  "wc -l src/*",
  "file README.md",
  "stat src",
  "du -sh src",
  "df -h",
  "tree -L 2",
  "which git",
  "type ls",
  "whoami",
  "uname -a",
  "date +%Y-%m-%d",
  "echo hello world",
  "rg foo src",
  "rg '/api/' src",
  "rg -n --glob '*.ts' foo",
  "grep -n foo src/a.ts",
  "find . -name '*.ts' -type f",
  "git status",
  "git status --porcelain",
  "git diff HEAD~1 -- src",
  "git log --oneline -n 5",
  "git show HEAD:src/a.ts",
  "git blame src/a.ts",
  "git rev-parse HEAD",
  "git ls-files",
  "git describe --tags",
  "git shortlog -sn",
  "git branch",
  "git branch -a -vv",
  "git branch --show-current",
  "git branch --contains abc123",
  "git branch --list 'feat/*'",
  "git remote",
  "git remote -v",
  "git tag",
  "git tag -l 'v1*'",
  "ls > /dev/null 2>&1",
  "ls &> /dev/null",
  "git status && git log --oneline | head -5",
  "ls; pwd",
  "ls # list",
]

const NOT = [
  // Writes, chains and expansions the coordinator listed.
  "cat x > y",
  "ls; rm x",
  "ls $(rm x)",
  "ls `rm x`",
  "find . -delete",
  "rg --pre sh foo",
  "git -c core.fsmonitor=x status",
  "git branch -D x",
  "git tag v1",
  "git log --output=x",
  "cat .env",
  "FOO=1 ls",
  "ls &",
  // And more ways around the list.
  "rm x",
  "git push",
  "git commit -m x",
  "git checkout main",
  "git --git-dir=x status",
  "git -C .. status",
  "git diff --ext-diff",
  "git show --output=x HEAD",
  "git branch new-feature",
  "git branch -m a b",
  "git remote add origin x",
  "git tag -d v1",
  "grep -r foo .",
  "grep -rn foo .",
  "grep -R foo",
  "grep --recursive foo .",
  "grep -d recurse foo .",
  "rg -z foo",
  "rg --search-zip foo",
  "rg --pre-glob '*.gz' foo",
  "rg --hidden KEY",
  "rg -uu KEY",
  "rg --no-ignore KEY",
  "find . -exec rm {} \;",
  "find . -execdir sh \;",
  "find . -ok rm {} \;",
  "find . -okdir rm {} \;",
  "find . -fprint out",
  "find . -fls out",
  "cat /etc/passwd",
  "cat ../secret",
  "ls ~root",
  "ls ~",
  "head prod.env",
  "cat config/.env.local",
  "cat .envrc",
  "git show HEAD:.env",
  "rg -f .env x",
  "cat *",
  "cat *.env",
  "tree -o out.txt",
  "tree -R",
  "file -C -m magic",
  "date 0101000026",
  "date -s now",
  "echo $HOME",
  "echo ${ANTHROPIC_API_KEY}",
  'echo "$(rm x)"',
  "cat < .env",
  "cat <<EOF\nx\nEOF",
  "cat <<< x",
  "ls <(rm x)",
  "ls >(rm x)",
  "ls {a,b}",
  "cat {x,.env}",
  "ls *(e:'rm x':)",
  "(ls)",
  "{ ls; }",
  "! ls",
  "/bin/ls",
  '"ls"',
  "l\\s",
  "ls >& out",
  "ls >| out",
  "ls 2> err.txt",
  "echo hi > /dev/nullx",
  "ls & ls",
  "ls | xargs rm",
  "ls | sh",
  "export X=1",
  "time ls",
  "if true; then ls; fi",
  "ls $'\\x41'",
]

describe("harmless shell commands", () => {
  test.each(HARMLESS)("runs without asking: %s", async (command) => {
    expect(await harmless(command)).toBe(true)
  })
  test.each(NOT)("asks: %s", async (command) => {
    expect(await harmless(command)).toBe(false)
  })
  test("only POSIX shells", () => {
    for (const shell of ["/bin/zsh", "/bin/bash", "sh", "/usr/bin/dash"])
      expect([shell, WorkbenchHarmless.posix(shell)]).toEqual([shell, true])
    for (const shell of ["/usr/local/bin/fish", "pwsh", "powershell.exe", "cmd.exe", "nu", "/bin/tcsh"])
      expect([shell, WorkbenchHarmless.posix(shell)]).toEqual([shell, false])
  })
})

const it = testEffect(layer)

describe("harmless commands in a real session", () => {
  it.live("git status runs without asking in build and plan mode; rm asks", () =>
    Effect.gen(function* () {
      const { llm, call, wait, asked, pending, idle, turn, create, tools } = yield* harness()
      for (const agent of ["build", "plan"]) {
        const session = yield* create
        yield* llm.tool("bash", { command: "git status", description: "Status" })
        yield* llm.text("done")
        yield* turn(session, "status", agent)
        const ran = yield* wait(
          tools(session).pipe(Effect.map((list) => list.find((item) => item.status === "completed"))),
          `git status never ran in ${agent} mode`,
        )
        expect([agent, ran.tool, ran.text]).toEqual([agent, "bash", expect.stringContaining("On branch")])
        yield* idle(session)
        expect(yield* pending(session)).toEqual([])
      }
      const session = yield* create
      yield* llm.tool("bash", { command: "rm x", description: "Remove x" })
      yield* llm.text("done")
      yield* turn(session, "remove x")
      const ask = yield* asked(session, "rm never asked")
      expect([ask.permission, ask.patterns]).toEqual(["bash", ["rm x"]])
      yield* call(`/permission/${ask.id}/reply`, json("POST", { reply: "reject" }))
      yield* idle(session)
    }),
  )

  it.live("a user's deny for a command still denies it, harmless or not", () =>
    Effect.gen(function* () {
      const { llm, wait, pending, idle, turn, create, tools } = yield* harness({
        permission: { bash: { "cat *": "deny" } },
      })
      const session = yield* create
      yield* llm.tool("bash", { command: "cat a", description: "Read a" })
      yield* llm.text("done")
      yield* turn(session, "read a")
      const denied = yield* wait(
        tools(session).pipe(Effect.map((list) => list.find((item) => item.status === "error"))),
        "cat a was not denied",
      )
      expect(denied.tool).toBe("bash")
      expect(denied.text).toContain('"pattern":"cat *","action":"deny"')
      yield* idle(session)
      expect(yield* pending(session)).toEqual([])
    }),
  )
})
