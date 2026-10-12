// Agent HQ's records (identities, sessions and their histories, tasks, messages): JSON files in the Storage
// service's layout (`<data>/storage/<key>.json`), with two guarantees the shared service does not give, kept on the
// fork side instead of changing it for everyone:
// - A write goes to a temporary file in the same directory and is renamed over the record, so a crash mid-write
//   leaves the previous version whole.
// - A record that cannot be parsed or decoded is never overwritten: it is moved aside as `<file>.corrupt-<ms>` and
//   logged, and the caller decides what that means for its record.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Context, Effect, Layer, Option } from "effect"
import path from "path"

export type Read<A> =
  | { readonly _tag: "found"; readonly value: A }
  | { readonly _tag: "missing" }
  | { readonly _tag: "corrupt"; readonly reason: string }

type Decode<A> = (value: unknown) => Option.Option<A>

export interface Interface {
  /** A record as stored. A corrupt one stays where it is until the caller quarantines it. */
  readonly read: <A>(key: string[], decode: Decode<A>) => Effect.Effect<Read<A>, FSUtil.Error>
  /** A record, or none when it is missing or unreadable; a corrupt one is quarantined first. */
  readonly find: <A>(key: string[], decode: Decode<A>) => Effect.Effect<Option.Option<A>>
  /** Moves a record aside as `<file>.corrupt-<ms>`, logs why, and returns the new path. */
  readonly quarantine: (key: string[], reason: string) => Effect.Effect<string, FSUtil.Error>
  readonly write: (key: string[], value: unknown) => Effect.Effect<void, FSUtil.Error>
  readonly remove: (key: string[]) => Effect.Effect<void, FSUtil.Error>
  /** The ids of the records under `prefix`; temporary and quarantined files are not records. */
  readonly list: (prefix: string[]) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentHQStore") {}

/** Where the Storage service keeps `key`. */
export const file = (key: string[]) => path.join(Global.Path.data, "storage", ...key) + ".json"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    let writes = 0

    const read = <A>(key: string[], decode: Decode<A>) =>
      Effect.gen(function* () {
        const text = yield* fs
          .readFileString(file(key))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
        if (text === undefined) return { _tag: "missing" } as const
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          return { _tag: "corrupt", reason: "it is not valid JSON" } as const
        }
        const value = decode(json)
        if (Option.isNone(value)) return { _tag: "corrupt", reason: "it does not match the expected shape" } as const
        return { _tag: "found", value: value.value } as const
      })

    const quarantine = Effect.fnUntraced(function* (key: string[], reason: string) {
      const target = file(key)
      const aside = `${target}.corrupt-${Date.now()}`
      yield* fs.rename(target, aside)
      yield* Effect.logWarning("agenthq moved an unreadable record aside", { file: target, quarantined: aside, reason })
      return aside
    })

    const find = <A>(key: string[], decode: Decode<A>) =>
      read(key, decode).pipe(
        Effect.flatMap((result) => {
          if (result._tag === "found") return Effect.succeed(Option.some(result.value))
          if (result._tag === "missing") return Effect.succeed(Option.none<A>())
          return quarantine(key, result.reason).pipe(Effect.as(Option.none<A>()))
        }),
        Effect.catch((error) =>
          Effect.logWarning("agenthq could not read a record", { file: file(key), error }).pipe(
            Effect.as(Option.none<A>()),
          ),
        ),
      )

    const write = Effect.fnUntraced(function* (key: string[], value: unknown) {
      const target = file(key)
      const temp = `${target}.tmp-${process.pid}-${++writes}`
      yield* fs.writeWithDirs(temp, JSON.stringify(value, null, 2))
      yield* fs.rename(temp, target).pipe(Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore)))
    })

    const remove = (key: string[]) =>
      fs.remove(file(key)).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))

    const list = (prefix: string[]) =>
      fs.readDirectory(path.join(Global.Path.data, "storage", ...prefix)).pipe(
        Effect.map((names) =>
          names
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -".json".length))
            .toSorted(),
        ),
        Effect.orElseSucceed(() => []),
      )

    return Service.of({ read, find, quarantine, write, remove, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

export * as AgentStore from "./store"
