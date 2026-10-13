// Shell commands that only read. The shell tool marks its bash ask `metadata.harmless` when the whole script is one of
// these, and SessionAutoApprove.ruleset then lifts the agent's blanket bash ask (pattern "*") for that ask alone: `git
// status` or `rg foo src` runs without asking while `rm x` asks. Specific bash rules (a user's deny, "git push*": "ask")
// and external_directory asks still apply, and Agent HQ's guard still asks.
//
// A script is harmless only when every command is on the list below with safe arguments, nothing is redirected except
// to /dev/null (or one descriptor onto another), there is no expansion of any kind ($VAR, $( ), backticks, <( ), >( ),
// braces), no VAR=x prefix, no background `&`, the shell is POSIX, and no argument names an env file or a path outside
// the project. Anything the parser does not recognize (a parse error, a subshell, a zsh glob qualifier) is not harmless.
import type { Node } from "web-tree-sitter"

export type Options = {
  /** Whether a path argument (unquoted, `~` already allowed only as `~` or `~/…`) resolves inside the project. */
  readonly inside: (file: string) => boolean
}

const POSIX = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"])
const COMMANDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "type",
  "whoami",
  "uname",
  "date",
  "echo",
  "rg",
  "grep",
  "find",
  "git",
])
// Their arguments are text, not files.
const TEXT = new Set(["echo", "which", "type", "date", "uname", "whoami", "pwd", "df"])
// They print file contents, so a glob may only name files with a fixed extension (never one that ends in env).
const READERS = new Set(["cat", "head", "tail", "grep", "rg"])
const GIT = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "describe", "shortlog"])
const NODES = new Set([
  "program",
  "list",
  "pipeline",
  "command",
  "command_name",
  "word",
  "string",
  "string_content",
  "raw_string",
  "concatenation",
  "number",
  "comment",
  "redirected_statement",
])
const TOKENS = new Set([";", "&&", "||", "|", "|&", '"'])
const TO_NULL = new Set([">", ">>", "&>", "&>>", ">|", ">&"])

/** Whether commands run in this shell (a path or a name) are parsed the way this module reads them. */
export function posix(shell: string) {
  return POSIX.has(
    shell
      .split(/[\\/]/)
      .pop()!
      .toLowerCase()
      .replace(/\.exe$/, ""),
  )
}

/** Whether a parsed script only reads. */
export function harmless(root: Node, options: Options): boolean {
  if (root.hasError || !walk(root)) return false
  return root.descendantsOfType("command").every((node) => !!node && command(node, options))
}

function children(node: Node) {
  return Array.from({ length: node.childCount }, (_, i) => node.child(i)).filter((child): child is Node => !!child)
}

function walk(node: Node): boolean {
  if (node.type === "file_redirect") return redirect(node)
  if (!node.isNamed) return TOKENS.has(node.type)
  return NODES.has(node.type) && children(node).every(walk)
}

// Only to /dev/null, or one descriptor onto another (2>&1); never from a file.
function redirect(node: Node) {
  const parts = children(node)
  const operator = parts.find((part) => !part.isNamed)?.type
  const target = parts.at(-1)
  if (!operator || !target?.isNamed) return false
  if (operator === ">&" && target.type === "number") return true
  return TO_NULL.has(operator) && target.type === "word" && target.text === "/dev/null"
}

function unquote(node: Node): string {
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "string")
    return children(node)
      .filter((part) => part.isNamed)
      .map((part) => part.text)
      .join("")
  if (node.type === "concatenation") return children(node).map(unquote).join("")
  return node.text.replace(/\\(.)/g, "$1")
}

// The unquoted words of an argument, where the shell expands globs and braces.
function bare(node: Node): string[] {
  if (node.type === "word") return [node.text]
  if (node.type === "concatenation") return children(node).flatMap(bare)
  return []
}

function envFile(value: string) {
  return value
    .toLowerCase()
    .split(/[/:=]/)
    .some((part) => part.endsWith(".env") || (part.startsWith(".env") && part !== ".env.example"))
}

function pathOk(value: string, options: Options): boolean {
  if (value.startsWith("-")) return value.includes("=") ? pathOk(value.slice(value.indexOf("=") + 1), options) : true
  if (value.startsWith("~") && value !== "~" && !value.startsWith("~/")) return false
  if (value.startsWith("/") || value.startsWith("~") || value.split("/").includes("..")) return options.inside(value)
  return true
}

