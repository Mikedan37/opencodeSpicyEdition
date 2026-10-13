// lldb-dap (C, C++, Swift, Rust). Launching or attaching needs macOS Developer Mode: without
// it macOS shows an admin password prompt, so the session is refused up front instead.
import path from "path"
import { Option, Schema } from "effect"
import { which } from "@opencode-ai/core/util/which"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { DebugEnv } from "../env"

export const DEVELOPER_MODE_OFF = "Developer Mode off — run sudo DevToolsSecurity -enable"

export async function resolve(): Promise<{ binary: string } | { error: string }> {
  if (process.platform === "darwin") {
    const out = await Process.text(["xcrun", "-f", "lldb-dap"], {
      nothrow: true,
      abort: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    const found = out?.code === 0 ? out.text.trim() : ""
    if (found) return { binary: found }
  }
  const found = which("lldb-dap")
  if (found) return { binary: found }
  return { error: "lldb-dap was not found (install Xcode or LLVM)" }
}

export async function developerMode() {
  if (process.platform !== "darwin") return true
  const out = await Process.text(["DevToolsSecurity", "-status"], {
    nothrow: true,
    abort: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  return /\benabled\b/i.test(out?.text ?? "") && !/disabled/i.test(out?.text ?? "")
}

/**
 * Variable REPL mode for every session: LLDB command mode runs host commands (platform shell,
 * script), so the console evaluates expressions unless a human uses the ` escape prefix.
 */
export function command(binary: string) {
  return [binary, "--repl-mode", "variable"]
}

/**
 * rustc's LLDB formatters (what rust-lldb loads): Vec, String, Option, HashMap and friends show their contents
 * instead of raw fields. Uses the toolchain the project would build with (rust-toolchain files apply in `cwd`).
 */
export async function rust(cwd: string) {
  const out = await Process.text(["rustc", "--print", "sysroot"], {
    cwd,
    nothrow: true,
    abort: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const sysroot = out?.code === 0 ? out.text.trim() : ""
  if (!sysroot) return undefined
  const etc = path.join(sysroot, "lib", "rustlib", "etc")
  const lookup = path.join(etc, "lldb_lookup.py")
  const commands = path.join(etc, "lldb_commands")
  if (!(await Filesystem.exists(lookup)) || !(await Filesystem.exists(commands))) return undefined
  return [`command script import "${lookup}"`, `command source -s 0 "${commands}"`]
}

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.String,
      executable: Schema.optional(Schema.NullOr(Schema.String)),
      target: Schema.optional(Schema.Struct({ kind: Schema.Array(Schema.String), name: Schema.String })),
      profile: Schema.optional(Schema.Struct({ test: Schema.Boolean })),
      message: Schema.optional(Schema.Struct({ rendered: Schema.optional(Schema.NullOr(Schema.String)) })),
    }),
  ),
)

/** Test executables in `cargo test --no-run --message-format=json` output; the library's unit tests first. */
export function testBinaries(stdout: string) {
  const messages = stdout.split("\n").flatMap((line) => Option.toArray(decodeLine(line)))
  const rank = (kind: readonly string[]) => (kind.includes("lib") ? 0 : kind.includes("bin") ? 1 : 2)
  return {
    binaries: messages
      .flatMap((item) =>
        item.reason === "compiler-artifact" && item.profile?.test && item.executable && item.target
          ? [{ path: item.executable, target: item.target.name, kind: item.target.kind }]
          : [],
      )
      .toSorted((a, b) => rank(a.kind) - rank(b.kind)),
    errors: messages.flatMap((item) =>
      item.reason === "compiler-message" && item.message?.rendered?.includes("error") ? [item.message.rendered] : [],
    ),
  }
}

/** Builds the test binaries (runs build scripts and proc macros: call only after the launch was approved). */
export async function testBinary(build: {
  readonly command: readonly string[]
  readonly cwd: string
}): Promise<{ program: string; notes: string[] } | { error: string }> {
  const out = await Process.run([...build.command], {
    cwd: build.cwd,
    env: DebugEnv.child(), // build scripts are project code: no server credentials
    nothrow: true,
    abort: AbortSignal.timeout(300_000),
  }).catch((error: unknown) => ({ code: 1, stdout: Buffer.from(""), stderr: Buffer.from(String(error)) }))
  const found = testBinaries(out.stdout.toString())
  const chosen = found.binaries[0]
  if (out.code === 0 && chosen)
    return {
      program: chosen.path,
      notes:
        found.binaries.length > 1
          ? [`test binaries: ${found.binaries.map((item) => item.target).join(", ")}; debugging ${chosen.target}`]
          : [],
    }
  const why = found.errors.slice(0, 3).join("\n") || out.stderr.toString().trim().split("\n").slice(-5).join("\n")
  return {
    error: `${build.command.join(" ")} ${out.code === 0 ? "built no test binary" : "failed"}${why ? `:\n${why}` : ""}`,
  }
}

export * as Lldb from "./lldb"
