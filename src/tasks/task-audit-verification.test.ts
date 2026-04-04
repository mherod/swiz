import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createDefaultTaskStore } from "../task-roots.ts"
import {
  appendAuditEntry,
  getLastAuditEntry,
  readAuditLog,
  readRecentAuditEntries,
  verifyAuditEntry,
} from "./task-audit-verification.ts"
import type { Task } from "./task-repository.ts"
import { writeTaskUpdate } from "./task-service.ts"

describe("Task Audit Log Verification", () => {
  const testSessionId = `test-session-${Date.now()}`
  const tasksDir = createDefaultTaskStore().tasksDir
  const sessionDir = join(tasksDir, testSessionId)

  afterEach(async () => {
    try {
      await rm(sessionDir, { recursive: true, force: true })
    } catch {}
  })

  it("should log action: 'field_update' when status does not change", async () => {
    const sessionId = `${testSessionId}-field-update`
    const task: Task = {
      id: "1",
      subject: "Initial Subject",
      description: "Initial Description",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }

    const testSessionDir = join(tasksDir, sessionId)
    await mkdir(testSessionDir, { recursive: true })

    task.description = "Updated Description"
    await writeTaskUpdate(sessionId, "1", task)

    const entry = await getLastAuditEntry(sessionId)
    expect(entry).not.toBeNull()
    expect(entry!.action).toBe("field_update")
    expect(entry!.taskId).toBe("1")
    expect(entry!.oldStatus).toBe("pending")
    expect(entry!.newStatus).toBe("pending")

    await rm(testSessionDir, { recursive: true, force: true })
  })

  it("should log action: 'status_change' when status changes", async () => {
    const sessionId = `${testSessionId}-status-change`
    const task: Task = {
      id: "2",
      subject: "Status Task",
      description: "Desc",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }

    const testSessionDir = join(tasksDir, sessionId)
    await mkdir(testSessionDir, { recursive: true })

    await writeTaskUpdate(sessionId, "2", task, "in_progress")

    const entry = await getLastAuditEntry(sessionId)
    expect(entry).not.toBeNull()
    expect(entry!.action).toBe("status_change")
    expect(entry!.taskId).toBe("2")
    expect(entry!.oldStatus).toBe("pending")
    expect(entry!.newStatus).toBe("in_progress")

    await rm(testSessionDir, { recursive: true, force: true })
  })

  it("readAuditLog returns all entries in order", async () => {
    const sessionId = `${testSessionId}-full-log`
    const task: Task = {
      id: "3",
      subject: "Multi Task",
      description: "Desc",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }

    const testSessionDir = join(tasksDir, sessionId)
    await mkdir(testSessionDir, { recursive: true })

    await writeTaskUpdate(sessionId, "3", task)
    await writeTaskUpdate(sessionId, "3", task, "in_progress")

    const entries = await readAuditLog(sessionId)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.action).toBe("field_update")
    expect(entries[1]!.action).toBe("status_change")

    await rm(testSessionDir, { recursive: true, force: true })
  })

  it("readRecentAuditEntries returns only the N most recent", async () => {
    const sessionId = `${testSessionId}-recent`
    const task: Task = {
      id: "4",
      subject: "Recent Task",
      description: "Desc",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }

    const testSessionDir = join(tasksDir, sessionId)
    await mkdir(testSessionDir, { recursive: true })

    await writeTaskUpdate(sessionId, "4", task)
    await writeTaskUpdate(sessionId, "4", task, "in_progress")
    await writeTaskUpdate(sessionId, "4", task, "completed")

    const recent = await readRecentAuditEntries(sessionId, 1)
    expect(recent).toHaveLength(1)
    expect(recent[0]!.newStatus).toBe("completed")

    await rm(testSessionDir, { recursive: true, force: true })
  })

  it("readAuditLog returns empty array for missing session", async () => {
    const entries = await readAuditLog("nonexistent-session-xyz")
    expect(entries).toEqual([])
  })

  it("verifyAuditEntry detects mismatches", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      taskId: "1",
      action: "status_change" as const,
      oldStatus: "pending" as const,
      newStatus: "in_progress" as const,
    }

    expect(verifyAuditEntry(entry, { taskId: "1", action: "status_change" })).toBeNull()
    expect(verifyAuditEntry(entry, { action: "field_update" })).toContain("action")
    expect(verifyAuditEntry(entry, { taskId: "99" })).toContain("taskId")
  })

  it("appendAuditEntry writes entry and auto-fills timestamp", async () => {
    const sessionId = `${testSessionId}-append`
    const testSessionDir = join(tasksDir, sessionId)
    await mkdir(testSessionDir, { recursive: true })

    await appendAuditEntry(sessionId, {
      taskId: "10",
      action: "create",
      oldStatus: undefined,
      newStatus: "pending",
      subject: "Appended task",
    })

    const entry = await getLastAuditEntry(sessionId)
    expect(entry).not.toBeNull()
    expect(entry!.taskId).toBe("10")
    expect(entry!.action).toBe("create")
    expect(entry!.newStatus).toBe("pending")
    expect(entry!.subject).toBe("Appended task")
    expect(entry!.timestamp).toBeTruthy()

    await rm(testSessionDir, { recursive: true, force: true })
  })

  it("appendAuditEntry preserves explicit timestamp", async () => {
    const sessionId = `${testSessionId}-ts`
    const testSessionDir = join(tasksDir, sessionId)
    await mkdir(testSessionDir, { recursive: true })

    const fixedTs = "2026-01-01T00:00:00.000Z"
    await appendAuditEntry(sessionId, {
      taskId: "11",
      action: "status_change",
      oldStatus: "pending",
      newStatus: "in_progress",
      timestamp: fixedTs,
    })

    const entry = await getLastAuditEntry(sessionId)
    expect(entry!.timestamp).toBe(fixedTs)

    await rm(testSessionDir, { recursive: true, force: true })
  })
})
