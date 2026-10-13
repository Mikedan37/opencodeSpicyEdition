// spicy: the tool creator. Agents (tool_create) and the user draft custom tools into .opencode/tool-drafts/, a folder
// the tool registry never scans; a draft is only parsed (validate.ts), never imported or run. Approving moves it to
// .opencode/tool/custom_<name>.ts, an ordinary opencode custom tool named custom_<name>, and loads it once to make
// sure it works; disabling renames it to .ts.disabled. Callers refresh the tool registry afterwards. This module
// runs under Node too (the desktop sidecar): no Bun APIs.
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { Npm } from "@opencode-ai/core/npm"
import { Workbench } from "@opencode-ai/schema/workbench"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { inspect, MAX_SOURCE, NAME } from "./validate"

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("WorkbenchToolError", {
  kind: Schema.Literals(["not_found", "invalid", "conflict"]),
  message: Schema.String,
}) {}

// Kept in opencode's storage, not in the project: who drafted it, and why approving it failed (for that content).
type Meta = {
  directory: string
  createdBy: Workbench.CustomToolAuthor
  createdAt: number
  description?: string
  failed?: { hash: string; reason: string }
}

export interface Interface {
  readonly list: () => Effect.Effect<Workbench.CustomTool[]>
  readonly draft: (
    input: Workbench.CustomToolDraft,
    by: Workbench.CustomToolAuthor,
  ) => Effect.Effect<Workbench.CustomTool, ToolError>
  /** `hash` is the source the user reviewed; a draft that changed since is refused. */
  readonly approve: (name: string, hash: string) => Effect.Effect<Workbench.CustomTool, ToolError>
  readonly reject: (name: string) => Effect.Effect<void, ToolError>
  readonly disable: (name: string) => Effect.Effect<Workbench.CustomTool, ToolError>
  readonly enable: (name: string, hash: string) => Effect.Effect<Workbench.CustomTool, ToolError>
  readonly remove: (name: string) => Effect.Effect<void, ToolError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkbenchTools") {}

/** The instance's .opencode folder, where drafts and created tools live; the registry scans it too. */
export const folder = (directory: string) => path.join(directory, ".opencode")

const files = (directory: string, name: string) => ({
  draft: path.join(folder(directory), "tool-drafts", `${name}.ts`),
  enabled: path.join(folder(directory), "tool", `custom_${name}.ts`),
  disabled: path.join(folder(directory), "tool", `custom_${name}.ts.disabled`),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const npm = yield* Npm.Service

    const key = (projectID: string, name: string) => ["workbench", "tool", projectID, name]
    const meta = Effect.fnUntraced(function* (name: string) {
      const ctx = yield* InstanceState.context
      const found = yield* storage.read<Meta>(key(ctx.project.id, name)).pipe(Effect.option)
      return found._tag === "Some" && found.value.directory === ctx.directory ? found.value : undefined
    })
    const save = Effect.fnUntraced(function* (name: string, value: Meta | undefined) {
      const ctx = yield* InstanceState.context
      if (value) yield* storage.write(key(ctx.project.id, name), value).pipe(Effect.orDie)
      else yield* storage.remove(key(ctx.project.id, name)).pipe(Effect.ignore)
    })

    const read = Effect.fnUntraced(function* (name: string, file: string, status: Workbench.CustomToolStatus) {
      const source = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (source === undefined) return undefined
      const info = yield* meta(name)
      const modified = yield* Effect.promise(() =>
        stat(file)
          .then((item) => item.mtimeMs)
          .catch(() => Date.now()),
      )
      const hash = createHash("sha256").update(source).digest("hex")
      const checked = yield* Effect.promise(() => inspect(name, source))
      // Only a draft can be invalid; whether an enabled tool loaded is the registry's answer.
      const reason =
        status === "draft"
          ? (checked.reason ?? (info?.failed?.hash === hash ? info.failed.reason : undefined))
          : undefined
      return {
        name,
        id: `custom_${name}`,
        description: checked.description ?? info?.description ?? "",
        args: checked.args,
        status: reason ? "invalid" : status,
        ...(reason ? { reason } : {}),
        path: file,
        source,
        hash,
        createdBy: info?.createdBy ?? { by: "user" },
        createdAt: info?.createdAt ?? modified,
        updatedAt: modified,
      } satisfies Workbench.CustomTool
    })

    const one = Effect.fnUntraced(function* (name: string) {
      const where = files((yield* InstanceState.context).directory, name)
      return (
        (yield* read(name, where.enabled, "enabled")) ??
        (yield* read(name, where.disabled, "disabled")) ??
        (yield* read(name, where.draft, "draft"))
      )
    })

    const publish = (tool: Workbench.CustomTool | undefined, name: string) =>
      (tool
        ? events.publish(Workbench.Event.ToolUpdated, { tool })
        : events.publish(Workbench.Event.ToolRemoved, { name })
      ).pipe(Effect.ignore)

    // Writes the bytes the user reviewed (their hash was checked on these very bytes), never a file that may have
    // changed since: a temp file next to it, then a rename. The registry ignores *.tmp.
    const install = (file: string, source: string) => {
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      return fs.writeWithDirs(temp, source).pipe(Effect.andThen(fs.rename(temp, file)), Effect.orDie)
    }

    const missing = (name: string, what: string) =>
      new ToolError({ kind: "not_found", message: `no ${what} named ${name}` })

    // Loads an approved file the way the registry will, so a tool that fails to load never goes live. Bun keys
    // loaded modules by path (evict it), Node by URL (vary it): either way the current file is what loads.
    const load = (file: string) =>
      Effect.tryPromise({
        try: async () => {
          delete createRequire(import.meta.url).cache[file]
          const def = (await import(await url(file))).default
          if (!def || typeof def.description !== "string" || typeof def.execute !== "function" || !("args" in def))
            throw new Error("its default export is not tool({ description, args, execute })")
        },
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      })

    const list: Interface["list"] = Effect.fn("WorkbenchTools.list")(function* () {
      const base = folder((yield* InstanceState.context).directory)
      const names = (dir: string, pattern: RegExp) =>
        fs.readDirectory(path.join(base, dir)).pipe(
          Effect.map((entries) => entries.flatMap((entry) => pattern.exec(entry)?.slice(1, 2) ?? [])),
          Effect.orElseSucceed(() => [] as string[]),
        )
      const found = new Set([
        ...(yield* names("tool", /^custom_([a-z][a-z0-9_]*)\.ts(?:\.disabled)?$/)),
        ...(yield* names("tool-drafts", /^([a-z][a-z0-9_]*)\.ts$/)),
      ])
      const tools = yield* Effect.forEach(
        [...found].filter((name) => NAME.test(name)),
        (name) => {
          const where = files(path.dirname(base), name)
          return Effect.all([
            read(name, where.enabled, "enabled"),
            read(name, where.disabled, "disabled"),
            read(name, where.draft, "draft"),
          ])
        },
      )
      return tools
        .flat()
        .filter((tool) => tool !== undefined)
        .toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const draft: Interface["draft"] = Effect.fn("WorkbenchTools.draft")(function* (input, by) {
      if (!NAME.test(input.name))
        return yield* new ToolError({
          kind: "invalid",
          message: "the name must be lowercase letters, digits and _ (max 40), starting with a letter",
        })
      if (input.source.length > MAX_SOURCE)
        return yield* new ToolError({ kind: "invalid", message: `the source is larger than ${MAX_SOURCE / 1024} KB` })
      const ctx = yield* InstanceState.context
      const where = files(ctx.directory, input.name)
      if ((yield* fs.existsSafe(where.enabled)) || (yield* fs.existsSafe(where.disabled)))
        return yield* new ToolError({
          kind: "conflict",
          message: `custom_${input.name} already exists; pick another name or delete it in the IDE first`,
        })
      yield* fs.writeWithDirs(where.draft, input.source).pipe(Effect.orDie)
      yield* save(input.name, {
        directory: ctx.directory,
        createdBy: by,
        createdAt: Date.now(),
        description: input.description,
      })
      const tool = yield* read(input.name, where.draft, "draft")
      yield* publish(tool, input.name)
      return tool!
    })

    const approve: Interface["approve"] = Effect.fn("WorkbenchTools.approve")(function* (name, hash) {
      const directory = (yield* InstanceState.context).directory
      const where = files(directory, name)
      const tool = NAME.test(name) ? yield* read(name, where.draft, "draft") : undefined
      if (!tool) return yield* missing(name, "draft")
      if (tool.hash !== hash)
        return yield* new ToolError({ kind: "conflict", message: "the draft changed since you reviewed it" })
      if (tool.status === "invalid") return yield* new ToolError({ kind: "invalid", message: tool.reason! })
      if ((yield* fs.existsSafe(where.enabled)) || (yield* fs.existsSafe(where.disabled)))
        return yield* new ToolError({ kind: "conflict", message: `custom_${name} already exists` })
      // The file imports @opencode-ai/plugin; config installs it into each .opencode it loads, this one may be new.
      yield* npm
        .install(folder(directory), {
          add: [{ name: "@opencode-ai/plugin", version: InstallationLocal ? undefined : InstallationVersion }],
        })
        .pipe(Effect.mapError((error) => new ToolError({ kind: "invalid", message: error.message })))
      yield* install(where.enabled, tool.source)
      const failed = yield* load(where.enabled).pipe(Effect.flip, Effect.option)
      if (failed._tag === "Some") {
        yield* fs.remove(where.enabled).pipe(Effect.ignore)
        const reason = `it failed to load: ${failed.value}`
        const info = yield* meta(name)
        yield* save(name, {
          ...(info ?? { directory, createdBy: { by: "user" as const }, createdAt: Date.now() }),
          failed: { hash, reason },
        })
        yield* publish(yield* read(name, where.draft, "draft"), name)
        return yield* new ToolError({ kind: "invalid", message: reason })
      }
      yield* fs.remove(where.draft).pipe(Effect.ignore)
      const enabled = yield* read(name, where.enabled, "enabled")
      yield* publish(enabled, name)
      return enabled!
    })

    const reject: Interface["reject"] = Effect.fn("WorkbenchTools.reject")(function* (name) {
      const where = files((yield* InstanceState.context).directory, name)
      if (!NAME.test(name) || !(yield* fs.existsSafe(where.draft))) return yield* missing(name, "draft")
      yield* fs.remove(where.draft).pipe(Effect.orDie)
      const left = yield* one(name)
      if (!left) yield* save(name, undefined)
      yield* publish(left, name)
    })

    const disable: Interface["disable"] = Effect.fn("WorkbenchTools.disable")(function* (name) {
      const where = files((yield* InstanceState.context).directory, name)
      if (!NAME.test(name) || !(yield* fs.existsSafe(where.enabled))) return yield* missing(name, "enabled tool")
      yield* fs.rename(where.enabled, where.disabled).pipe(Effect.orDie)
      const tool = yield* read(name, where.disabled, "disabled")
      yield* publish(tool, name)
      return tool!
    })

    const enable: Interface["enable"] = Effect.fn("WorkbenchTools.enable")(function* (name, hash) {
      const where = files((yield* InstanceState.context).directory, name)
      const tool = NAME.test(name) ? yield* read(name, where.disabled, "disabled") : undefined
      if (!tool) return yield* missing(name, "disabled tool")
      if (tool.hash !== hash)
        return yield* new ToolError({ kind: "conflict", message: "the tool changed since you reviewed it" })
      // The bytes whose hash matched, not whatever the disabled file holds by now.
      yield* install(where.enabled, tool.source)
      const failed = yield* load(where.enabled).pipe(Effect.flip, Effect.option)
      if (failed._tag === "Some") {
        yield* fs.remove(where.enabled).pipe(Effect.ignore)
        return yield* new ToolError({ kind: "invalid", message: `it failed to load: ${failed.value}` })
      }
      yield* fs.remove(where.disabled).pipe(Effect.ignore)
      const enabled = yield* read(name, where.enabled, "enabled")
      yield* publish(enabled, name)
      return enabled!
    })

    const remove: Interface["remove"] = Effect.fn("WorkbenchTools.remove")(function* (name) {
      const where = files((yield* InstanceState.context).directory, name)
      const present = NAME.test(name) ? yield* Effect.filter(Object.values(where), (file) => fs.existsSafe(file)) : []
      if (!present.length) return yield* missing(name, "tool or draft")
      yield* Effect.forEach(present, (file) => fs.remove(file).pipe(Effect.orDie), { discard: true })
      yield* save(name, undefined)
      yield* publish(undefined, name)
    })

    return Service.of({ list, draft, approve, reject, disable, enable, remove })
  }),
)

/** The URL a created tool's file is imported from: it changes with the file, so Node loads the current version. */
export async function url(file: string) {
  return `${pathToFileURL(file).href}?v=${Math.floor((await stat(file)).mtimeMs)}`
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, Storage.node, EventV2Bridge.node, Npm.node],
})

export * as WorkbenchTools from "./tools"
