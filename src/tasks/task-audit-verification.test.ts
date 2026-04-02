import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createDefaultTaskStore } from "../task-roots.ts"
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

    // Update only description
    task.description = "Updated Description"
    await writeTaskUpdate(sessionId, "1", task)

    const auditLogPath = join(testSessionDir, ".audit-log.jsonl")
    const logContent = await readFile(auditLogPath, "utf-8")
    const entry = JSON.parse(logContent.trim().split("\n").pop()!)

    expect(entry.action).toBe("field_update")
    expect(entry.taskId).toBe("1")
    expect(entry.oldStatus).toBe("pending")
    expect(entry.newStatus).toBe("pending")

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

    const auditLogPath = join(testSessionDir, ".audit-log.jsonl")
    const logContent = await readFile(auditLogPath, "utf-8")
    const entry = JSON.parse(logContent.trim().split("\n").pop()!)

    expect(entry.action).toBe("status_change")
    expect(entry.taskId).toBe("2")
    expect(entry.oldStatus).toBe("pending")
    expect(entry.newStatus).toBe("in_progress")

    await rm(testSessionDir, { recursive: true, force: true })
  })
})
