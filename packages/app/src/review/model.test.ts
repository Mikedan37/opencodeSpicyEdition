import { describe, expect, test } from "bun:test"
import type { Review } from "@opencode-ai/schema/review"
import { WorkbenchRequestError } from "@/workbench/client"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { agentFor, anchor, conflictReason, createReviewState, entries, step, type ReviewApi } from "./model"

function hunk(input: Partial<Review.Hunk> & Pick<Review.Hunk, "patch">): Review.Hunk {
  return { id: input.patch, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, ...input }
}

function file(path: string, hunks: Review.Hunk[] = [], extra: Partial<Review.File> = {}): Review.File {
  return {
    path,
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    hunks,
    state: hunks.length ? "pending" : "accepted",
    undoable: false,
    accepted: 0,
    rejected: 0,
    decided: [],
    ...extra,
  }
}

function changeset(id: string, files: Review.File[], updatedAt = 1): Review.ChangeSet {
  return {
    id: id as Review.ChangeSetID,
    owner: { kind: "opencode-session", id: id.replace("chg_", "") },
    files,
    counts: { files: 0, pending: 0, accepted: 0, rejected: 0, additions: 0, deletions: 0 },
    updatedAt,
  }
}

// An API whose calls stay pending until the test settles them.
function fakeApi() {
  const calls: {
    name: string
    args: unknown[]
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }[] = []
  const pending =
    (name: string) =>
    (...args: unknown[]) =>
      new Promise<never>((resolve, reject) => calls.push({ name, args, resolve: resolve as never, reject }))
  const api = {
    changesets: pending("changesets"),
    decideHunk: pending("decideHunk"),
    decideFile: pending("decideFile"),
    decideAll: pending("decideAll"),
    undo: pending("undo"),
  } as unknown as ReviewApi
  return { api, calls }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("review helpers", () => {
  test("hunk actions anchor under the last added line, or the last removed one", () => {
    expect(
      anchor(hunk({ patch: "@@ -2,1 +2,2 @@\n-a\n+b\n+c\n", oldStart: 2, oldLines: 1, newStart: 2, newLines: 2 })),
    ).toEqual({
      side: "additions",
      lineNumber: 3,
    })
    expect(anchor(hunk({ patch: "@@ -4,2 +3,0 @@\n-a\n-b\n", oldStart: 4, oldLines: 2, newStart: 3 }))).toEqual({
      side: "deletions",
      lineNumber: 5,
    })
  })

  test("409 reasons from the server map to explanations", () => {
    expect(conflictReason("hunk 2c635c5c0ccaa665 no longer matches the working tree; reload the changeset")).toBe(
      "editedSince",
    )
    expect(conflictReason("agent is still editing")).toBe("agentEditing")
    expect(conflictReason("the file changed while it was being reviewed")).toBe("changedWhileReviewing")
    expect(conflictReason("nothing to undo")).toBe("nothingToUndo")
    expect(conflictReason("the file changed since the reject")).toBe("changedSinceReject")
    expect(conflictReason("2 file(s) could not be rejected: a.txt, b.txt")).toBe("partial")
    expect(conflictReason("something else")).toBeUndefined()
  })

  test("a path belongs to the changeset that has it pending, newest first otherwise", () => {
    const pending = hunk({ patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" })
    const list = entries([
      changeset("chg_new", [file("a.txt"), file("c.txt")], 2),
      changeset("chg_old", [file("a.txt", [pending]), file("b.txt")], 1),
    ])
    expect(list.map((item) => [item.file.path, item.changeset.id])).toEqual([
      ["a.txt", "chg_old"],
      ["c.txt", "chg_new"],
      ["b.txt", "chg_old"],
    ])
  })

  test("a changeset is named after its Agent HQ identity, for external providers and Agent HQ opencode sessions", () => {
    const ada = { id: "agt_ada", name: "Ada" } as AgentHQ.AgentIdentity
    const owl = { id: "agt_owl", name: "Owl" } as AgentHQ.AgentIdentity
    const sessions = {
      ags_1: { id: "ags_1", agentID: "agt_ada", providerSessionID: "ses_hq" } as AgentHQ.AgentSessionInfo,
    }
    const external = {
      ...changeset("chg_ags_2", []),
      owner: { kind: "agenthq-session" as const, id: "ags_2" },
      agentID: "agt_owl",
    }
    expect(agentFor(external, [ada, owl], sessions)?.name).toBe("Owl")
    expect(agentFor(changeset("chg_ses_hq", []), [ada, owl], sessions)?.name).toBe("Ada")
    expect(agentFor(changeset("chg_ses_plain", []), [ada, owl], sessions)).toBeUndefined()
  })

  test("stepping between changed files wraps around", () => {
    expect(step(["a", "b", "c"], "c", 1)).toBe("a")
    expect(step(["a", "b", "c"], "a", -1)).toBe("c")
    expect(step(["a", "b", "c"], undefined, 1)).toBe("a")
    expect(step([], "a", 1)).toBeUndefined()
  })
})

describe("review state", () => {
  test("loads, applies events, and never lets an older copy replace a newer one", async () => {
    const fake = fakeApi()
    const review = createReviewState(fake.api)
    const done = review.refresh()
    fake.calls[0].resolve([changeset("chg_a", [file("a.txt")], 5)])
    await done
    expect(review.state.status).toBe("ready")
    expect(Object.keys(review.state.changesets)).toEqual(["chg_a"])

    review.event("review.changeset.updated", { changeset: changeset("chg_a", [file("b.txt")], 4) })
    expect(review.state.changesets.chg_a.files[0].path).toBe("a.txt")
    review.event("review.changeset.updated", { changeset: changeset("chg_a", [file("b.txt")], 6) })
    expect(review.state.changesets.chg_a.files[0].path).toBe("b.txt")
    review.event("review.changeset.updated", { changeset: { id: "not a changeset" } })
    review.event("review.changeset.removed", { id: "chg_a" })
    expect(review.state.changesets).toEqual({})
  })

  test("a list request asked for while one runs follows it, once", async () => {
    const fake = fakeApi()
    const review = createReviewState(fake.api)
    const first = review.refresh()
    void review.refresh()
    void review.refresh()
    expect(fake.calls.length).toBe(1)
    fake.calls[0].resolve([])
    await first
    await flush()
    expect(fake.calls.length).toBe(2)
  })

  test("a server without review routes is unavailable, not failed", async () => {
    const fake = fakeApi()
    const review = createReviewState(fake.api)
    const done = review.refresh()
    fake.calls[0].reject(new WorkbenchRequestError("unavailable", "GET /review/changesets: 404"))
    await done
    expect(review.state.status).toBe("unavailable")
  })

  test("a decision is busy until the reply, and its reply replaces the changeset", async () => {
    const fake = fakeApi()
    const review = createReviewState(fake.api)
    const done = review.decideHunk("chg_a", "a.txt", "h1", "accept")
    expect(review.busy("chg_a", "a.txt")).toBe(true)
    void review.decideFile("chg_a", "a.txt", "reject")
    expect(fake.calls.map((call) => [call.name, ...call.args])).toEqual([["decideHunk", "chg_a", "h1", "accept"]])
    fake.calls[0].resolve(changeset("chg_a", [file("a.txt", [], { accepted: 1 })], 2))
    await done
    expect(review.busy("chg_a", "a.txt")).toBe(false)
    expect(review.state.changesets.chg_a.files[0].accepted).toBe(1)
  })

  test("a 409 is explained and reloads the changesets; other failures only explain", async () => {
    const fake = fakeApi()
    const review = createReviewState(fake.api)
    const refused = review.decideFile("chg_a", "a.txt", "reject")
    fake.calls[0].reject(new WorkbenchRequestError("failed", "agent is still editing", 409))
    await flush()
    expect(fake.calls.map((call) => call.name)).toEqual(["decideFile", "changesets"])
    fake.calls[1].resolve([changeset("chg_a", [file("a.txt")], 3)])
    await refused
    expect(review.notice("chg_a", "a.txt")).toEqual({ reason: "agentEditing", message: "agent is still editing" })

    const failed = review.decideAll("chg_a", "accept")
    fake.calls[2].reject(new WorkbenchRequestError("failed", "POST /review/changesets/chg_a/all: 500", 500))
    await failed
    expect(review.notice("chg_a")).toEqual({ message: "POST /review/changesets/chg_a/all: 500" })
    expect(fake.calls.length).toBe(3)

    // The next decision on the file clears its explanation.
    void review.undo("chg_a", "a.txt")
    expect(review.notice("chg_a", "a.txt")).toBeUndefined()
  })
})
