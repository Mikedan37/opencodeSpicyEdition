// The IDE editor's file access (GET/PUT /workbench/file): a file's exact text with the hash of its bytes, and writes
// that only replace the bytes the editor started from. Paths stay inside the project once symlinks are resolved.
// The human's editor uses it through the server's auth; no agent tool calls it.
import { createHash, randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { containsPath, type InstanceContext } from "@/project/instance-context"

export type Failure = { kind: "outside" | "missing" | "invalid" | "conflict"; message: string }

// The editor opens files up to 500,000 characters (larger ones keep the read-only viewer); reads stop well above it.
export const MAX_BYTES = 8 * 1024 * 1024

export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const fail = (kind: Failure["kind"], message: string): Failure => ({ kind, message })
export const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && "kind" in value && "message" in value

const real = (file: string) => fs.realpath(file).catch(() => undefined)

// `file` absolute or relative to the directory. `shown` is the path as the project names it (events, LSP); `target`
// is where the bytes live (a symlinked file is written through, so the link stays).
async function locate(ctx: InstanceContext, file: string) {
  const shown = path.resolve(ctx.directory, file)
  const parent = await real(path.dirname(shown))
  if (!parent) return fail("missing", `No such directory: ${path.dirname(shown)}`)
  const target = (await real(path.join(parent, path.basename(shown)))) ?? path.join(parent, path.basename(shown))
  // The roots resolved too, so a project under a symlinked folder (/tmp on macOS) still contains its files.
  const roots = {
    ...ctx,
    directory: (await real(ctx.directory)) ?? ctx.directory,
    worktree: ctx.worktree === "/" ? "/" : ((await real(ctx.worktree)) ?? ctx.worktree),
  }
  if (!containsPath(target, roots)) return fail("outside", `Not inside the project: ${file}`)
  return { shown: FSUtil.normalizePath(shown), target }
}

const absent = (error: unknown) => (error as { code?: string }).code === "ENOENT"

function decode(bytes: Uint8Array) {
  if (bytes.includes(0)) return
  try {
    // The BOM stays in the text, so a save writes it back.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return
  }
}

export async function read(ctx: InstanceContext, file: string) {
  const place = await locate(ctx, file)
  if (isFailure(place)) return place
  const stat = await fs.stat(place.target).catch(() => undefined)
  if (!stat) return fail("missing", `No such file: ${file}`)
  if (!stat.isFile()) return fail("invalid", `Not a file: ${file}`)
  if (stat.size > MAX_BYTES) return fail("invalid", `Too large to edit (${stat.size} bytes): ${file}`)
  const bytes = await fs.readFile(place.target)
  const content = decode(bytes)
  if (content === undefined) return fail("invalid", `Not a UTF-8 text file: ${file}`)
  return { content, hash: hash(bytes) }
}

// Replaces the file only when its bytes still hash to `baseHash` (null: the file must not exist). The new bytes go to
// a temporary file in the same folder, which then replaces the file in one rename, keeping its permission bits.
// ponytail: the hash check and the rename are two steps; a write landing between them is lost. A lock or an
// O_EXCL-style compare-and-swap would close that window if two writers ever race on one file.
export async function write(ctx: InstanceContext, input: { path: string; content: string; baseHash: string | null }) {
  const place = await locate(ctx, input.path)
  if (isFailure(place)) return place
  const stat = await fs.stat(place.target).catch((error) => (absent(error) ? undefined : Promise.reject(error)))
  if (stat && !stat.isFile()) return fail("invalid", `Not a file: ${input.path}`)
  const current = stat ? hash(await fs.readFile(place.target)) : null
  if (current !== input.baseHash)
    return fail(
      "conflict",
      current === null
        ? `${input.path} was deleted since it was opened`
        : input.baseHash === null
          ? `${input.path} already exists`
          : `${input.path} changed on disk since it was opened`,
    )
  const bytes = Buffer.from(input.content, "utf8")
  const temp = path.join(
    path.dirname(place.target),
    `.${path.basename(place.target)}.${randomBytes(6).toString("hex")}.tmp`,
  )
  try {
    await fs.writeFile(temp, bytes, { flag: "wx" })
    if (stat) await fs.chmod(temp, stat.mode & 0o7777)
    await fs.rename(temp, place.target)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
  return { hash: hash(bytes), file: place.shown, created: !stat }
}

export * as WorkbenchEditorFile from "./editor-file"
