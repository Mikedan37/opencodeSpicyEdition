// Debugger control ownership plus one command queue per session.
// - idle: whoever issues the first control command becomes the owner.
// - agent / human: only the owner drives; anyone may read (inspect) while the program is stopped.
//   A human can always take over or stop; the agent can never take control from a human.
// - terminating: stop was requested, everything is refused until it is done.
// Commands, reads included, run one at a time, so a step and an inspection never interleave.
import { Effect, Semaphore } from "effect"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { DebugError } from "./client"

export type Actor = {
  readonly by: "agent" | "human"
  // Agent session that issued the command, when by = agent.
  readonly sessionID?: string
}

export type Kind = "control" | "read"

export function make(input: {
  readonly owner: Workbench.Owner
  readonly onChange: (change: { from: Workbench.Owner; to: Workbench.Owner; by: Actor["by"] | "system" }) => void
}) {
  const queue = Semaphore.makeUnsafe(1)
  const state = { owner: input.owner, since: Date.now() }

  const change = (to: Workbench.Owner, by: Actor["by"] | "system") => {
    if (state.owner === to) return
    const from = state.owner
    state.owner = to
    state.since = Date.now()
    input.onChange({ from, to, by })
  }

  const refusal = (actor: Actor, kind: Kind | "stop") => {
    if (state.owner === "terminating") return "the debug session is terminating"
    if (kind === "read") return undefined
    if (kind === "stop" && actor.by === "human") return undefined
    if (state.owner === "idle" || state.owner === actor.by) return undefined
    return `the debug session is controlled by the ${state.owner} since ${new Date(state.since).toISOString()}${
      actor.by === "agent"
        ? "; you may inspect it while it is stopped, or ask the user to hand it back"
        : "; take over first"
    }`
  }

  const check = (actor: Actor, kind: Kind | "stop") =>
    Effect.suspend(() => {
      const reason = refusal(actor, kind)
      if (reason) return Effect.fail(new DebugError({ kind: "not_owner", message: reason }))
      if (kind === "control" && state.owner === "idle") change(actor.by, actor.by)
      return Effect.void
    })

  return {
    get owner() {
      return state.owner
    },
    get since() {
      return state.since
    },
    change,
    check,
    /** Runs a command in the session queue after checking ownership before and after waiting for its turn. */
    run: <A, E, R>(actor: Actor, kind: Kind | "stop", effect: Effect.Effect<A, E, R>) =>
      check(actor, kind).pipe(Effect.andThen(queue.withPermits(1)(check(actor, kind).pipe(Effect.andThen(effect))))),
    /** Explicit hand-over. A human may set any owner; the agent may claim an idle session or release its own. */
    set: (to: "idle" | "agent" | "human", actor: Actor) =>
      Effect.suspend(() => {
        if (state.owner === "terminating")
          return Effect.fail(new DebugError({ kind: "not_owner", message: "the debug session is terminating" }))
        if (actor.by === "agent" && (state.owner === "human" || to === "human"))
          return Effect.fail(
            new DebugError({
              kind: "not_owner",
              message: "the agent cannot take control of a debug session; ask the user",
            }),
          )
        change(to, actor.by)
        return Effect.void
      }),
  }
}

export type Control = ReturnType<typeof make>

export * as DebugControl from "./control"