function glob(text: string) {
  return /[*?[]/.test(text)
}

// A glob a reader may expand: its last segment ends with a fixed extension other than env.
function safeGlob(text: string) {
  const extension = /\.([A-Za-z0-9]+)$/.exec(text.split("/").pop() ?? "")
  return !!extension && extension[1].toLowerCase() !== "env"
}

function command(node: Node, options: Options): boolean {
  const [name, ...rest] = children(node).filter((part) => part.isNamed)
  const word = name?.type === "command_name" && name.namedChildCount === 1 ? name.namedChild(0) : undefined
  if (!word || word.type !== "word" || !COMMANDS.has(word.text)) return false
  const cmd = word.text
  const values = rest.map(unquote)
  // grep and rg: the first word that is not a flag is the pattern, unless -e or -f name the patterns.
  const pattern =
    (cmd === "grep" || cmd === "rg") && !values.some((value) => /^(-[ef]|--regexp|--file)/.test(value))
      ? values.findIndex((value) => !value.startsWith("-"))
      : -1
  for (const [index, arg] of rest.entries()) {
    const words = bare(arg)
    if (words.length && /\{[^{}]*(,|\.\.)[^{}]*\}/.test(arg.text)) return false
    if (TEXT.has(cmd) || index === pattern) continue
    if (envFile(values[index]) || !pathOk(values[index], options)) return false
    if (READERS.has(cmd) && words.some(glob) && !safeGlob(values[index])) return false
  }
  return RULES[cmd]?.(values) ?? true
}

// A short-option cluster (-abc) that holds any of these letters.
const short = (value: string, letters: string) =>
  /^-[^-]/.test(value) && [...value.slice(1)].some((letter) => letters.includes(letter))

const RULES: Record<string, (args: string[]) => boolean> = {
  date: (args) => args.every((arg) => arg.startsWith("+") || ["-u", "--utc", "-R", "-I", "--iso-8601"].includes(arg)),
  // -o writes the listing to a file, -R writes one into every directory.
  tree: (args) => !args.some((arg) => short(arg, "oR") || arg.startsWith("--output")),
  // -C compiles a magic file, writing it next to the source.
  file: (args) => !args.some((arg) => short(arg, "C")),
  grep: (args) =>
    !args.some((arg) => short(arg, "rRd") || /^--(recursive|dereference-recursive|directories)/.test(arg)),
  // --pre runs a program per file, -z/--search-zip runs decompressors; --hidden, -u, --no-ignore and -L widen the
  // search to dotfiles (.env), ignored files and symlinks outside the project.
  rg: (args) =>
    !args.some(
      (arg) =>
        short(arg, "zuL.") || /^--(pre|pre-glob|search-zip|hidden|no-ignore|follow|unrestricted)(=|$|-)/.test(arg),
    ),
  find: (args) =>
    !args.some(
      (arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"].includes(arg) || arg.startsWith("-fprint"),
    ),
  git: ([sub, ...args]) => {
    // No global options (-c, -C, --git-dir…) before the subcommand.
    if (!sub || sub.startsWith("-")) return false
    if (GIT.has(sub))
      return !(["diff", "log", "show"].includes(sub) && args.some((arg) => /^--(output|ext-diff)(=|$)/.test(arg)))
    if (sub === "remote") return args.every((arg) => arg === "-v")
    if (sub === "tag")
      return !args.length || (["-l", "--list"].includes(args[0]!) && !args.slice(1).some((arg) => arg.startsWith("-")))
    if (sub === "branch") return branch(args)
    return false
  },
}

const BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"])
const BRANCH_COMMIT = new Set(["--contains", "--merged", "--no-merged"])

// Listing only: never a name to create, delete, move or copy.
function branch(args: string[]) {
  let listing = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--list") listing = true
    if (BRANCH_FLAGS.has(arg)) continue
    if (BRANCH_COMMIT.has(arg)) {
      if (args[i + 1] && !args[i + 1]!.startsWith("-")) i++
      continue
    }
    if ([...BRANCH_COMMIT].some((flag) => arg.startsWith(`${flag}=`))) continue
    if (listing && !arg.startsWith("-")) continue
    return false
  }
  return true
}

export * as WorkbenchHarmless from "./harmless"
