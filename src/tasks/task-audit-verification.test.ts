import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDefaultTaskStore } from "../task-roots.ts"
import { acquireEnvLock, releaseEnvLockFn } from "../utils/test-utils.ts"
import {
  appendAuditEntry,
  getLastAuditEntry,
  readAuditLog,
  readRecentAuditEntries,
  verifyAuditEntry,
} from "./task-audit-verification.ts"
import {
  projectStoreKey,
  readTaskStore,
  readTasks,
  sessionStoreKey,
  type Task,
  writeTask,
} from "./task-repository.ts"
import { completeTaskWithAutoTransition, updateStatus, writeTaskUpdate } from "./task-service.ts"
import { sessionDirPath } from "./task-store-path.ts"

describe("Task Audit Log Verification", () => {
  const testSessionId = `test-session-${Date.now()}`
  let home: string
  let previousHome: string | undefined
  let tasksDir: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "swiz-task-audit-"))
    await acquireEnvLock()
    previousHome = process.env.HOME
    process.env.HOME = home
    tasksDir = createDefaultTaskStore().tasksDir
  })

  afterEach(async () => {
    try {
      await rm(home, { recursive: true, force: true })
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      releaseEnvLockFn()
    }
  })

  it.each([
    "string",
    "typed",
  ])("preserves caller cwd and injected roots for %s addresses (#933)", async (kind) => {
    const filterCwd = join(home, "selected-project")
    const injectedRoot = join(home, "injected-tasks")
    const project = projectStoreKey(filterCwd)
    // Different logical names remain isolated; identical names deliberately alias in flat storage.
    const sibling = sessionStoreKey(`native-${project.key}`)
    const original: Task = {
      id: "7",
      subject: "Target record",
      description: "Before",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }
    await writeTask(project, { ...original }, filterCwd, injectedRoot)
    await writeTask(sibling, { ...original, subject: "Sibling record" }, filterCwd, injectedRoot)
    await writeTask(project, { ...original, subject: "Default root" }, filterCwd, tasksDir)
    const defaultPath = join(sessionDirPath(project, tasksDir), "7.json")
    const siblingPath = join(sessionDirPath(sibling, injectedRoot), "7.json")
    const defaultBefore = await Bun.file(defaultPath).text()
    const siblingBefore = await Bun.file(siblingPath).text()
    const address = kind === "typed" ? project : project.key
    const options = { filterCwd, tasksDir: injectedRoot }
    const edited = { ...original, description: "Caller fields" }
    await writeTaskUpdate(address, "7", edited, undefined, options)
    expect((await readTaskStore(project, injectedRoot))[0]?.description).toBe("Caller fields")
    await writeTaskUpdate(address, "7", edited, "in_progress", options)
    await updateStatus(address, "7", "completed", { ...options, evidence: "test:injected root" })
    const updated = (await readTaskStore(project, injectedRoot))[0]!
    expect(updated.status).toBe("completed")
    expect(updated.completionEvidence).toBe("test:injected root")
    expect(await Bun.file(defaultPath).text()).toBe(defaultBefore)
    expect(await Bun.file(siblingPath).text()).toBe(siblingBefore)
    const meta = await Bun.file(
      join(sessionDirPath(project, injectedRoot), ".session-meta.json")
    ).json()
    expect(meta.cwd).toBe(filterCwd)
    const audit = await Bun.file(
      join(sessionDirPath(project, injectedRoot), ".audit-log.jsonl")
    ).text()
    expect(
      audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).action)
    ).toEqual(["field_update", "status_change", "status_change"])
    expect(
      await Bun.file(join(sessionDirPath(project, tasksDir), ".audit-log.jsonl")).exists()
    ).toBe(false)
    expect(
      await Bun.file(join(sessionDirPath(sibling, injectedRoot), ".audit-log.jsonl")).exists()
    ).toBe(false)
  })

  it.each([
    "field",
    "status",
  ])("uses injected-root WIP checks for %s updates (#933)", async (mutation) => {
    const filterCwd = join(home, "limited-project")
    const injectedRoot = join(home, "limited-tasks")
    const key = projectStoreKey(filterCwd)
    const task: Task = {
      id: "7",
      subject: "Queued work",
      description: "Before",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }
    for (let i = 1; i <= 4; i++) {
      await writeTask(
        key,
        { ...task, id: String(i), status: "in_progress" },
        filterCwd,
        injectedRoot
      )
    }
    await writeTask(key, task, filterCwd, injectedRoot)
    const options = { filterCwd, tasksDir: injectedRoot }
    const write =
      mutation === "field"
        ? writeTaskUpdate(key, task.id, task, "in_progress", options)
        : updateStatus(key, task.id, "in_progress", options)
    await expect(write).rejects.toThrow("already has 4 in_progress tasks")
    expect((await readTaskStore(key, injectedRoot)).find((t) => t.id === task.id)?.status).toBe(
      "pending"
    )
    expect(
      await Bun.file(join(sessionDirPath(key, injectedRoot), ".audit-log.jsonl")).exists()
    ).toBe(false)
    // An evidenced completion can still take its transient hop at capacity, in this root.
    await completeTaskWithAutoTransition(key, task.id, {
      ...options,
      evidence: "test:already verified",
    })
    expect((await readTaskStore(key, injectedRoot)).find((t) => t.id === task.id)?.status).toBe(
      "completed"
    )
    expect(await readTaskStore(key, tasksDir)).toEqual([])
    const audit = await Bun.file(join(sessionDirPath(key, injectedRoot), ".audit-log.jsonl")).text()
    expect(
      audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).newStatus)
    ).toEqual(["in_progress", "completed"])
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

    await writeTask(sessionStoreKey(sessionId), task)
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

    await writeTask(sessionStoreKey(sessionId), task)
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

    await writeTask(sessionStoreKey(sessionId), task)
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

    await writeTask(sessionStoreKey(sessionId), task)
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

  describe("audit-log recovery in readTasks", () => {
    it("recovers a task from audit log when task file is corrupt", async () => {
      const sessionId = `${testSessionId}-recovery`
      const testSessionDir = join(tasksDir, sessionId)
      await mkdir(testSessionDir, { recursive: true })

      // Write a valid task first to generate audit entries
      const task: Task = {
        id: "1",
        subject: "Recoverable Task",
        description: "Should survive corruption",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }
      await writeTask(sessionStoreKey(sessionId), task)
      await writeTaskUpdate(sessionId, "1", task, "in_progress")

      // Corrupt the task file
      await writeFile(join(testSessionDir, "1.json"), "{{invalid json!!")

      // readTasks should recover from audit log
      const tasks = await readTasks(sessionId)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.id).toBe("1")
      expect(tasks[0]!.subject).toBe("Recoverable Task")
      expect(tasks[0]!.status).toBe("in_progress")

      await rm(testSessionDir, { recursive: true, force: true })
    })

    it("skips task when both file and audit log have no data", async () => {
      const sessionId = `${testSessionId}-no-audit`
      const testSessionDir = join(tasksDir, sessionId)
      await mkdir(testSessionDir, { recursive: true })

      // Write corrupt file with no audit log
      await writeFile(join(testSessionDir, "99.json"), "not json")

      const tasks = await readTasks(sessionId)
      expect(tasks).toHaveLength(0)

      await rm(testSessionDir, { recursive: true, force: true })
    })

    it("recovers correct status from multiple audit entries", async () => {
      const sessionId = `${testSessionId}-multi-audit`
      const testSessionDir = join(tasksDir, sessionId)
      await mkdir(testSessionDir, { recursive: true })

      // Create task and transition through statuses
      const task: Task = {
        id: "2",
        subject: "Multi-transition",
        description: "Goes through several states",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }
      await writeTask(sessionStoreKey(sessionId), task)
      await writeTaskUpdate(sessionId, "2", task)
      await writeTaskUpdate(sessionId, "2", task, "in_progress")
      await writeTaskUpdate(sessionId, "2", task, "completed")

      // Corrupt the file
      await writeFile(join(testSessionDir, "2.json"), "")

      const tasks = await readTasks(sessionId)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.status).toBe("completed")
      expect(tasks[0]!.subject).toBe("Multi-transition")

      await rm(testSessionDir, { recursive: true, force: true })
    })
  })
})
