# Permissions notes (`spicy-validate`): nothing runs without you

The main chat asks before it changes anything; a person can let a session, a project or a read-only command go
without asking, and every one of those stops at a deny. Owner decisions 2026-10-12 and 2026-10-13.

## Who asks

- **build and general** (`agent/agent.ts`): `"*": "ask"`, then the read-only tools allowed
  (`Agent.READ_ONLY_TOOLS`: read, glob, grep, list, lsp, todoread, todowrite, skill, webfetch, websearch, the list
  Agent HQ shares), then the usual rules (doom_loop ask, external_directory ask, question/plan_* deny, verify.exec
  ask, debug.* ask, debug.memory deny, custom_* ask, `.env` reads ask), then the user's config, which wins. So
  edits, bash, MCP tools, subagents (`task`) and anything unknown ask.
- **plan**: the same ask-first base, `bash: "ask"`, edits denied except plan files, `task`: explore allowed
  (read-only, its commands ask), general denied, the user's own agents ask.
- **explore**: reads allowed, `bash: "ask"`, everything else denied.
- **custom agents**: upstream's `"*": "allow"` base.
- **Agent HQ** (`agenthq/providers/opencode.ts` `guard`): every allow outside the read-only tools becomes an ask, in
  the session's own rules, so nothing below loosens it.

## Ways to skip an ask, and what they never skip

All of them leave explicit denies (plan mode's edits, a user's `"*.lock": "deny"`, a session deny) in force, and
none approves an **edit under `.git/`** (any case, any depth, or a `.git` file): an edited `.git/config`
(`core.fsmonitor`) or hook would turn the git commands below into code execution.

| What | Scope | Where | Effect |
|---|---|---|---|
| Edits switch | one session | `PUT /workbench/sessions/:id/auto-approve` `{ edits }` | the agent's blanket asks (pattern `*`) for `edit` become allows |
| Commands switch | one session | same route, `{ commands }` | the same for `bash` |
| Harmless command | one ask | the shell tool, `workbench/harmless.ts` | the same for that bash ask alone |
| "Always allow" | one session | `POST /permission/:id/reply` `always` | the request's always-patterns, remembered in memory for that session |
| "Always allow in this project" | every session of the project, subagents included | `POST /workbench/permissions/:id/save` | the always-patterns saved in Storage (`workbench/approvals/<projectID>`) |

The switches' route also speaks the single switch's shape, for installed apps (OpenCode Native 0.15.3): PUT takes
`{ enabled }` (both on or both off) as well as `{ edits, commands }` (a field left out keeps its value), and GET
and PUT return `enabled` (= edits && commands) next to them.

Lifts touch only the agent's rules, so rules for specific files or commands (`"git push*": "ask"`), the session's
own rules (Agent HQ's guard) and external_directory asks still apply after them. `Permission.ask` checks the
ruleset's explicit denies first, then the ruleset with the saved and remembered approvals.

Saved rules: allow rules only, `{ permission, pattern }` with permission ≤ 200 and pattern ≤ 2000 characters (a
request whose patterns are longer is refused, 400); malformed entries on disk are dropped. They are cached per project and refreshed on save and delete in this
process (another server process sees a change after its restart). `GET /workbench/approvals` lists them,
`DELETE /workbench/approvals` `{ permission, pattern }` removes one. Saving answers the pending request with
"always": 404 when it is no longer pending, 400 when it has no always-patterns. Bridge tokens reach none of
these routes. Upstream has a database store for saved permissions too (`@opencode-ai/core/permission/saved`,
v2); the fork's lives in Storage like the tool creator's metadata.

## Harmless commands

`opencode acp` serves the same main chat, so its harmless commands run unasked too (the Agent HQ ACP test now uses
`printf`, which asks). A script runs without the blanket bash ask only when all of this holds:

- the shell is POSIX (sh, bash, zsh, dash, ksh), never PowerShell, cmd or fish, and the parse has no errors;
- every command is on the list with safe arguments:
  - `ls pwd cat head tail wc file stat du df tree which type whoami uname date echo` (tree without `-o`/`-R`,
    file without `-C`, date only `+FORMAT`/`-u`/`-R`/`-I`);
  - `rg`, except `--pre`, `--pre-glob`, `-z`/`--search-zip`, and `--hidden`, `-u`, `--no-ignore`, `-L`/`--follow`
    (these reach dotfiles like `.env` and paths outside the project);
  - `grep`, except `-r`/`-R`/`--recursive`/`-d`/`--directories`;
  - `find`, except `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls`;
  - `git` with no option before the subcommand: `status diff log show blame rev-parse ls-files describe
    shortlog`; `diff`/`log`/`show` without `--output` or `--ext-diff`; `branch` only listing (`-a -r -v -vv
    --list --show-current --all --remotes --contains --merged --no-merged`); `remote` bare or `-v`; `tag` bare or
    `-l`/`--list`;
- output is redirected only to `/dev/null` (or `2>&1`), never from a file (`<`, heredocs, herestrings);
- no `$VAR`, `${…}`, `$( )`, backticks, `<( )`, `>( )`, brace expansion, `VAR=x` prefix or background `&`;
- no argument names an env file (`.env`, `*.env`, `.env.*`, `.envrc`; `.env.example` is fine), a path outside the
  project, or a `~user` directory; `cat`/`head`/`tail`/`grep`/`rg` take globs only with a fixed extension.

The shell tool sets `metadata.harmless` on its bash ask; `SessionAutoApprove.ruleset(agent, session, request)`
lifts the agent's blanket bash asks for it. So `git status` runs unasked in build and plan mode, `rm x` asks,
a user's `bash: { "cat *": "deny" }` still denies `cat a`, and Agent HQ still asks.

## Headless runs

- `opencode run` rejects asks as before and prints `<permission> needs approval (<patterns>); rerun with --auto or
  allow it in opencode.json`.
- `opencode github run` starts its session from `Headless.ciPermission()`: no questions, both switches on, so the
  agent edits and runs commands out of the box. Anything that still asks (MCP tools, subagents, other directories,
  `.git/` edits) is rejected at once (`Headless.rejectAsks`) and the run fails with that line instead of waiting for
  the job's timeout. Denies still apply.

## Tests

- `test/workbench/permission-defaults.test.ts`: defaults, plan/explore, the switches (each on its own, `.git`,
  Agent HQ's guard, user rules), "always" per session, saved approvals (other sessions, removal, denies, `.git`).
- `test/workbench/auto-approve.test.ts`: real routes and turns: the switches, and the save route end to end.
- `test/workbench/harmless.test.ts`: a table of harmless and not-harmless scripts (every bypass above), POSIX
  shells, and real turns: `git status` unasked in build and plan mode, `rm x` asks, a user's deny holds.
- `test/workbench/headless.test.ts`: the run line, the reject helper, and the CI session's rules.
