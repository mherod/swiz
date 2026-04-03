import { afterEach, describe, expect, it } from "bun:test"
import {
  applyTaskCreateEvent,
  applyTaskListEvent,
  applyTaskUpdateEvent,
  clearAllEventState,
  eventStateSessionCount,
  getSessionEventState,
  hasSessionEventState,
  pruneSession,
} from "./task-event-state.ts"

afterEach(() => {
  clearAllEventState()
})

describe("task-event-state", () => {
  describe("getSessionEventState", () => {
    it("returns null for unknown session", () => {
      expect(getSessionEventState("unknown")).toBeNull()
    })

    it("returns tasks after events are applied", () => {
      applyTaskCreateEvent("s1", "1", "First task")
      const state = getSessionEventState("s1")
      expect(state).toHaveLength(1)
      expect(state![0]).toEqual({ id: "1", status: "pending", subject: "First task" })
    })
  })

  describe("applyTaskCreateEvent", () => {
    it("adds a new pending task", () => {
      applyTaskCreateEvent("s1", "1", "Build feature")
      const state = getSessionEventState("s1")!
      expect(state).toHaveLength(1)
      expect(state[0]!.status).toBe("pending")
      expect(state[0]!.subject).toBe("Build feature")
    })

    it("updates existing task if same ID", () => {
      applyTaskCreateEvent("s1", "1", "Original")
      applyTaskCreateEvent("s1", "1", "Updated")
      const state = getSessionEventState("s1")!
      expect(state).toHaveLength(1)
      expect(state[0]!.subject).toBe("Updated")
    })

    it("appends multiple tasks with different IDs", () => {
      applyTaskCreateEvent("s1", "1", "Task A")
      applyTaskCreateEvent("s1", "2", "Task B")
      expect(getSessionEventState("s1")).toHaveLength(2)
    })
  })

  describe("applyTaskUpdateEvent", () => {
    it("updates status of existing task", () => {
      applyTaskCreateEvent("s1", "1", "My task")
      applyTaskUpdateEvent("s1", "1", { status: "in_progress" })
      const state = getSessionEventState("s1")!
      expect(state[0]!.status).toBe("in_progress")
      expect(state[0]!.subject).toBe("My task")
    })

    it("updates subject of existing task", () => {
      applyTaskCreateEvent("s1", "1", "Old name")
      applyTaskUpdateEvent("s1", "1", { subject: "New name" })
      const state = getSessionEventState("s1")!
      expect(state[0]!.subject).toBe("New name")
      expect(state[0]!.status).toBe("pending")
    })

    it("updates both status and subject", () => {
      applyTaskCreateEvent("s1", "1", "Original")
      applyTaskUpdateEvent("s1", "1", { status: "completed", subject: "Done" })
      const state = getSessionEventState("s1")!
      expect(state[0]!.status).toBe("completed")
      expect(state[0]!.subject).toBe("Done")
    })

    it("adds task when ID not yet tracked", () => {
      applyTaskUpdateEvent("s1", "5", { status: "in_progress", subject: "Late arrival" })
      const state = getSessionEventState("s1")!
      expect(state).toHaveLength(1)
      expect(state[0]!.id).toBe("5")
      expect(state[0]!.status).toBe("in_progress")
    })

    it("defaults to pending status when no status provided for new task", () => {
      applyTaskUpdateEvent("s1", "5", { subject: "No status" })
      expect(getSessionEventState("s1")![0]!.status).toBe("pending")
    })
  })

  describe("applyTaskListEvent", () => {
    it("replaces entire session state", () => {
      applyTaskCreateEvent("s1", "1", "Old task")
      applyTaskListEvent("s1", [
        { id: "10", status: "in_progress", subject: "New A" },
        { id: "11", status: "pending", subject: "New B" },
      ])
      const state = getSessionEventState("s1")!
      expect(state).toHaveLength(2)
      expect(state[0]!.id).toBe("10")
      expect(state[1]!.id).toBe("11")
    })

    it("makes a defensive copy", () => {
      const original = [{ id: "1", status: "pending", subject: "Test" }]
      applyTaskListEvent("s1", original)
      original.push({ id: "2", status: "completed", subject: "Extra" })
      expect(getSessionEventState("s1")).toHaveLength(1)
    })
  })

  describe("session scoping", () => {
    it("isolates state across sessions", () => {
      applyTaskCreateEvent("s1", "1", "Session 1 task")
      applyTaskCreateEvent("s2", "1", "Session 2 task")
      expect(getSessionEventState("s1")![0]!.subject).toBe("Session 1 task")
      expect(getSessionEventState("s2")![0]!.subject).toBe("Session 2 task")
    })
  })

  describe("hasSessionEventState", () => {
    it("returns false for unknown session", () => {
      expect(hasSessionEventState("unknown")).toBe(false)
    })

    it("returns true after event applied", () => {
      applyTaskCreateEvent("s1", "1", "Task")
      expect(hasSessionEventState("s1")).toBe(true)
    })
  })

  describe("pruneSession", () => {
    it("removes session state", () => {
      applyTaskCreateEvent("s1", "1", "Task")
      pruneSession("s1")
      expect(getSessionEventState("s1")).toBeNull()
      expect(hasSessionEventState("s1")).toBe(false)
    })

    it("does not affect other sessions", () => {
      applyTaskCreateEvent("s1", "1", "Task 1")
      applyTaskCreateEvent("s2", "1", "Task 2")
      pruneSession("s1")
      expect(getSessionEventState("s2")).toHaveLength(1)
    })
  })

  describe("clearAllEventState", () => {
    it("removes all sessions", () => {
      applyTaskCreateEvent("s1", "1", "A")
      applyTaskCreateEvent("s2", "1", "B")
      clearAllEventState()
      expect(eventStateSessionCount()).toBe(0)
    })
  })

  describe("eventStateSessionCount", () => {
    it("tracks session count", () => {
      expect(eventStateSessionCount()).toBe(0)
      applyTaskCreateEvent("s1", "1", "A")
      expect(eventStateSessionCount()).toBe(1)
      applyTaskCreateEvent("s2", "1", "B")
      expect(eventStateSessionCount()).toBe(2)
    })
  })
})
