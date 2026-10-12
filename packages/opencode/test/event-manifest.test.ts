import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { EventManifest as SchemaEventManifest } from "@opencode-ai/schema/event-manifest"
import { Todo } from "@/session/todo"
import { EventManifest } from "@/event-manifest"
// spicy: fork-owned events (Workbench, Agent HQ, review) sit on top of upstream's count; see SPICY.md
import { Workbench } from "@opencode-ai/schema/workbench"
import { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { Review } from "@opencode-ai/schema/review"

const spicyEvents = Workbench.Event.Definitions.length + AgentHQ.Event.Definitions.length + Review.Event.Definitions.length

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.size).toBe(88 + spicyEvents) // spicy: upstream 88 + fork events
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(Todo.Event.Updated)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("contains only the current step settlement versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
