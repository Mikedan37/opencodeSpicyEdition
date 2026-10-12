// Agent identities (name, avatar, provider, project). They live in the global JSON store and exist
// independently of any provider process; many identities may share one provider.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { InvalidInputError, NotFoundError } from "./provider"

const Launch = Schema.Struct({ command: Schema.String, args: Schema.Array(Schema.String) })

export const CreateInput = Schema.Struct({
  name: Schema.String,
  avatar: AgentHQ.Avatar,
  provider: AgentHQ.ProviderID,
  model: Schema.optional(Schema.String),
  specialty: Schema.optional(Schema.String),
  projectDirectory: Schema.String,
  workingDirectory: Schema.optional(Schema.String),
  launch: Schema.optional(Launch),
})
export type CreateInput = typeof CreateInput.Type

// `null` clears an optional field.
export const UpdateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  avatar: Schema.optional(AgentHQ.Avatar),
  provider: Schema.optional(AgentHQ.ProviderID),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  specialty: Schema.optional(Schema.NullOr(Schema.String)),
  projectDirectory: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(Schema.NullOr(Schema.String)),
  launch: Schema.optional(Schema.NullOr(Launch)),
})
export type UpdateInput = typeof UpdateInput.Type

export interface Interface {
  readonly list: () => Effect.Effect<AgentHQ.AgentIdentity[]>
  readonly get: (id: AgentHQ.AgentID) => Effect.Effect<AgentHQ.AgentIdentity, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<AgentHQ.AgentIdentity, InvalidInputError>
  readonly update: (
    id: AgentHQ.AgentID,
    input: UpdateInput,
  ) => Effect.Effect<AgentHQ.AgentIdentity, NotFoundError | InvalidInputError>
  readonly remove: (id: AgentHQ.AgentID) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentHQRegistry") {}

const decode = Schema.decodeUnknownOption(AgentHQ.AgentIdentity)
const key = (id: string) => ["agenthq", "agent", id]

/** Agent HQ events carry the identity's project so the app files them under that directory. */
export function location(directory: string) {
  return { location: { directory: AbsolutePath.make(directory) } }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const fs = yield* FSUtil.Service

    const read = Effect.fnUntraced(function* (id: string) {
      const value = yield* storage.read<unknown>(key(id)).pipe(Effect.option)
      return Option.flatMap(value, decode)
    })

    const get = Effect.fn("AgentHQRegistry.get")(function* (id: AgentHQ.AgentID) {
      const found = yield* read(id)
      if (Option.isNone(found)) return yield* new NotFoundError({ message: `Agent not found: ${id}` })
      return found.value
    })

    const list = Effect.fn("AgentHQRegistry.list")(function* () {
      const keys = yield* storage.list(["agenthq", "agent"]).pipe(Effect.orElseSucceed(() => []))
      const found = yield* Effect.forEach(keys, (item) => read(item.at(-1) ?? ""), { concurrency: 8 })
      return found.flatMap((item) => Option.toArray(item)).toSorted((a, b) => a.createdAt - b.createdAt)
    })

    const directory = Effect.fnUntraced(function* (field: string, value: string) {
      if (!path.isAbsolute(value))
        return yield* new InvalidInputError({ message: `${field} must be absolute: ${value}` })
      const resolved = FSUtil.resolve(value)
      if (!(yield* fs.isDir(resolved)))
        return yield* new InvalidInputError({ message: `${field} is not a directory: ${value}` })
      return resolved
    })

    const launch = Effect.fnUntraced(function* (value: typeof Launch.Type) {
      if (!value.command.trim()) return yield* new InvalidInputError({ message: "launch.command must not be empty" })
      return { command: value.command, args: [...value.args] }
    })

    const name = Effect.fnUntraced(function* (value: string) {
      const trimmed = value.trim()
      if (!trimmed) return yield* new InvalidInputError({ message: "name must not be empty" })
      return trimmed
    })

    const create = Effect.fn("AgentHQRegistry.create")(function* (input: CreateInput) {
      const now = Date.now()
      const agent: AgentHQ.AgentIdentity = {
        id: AgentHQ.AgentID.create(),
        name: yield* name(input.name),
        avatar: input.avatar,
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        ...(input.specialty ? { specialty: input.specialty } : {}),
        projectDirectory: yield* directory("projectDirectory", input.projectDirectory),
        ...(input.workingDirectory
          ? { workingDirectory: yield* directory("workingDirectory", input.workingDirectory) }
          : {}),
        ...(input.launch ? { launch: yield* launch(input.launch) } : {}),
        createdAt: now,
        updatedAt: now,
      }
      yield* storage.write(key(agent.id), agent).pipe(Effect.orDie)
      yield* events.publish(AgentHQ.Event.AgentUpdated, { agent }, location(agent.projectDirectory))
      return agent
    })

    const update = Effect.fn("AgentHQRegistry.update")(function* (id: AgentHQ.AgentID, input: UpdateInput) {
      yield* get(id)
      const patch = {
        ...(input.name !== undefined ? { name: yield* name(input.name) } : {}),
        ...(input.avatar ? { avatar: input.avatar } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.specialty ? { specialty: input.specialty } : {}),
        ...(input.projectDirectory
          ? { projectDirectory: yield* directory("projectDirectory", input.projectDirectory) }
          : {}),
        ...(input.workingDirectory
          ? { workingDirectory: yield* directory("workingDirectory", input.workingDirectory) }
          : {}),
        ...(input.launch ? { launch: yield* launch(input.launch) } : {}),
        updatedAt: Date.now(),
      }
      // Merge under the store's per-key lock so concurrent edits do not drop each other.
      const merged = yield* storage
        .update<Record<string, unknown>>(key(id), (draft) => {
          Object.assign(draft, patch)
          if (input.model === null) delete draft.model
          if (input.specialty === null) delete draft.specialty
          if (input.workingDirectory === null) delete draft.workingDirectory
          if (input.launch === null) delete draft.launch
        })
        .pipe(
          Effect.catchTag("NotFoundError", () => Effect.fail(new NotFoundError({ message: `Agent not found: ${id}` }))),
          Effect.catchTag(["FileSystemError", "PlatformError"], Effect.die),
        )
      const agent = decode(merged)
      if (Option.isNone(agent)) return yield* Effect.die(new Error(`stored agent ${id} no longer decodes`))
      yield* events.publish(AgentHQ.Event.AgentUpdated, { agent: agent.value }, location(agent.value.projectDirectory))
      return agent.value
    })

    const remove = Effect.fn("AgentHQRegistry.remove")(function* (id: AgentHQ.AgentID) {
      const current = yield* get(id)
      yield* storage.remove(key(id)).pipe(Effect.orDie)
      yield* events.publish(AgentHQ.Event.AgentRemoved, { id }, location(current.projectDirectory))
    })

    return Service.of({ list, get, create, update, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Storage.node, EventV2Bridge.node, FSUtil.node],
})

export * as AgentRegistry from "./registry"
