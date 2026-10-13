import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"
// spicy: upstream's counts below were already stale at the fork base (session.next.revert.staged/cleared/committed
// landed without a test update): 58 server, 88 total, 35 durable. Fork-owned events sit on top; see SPICY.md
import { Workbench } from "../src/workbench"
import { AgentHQ } from "../src/agent-hq"
import { Review } from "../src/review"

const spicyEvents = [...Workbench.Event.Definitions, ...AgentHQ.Event.Definitions, ...Review.Event.Definitions]

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(58 + spicyEvents.length) // spicy: upstream 58 + fork events
    expect(EventManifest.Definitions.length).toBe(88 + spicyEvents.length) // spicy: upstream 88 + fork events
    // spicy: every fork event is registered as the latest definition of its type
    expect(spicyEvents.filter((definition) => EventManifest.Latest.get(definition.type) !== definition)).toEqual([])
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(88 + spicyEvents.length) // spicy: upstream 88 + fork events
    // spicy: upstream 35 + the fork's durable events (none today)
    expect(EventManifest.Durable.size).toBe(
      35 + spicyEvents.filter((definition) => definition.durable !== undefined).length,
    )
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    // spicy: was slice(40, 43); the three session.next.revert events sit before these upstream
    expect(EventManifest.Definitions.slice(43, 46)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
