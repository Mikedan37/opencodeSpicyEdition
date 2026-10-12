// Agent identities (name, avatar, provider, project). They live in the global JSON store and exist
// independently of any provider process; many identities may share one provider.
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InvalidInputError, NotFoundError } from "./provider"
import { AgentStore } from "./store"

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

type Draft = Record<string, unknown>

/** Agent HQ events carry the identity's project so the app files them under that directory. */
export function location(directory: string) {
  return { location: { directory: AbsolutePath.make(directory) } }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* AgentStore.Service
    const edits = KeyedMutex.makeUnsafe<string>()
    const events = yield* EventV2Bridge.Service
    const fs = yield* FSUtil.Service

    const read = Effect.fnUntraced(function* (id: string) {
      return yield* store.find(key(id), decode)
    })

    const get = Effect.fn("AgentHQRegistry.get")(function* (id: AgentHQ.AgentID) {
      const found = yield* read(id)
      if (Option.isNone(found)) return yield* new NotFoundError({ message: `Agent not found: ${id}` })
      return found.value
    })

    const list = Effect.fn("AgentHQRegistry.list")(function* () {
      const ids = yield* store.list(["agenthq", "agent"])
      const found = yield* Effect.forEach(ids, read, { concurrency: 8 })
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
      yield* store.write(key(agent.id), agent).pipe(Effect.orDie)
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
      // Merge into the stored record (fields this build does not know stay) under a per-identity lock, so
      // concurrent edits do not drop each other.
      const merged = yield* edits.withLock(id)(
        Effect.gen(function* () {
          const stored = yield* store.find(key(id), (value) => Option.map(decode(value), () => value as Draft))
          if (Option.isNone(stored)) return yield* new NotFoundError({ message: `Agent not found: ${id}` })
          const draft: Draft = { ...stored.value, ...patch }
          if (input.model === null) delete draft.model
          if (input.specialty === null) delete draft.specialty
          if (input.workingDirectory === null) delete draft.workingDirectory
          if (input.launch === null) delete draft.launch
          yield* store.write(key(id), draft).pipe(Effect.orDie)
          return draft
        }),
      )
      const agent = decode(merged)
      if (Option.isNone(agent)) return yield* Effect.die(new Error(`stored agent ${id} no longer decodes`))
      yield* events.publish(AgentHQ.Event.AgentUpdated, { agent: agent.value }, location(agent.value.projectDirectory))
      return agent.value
    })

    const remove = Effect.fn("AgentHQRegistry.remove")(function* (id: AgentHQ.AgentID) {
      const current = yield* get(id)
      yield* store.remove(key(id)).pipe(Effect.orDie)
      yield* events.publish(AgentHQ.Event.AgentRemoved, { id }, location(current.projectDirectory))
    })

    return Service.of({ list, get, create, update, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [AgentStore.node, EventV2Bridge.node, FSUtil.node],
})

export * as AgentRegistry from "./registry"
