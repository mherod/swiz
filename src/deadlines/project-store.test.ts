import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { DeadlineStore, deadlineSessionKey } from "./store.ts"

const tmp = useTempDir("swiz-project-deadline-")
const initial = {
  action: "set" as const,
  requestId: "create",
  label: "Delivery",
  completionCriteria: "Verified build",
  durationMinutes: 30,
}

test("Reminders completion is reversible, audited, project scoped and retry safe", async () => {
  const cwd = await tmp.create()
  const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
  try {
    const first = store.mutateProject(initial, cwd, 1000)
    const complete = {
      deadlineId: first.id,
      expectedRevision: 1,
      requestId: "checked",
      completed: true,
    }
    expect(() => store.syncProjectCompletion(complete, join(cwd, "unrelated"))).toThrow(
      "does not belong"
    )
    const closed = store.syncProjectCompletion(complete, cwd, Date.parse(first.dueAt) + 1)
    expect(closed.status).toBe("completed")
    expect(store.syncProjectCompletion(complete, cwd)).toEqual(closed)
    expect(() => store.syncProjectCompletion({ ...complete, requestId: "stale" }, cwd)).toThrow(
      "Revision conflict"
    )
    const reopen = { ...complete, requestId: "unchecked", expectedRevision: 2, completed: false }
    const active = store.syncProjectCompletion(reopen, cwd)
    expect(active.status).toBe("active")
    expect(active.closedAt).toBeUndefined()
    expect(active.dueAt).toBe(first.dueAt)
    expect(active.originalDueAt).toBe(first.originalDueAt)
    expect(active.missedDueAts).toEqual(closed.missedDueAts)
    expect(store.listProject(cwd)[0]?.sessionKeys).toEqual(["project:swizbuzz"])
    expect(store.history(first.id).map((item) => item.reason)).toEqual([
      "Reopened in Apple Reminders",
      "Marked complete in Apple Reminders",
      "Deadline set",
    ])
    expect(store.syncProjectCompletion(reopen, cwd).revision).toBe(3)
    store.mutateProject(
      {
        action: "cancel",
        requestId: "cancel",
        deadlineId: first.id,
        expectedRevision: 3,
        reason: "Test cleanup",
      },
      cwd
    )
    expect(() =>
      store.syncProjectCompletion({ ...reopen, requestId: "cancelled", expectedRevision: 4 }, cwd)
    ).toThrow("Cancelled")
  } finally {
    store.close()
  }
})

test("project management preserves agent bindings and atomically enforces revisions and membership", async () => {
  const cwd = await tmp.create()
  const other = await tmp.create()
  const store = (await DeadlineStore.open(join(cwd, "deadlines.db"), true))!
  try {
    const deadline = store.mutate({ ...initial, sessionId: "agent" }, cwd)
    const change = {
      action: "revise" as const,
      requestId: "revise",
      deadlineId: deadline.id,
      expectedRevision: 1,
      reason: "Allow verification",
      durationMinutes: 40,
    }
    expect(() => store.mutateProject(change, other)).toThrow("does not belong")
    const revised = store.mutateProject(change, cwd)
    expect(revised.revision).toBe(2)
    expect(store.mutateProject(change, cwd)).toEqual(revised)
    expect(store.listProject(cwd)[0]?.sessionKeys).toEqual(["agent"])
    expect(store.list(deadlineSessionKey(cwd, "project:swizbuzz"))).toEqual([])
    expect(() => store.mutateProject({ ...change, requestId: "stale" }, cwd)).toThrow(
      "Revision conflict"
    )
    expect(() =>
      store.mutate(
        { ...change, sessionId: "unrelated", requestId: "agent-attempt", expectedRevision: 2 },
        cwd
      )
    ).toThrow("Attach")
    expect(() =>
      store.mutateProject(
        { ...change, requestId: "missing-reason", expectedRevision: 2, reason: undefined },
        cwd
      )
    ).toThrow("requires reason")
    const completed = store.mutateProject(
      {
        action: "complete",
        requestId: "done",
        deadlineId: deadline.id,
        expectedRevision: 2,
        reason: "test: build passed",
      },
      cwd
    )
    expect(completed.status).toBe("completed")
    expect(store.history(deadline.id)).toHaveLength(3)
    expect(store.history(deadline.id)[0]?.reason).toBe("test: build passed")
    expect(() =>
      store.mutateProject({ ...change, expectedRevision: 3, requestId: "reopen" }, cwd)
    ).toThrow("history is closed")
  } finally {
    store.close()
  }
})

test("project creation and cancellation recover durable receipts after reopening", async () => {
  const cwd = await tmp.create()
  const path = join(cwd, "deadlines.db")
  const store = (await DeadlineStore.open(path, true))!
  const deadline = store.mutateProject(initial, cwd)
  store.close()
  const reopened = (await DeadlineStore.open(path, true))!
  try {
    expect(reopened.mutateProject(initial, cwd).id).toBe(deadline.id)
    expect(reopened.listProject(cwd)[0]?.sessionKeys).toEqual(["project:swizbuzz"])
    expect(() => reopened.mutateProject({ ...initial, label: "Changed" }, cwd)).toThrow(
      "different arguments"
    )
    expect(() => reopened.mutateProject({ ...initial, action: "attach" }, cwd)).toThrow(
      "Unsupported"
    )
    const cancel = {
      action: "cancel" as const,
      requestId: "cancel",
      deadlineId: deadline.id,
      expectedRevision: 1,
      reason: "No longer required",
    }
    expect(reopened.mutateProject(cancel, cwd).status).toBe("cancelled")
    expect(reopened.mutateProject(cancel, cwd).revision).toBe(2)
    expect(reopened.history(deadline.id)).toHaveLength(2)
  } finally {
    reopened.close()
  }
})
