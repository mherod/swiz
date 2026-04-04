import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyTaskCreateEvent,
  applyTaskListEvent,
  applyTaskUpdateEvent,
  clearAllEventState,
  eventStateSessionCount,
  getSessionEventState,
  hasSessionEventState,
  pruneSession,
  seedSessionFromDisk,
} from "./task-event-state.ts"

/** Session IDs used by this test file — pruned after each test instead of
 *  calling clearAllEventState() which races with concurrent test files. */
const TEST_SESSIONS = ["s1", "s2", "seed1", "seed2", "seed3", "unknown"]

describe("task-event-state", () => {
  afterEach(() => {
    for (const id of TEST_SESSIONS) pruneSession(id)
  })

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
      expect(hasSessionEventState("s1")).toBe(false)
      expect(hasSessionEventState("s2")).toBe(false)
    })
  })

  describe("eventStateSessionCount", () => {
    it("tracks session count changes", () => {
      const before = eventStateSessionCount()
      applyTaskCreateEvent("s1", "1", "A")
      expect(eventStateSessionCount()).toBe(before + 1)
      applyTaskCreateEvent("s2", "1", "B")
      expect(eventStateSessionCount()).toBe(before + 2)
    })
  })

  describe("seedSessionFromDisk", () => {
    it("populates event state from task files", async () => {
      const dir = join(tmpdir(), `seed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, "1.json"),
        JSON.stringify({ id: "1", status: "pending", subject: "Task A" })
      )
      await writeFile(
        join(dir, "2.json"),
        JSON.stringify({ id: "2", status: "in_progress", subject: "Task B" })
      )

      await seedSessionFromDisk("seed1", dir)
      const state = getSessionEventState("seed1")
      expect(state).toHaveLength(2)
      expect(state!.find((t) => t.id === "1")!.status).toBe("pending")
      expect(state!.find((t) => t.id === "2")!.subject).toBe("Task B")
    })

    it("skips when event state already exists", async () => {
      const dir = join(tmpdir(), `seed-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, "1.json"),
        JSON.stringify({ id: "1", status: "pending", subject: "Disk task" })
      )

      applyTaskCreateEvent("seed2", "99", "Hook task")
      await seedSessionFromDisk("seed2", dir)

      const state = getSessionEventState("seed2")
      expect(state).toHaveLength(1)
      expect(state![0]!.id).toBe("99")
    })

    it("skips dotfiles and handles missing directory", async () => {
      await seedSessionFromDisk("seed3", "/nonexistent/path")
      expect(getSessionEventState("seed3")).toBeNull()
    })
  })
})
