import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseToolResponse,
  reconcileTasks,
  TASKLIST_ARCHIVE_DIRNAME,
} from "./task-list-reconciliation.ts"
import { getSessionTaskPath, getSessionTasksDir, readSessionTasks } from "./task-recovery.ts"

const TEST_HOME = join(tmpdir(), `task-list-reconciliation-${process.pid}`)
const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const

function tasksDir(sessionId: string): string {
  return (
    getSessionTasksDir(sessionId, TEST_HOME) ??
    (() => {
      throw new Error(`Failed to resolve task directory for ${sessionId}`)
    })()
  )
}

function taskPath(sessionId: string, taskId: string): string {
  return (
    getSessionTaskPath(sessionId, taskId, TEST_HOME) ??
    (() => {
      throw new Error(`Failed to resolve task path for ${taskId}`)
    })()
  )
}

beforeAll(async () => {
  await mkdir(TEST_HOME, { recursive: true })
})

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe("parseToolResponse", () => {
  test("recognizes an authoritative empty task list", () => {
    expect(parseToolResponse({ tasks: [] })).toEqual({
      kind: "recognized",
      tasks: [],
    })
  })

  test("distinguishes missing input from an unsupported non-empty shape", () => {
    expect(parseToolResponse(null)).toEqual({
      kind: "unrecognized",
      hasContent: false,
      reason: "missing-response",
    })
    expect(parseToolResponse({ results: [] })).toEqual({
      kind: "unrecognized",
      hasContent: true,
      reason: "unsupported-shape",
    })
  })

  test("rejects a non-empty tasks array containing malformed tasks", () => {
    expect(parseToolResponse({ tasks: [{ id: "1", status: "pending" }] })).toEqual({
      kind: "unrecognized",
      hasContent: true,
      reason: "malformed-task",
    })
  })

  test("accepts every canonical task status", () => {
    for (const status of TASK_STATUSES) {
      expect(parseToolResponse({ tasks: [{ id: "1", subject: "Task", status }] })).toEqual({
        kind: "recognized",
        tasks: [{ id: "1", subject: "Task", status }],
      })
    }
  })

  test("rejects unknown, blank, missing, and wrong-type statuses", () => {
    for (const status of ["mystery", "", 1, null]) {
      expect(parseToolResponse({ tasks: [{ id: "1", subject: "Task", status }] })).toEqual({
        kind: "unrecognized",
        hasContent: true,
        reason: "malformed-task",
      })
    }
    expect(parseToolResponse({ tasks: [{ id: "1", subject: "Task" }] })).toEqual({
      kind: "unrecognized",
      hasContent: true,
      reason: "malformed-task",
    })
  })
})

describe("reconcileTasks", () => {
  test("reports a failed task create explicitly", async () => {
    const sessionId = `create-failure-${process.pid}`
    await mkdir(tasksDir(sessionId), { recursive: true })

    const result = await reconcileTasks(
      [{ id: "1", subject: "New task", status: "pending" }],
      TEST_HOME,
      sessionId,
      {
        async writeJson() {
          throw new Error("injected create failure")
        },
      }
    )

    expect(result.failures).toEqual([{ operation: "create", taskId: "1" }])
    expect(result.resolvedTasks).toEqual([])
  })

  test("reports a failed task update without returning stale cache data", async () => {
    const sessionId = `update-failure-${process.pid}`
    await mkdir(tasksDir(sessionId), { recursive: true })
    await Bun.write(
      taskPath(sessionId, "1"),
      JSON.stringify({ id: "1", subject: "Task", status: "pending" })
    )

    const result = await reconcileTasks(
      [{ id: "1", subject: "Task", status: "completed" }],
      TEST_HOME,
      sessionId,
      {
        async writeJson() {
          throw new Error("injected update failure")
        },
      }
    )

    expect(result.failures).toEqual([{ operation: "update", taskId: "1" }])
    expect(result.resolvedTasks).toEqual([])
    expect(JSON.parse(await Bun.file(taskPath(sessionId, "1")).text()).status).toBe("pending")
  })

  test("reports a corrupt active task file as a parse failure", async () => {
    const sessionId = `parse-failure-${process.pid}`
    await mkdir(tasksDir(sessionId), { recursive: true })
    await Bun.write(taskPath(sessionId, "1"), "{not-json")

    const result = await reconcileTasks(
      [{ id: "1", subject: "Task", status: "pending" }],
      TEST_HOME,
      sessionId
    )

    expect(result.failures).toEqual([{ operation: "parse", taskId: "1" }])
    expect(result.resolvedTasks).toEqual([])
  })

  test("preserves lifecycle timing when only the subject changes", async () => {
    const sessionId = `subject-only-${process.pid}`
    const existing = {
      id: "1",
      subject: "Original subject",
      status: "in_progress",
      statusChangedAt: "2026-08-05T12:00:00.000Z",
      elapsedMs: 4_000,
      startedAt: 1_754_395_200_000,
      completedAt: null,
    }
    await mkdir(tasksDir(sessionId), { recursive: true })
    await Bun.write(taskPath(sessionId, "1"), JSON.stringify(existing))

    const result = await reconcileTasks(
      [{ id: "1", subject: "Renamed subject", status: "in_progress" }],
      TEST_HOME,
      sessionId
    )

    expect(result.failures).toEqual([])
    expect(result.updated).toBe(1)
    expect(JSON.parse(await Bun.file(taskPath(sessionId, "1")).text())).toEqual({
      ...existing,
      subject: "Renamed subject",
    })
  })

  test("applies lifecycle timing consistently across every canonical status pair", async () => {
    for (const previousStatus of TASK_STATUSES) {
      for (const nextStatus of TASK_STATUSES) {
        const sessionId = `status-${previousStatus}-${nextStatus}-${process.pid}`
        const beforeTransitionMs = Date.now()
        const previousChangeMs = beforeTransitionMs - 5_000
        const previousChangeIso = new Date(previousChangeMs).toISOString()
        const existing = {
          id: "1",
          subject: "Original subject",
          status: previousStatus,
          statusChangedAt: previousChangeIso,
          elapsedMs: 4_000,
          startedAt: previousStatus === "in_progress" ? previousChangeMs : null,
          completedAt: previousStatus === "completed" ? previousChangeMs : null,
          ...(previousStatus === "completed"
            ? { completionTimestamp: previousChangeIso, completionEvidence: "verified" }
            : {}),
        }
        await mkdir(tasksDir(sessionId), { recursive: true })
        await Bun.write(taskPath(sessionId, "1"), JSON.stringify(existing))

        const result = await reconcileTasks(
          [{ id: "1", subject: "Renamed subject", status: nextStatus }],
          TEST_HOME,
          sessionId
        )
        const written = JSON.parse(await Bun.file(taskPath(sessionId, "1")).text())

        expect(result.failures).toEqual([])
        expect(result.updated).toBe(1)
        expect(written.subject).toBe("Renamed subject")
        expect(written.status).toBe(nextStatus)

        if (previousStatus === nextStatus) {
          expect(written).toEqual({ ...existing, subject: "Renamed subject" })
          continue
        }

        const transitionMs = Date.parse(written.statusChangedAt)
        expect(transitionMs).toBeGreaterThanOrEqual(beforeTransitionMs)
        expect(transitionMs).toBeLessThanOrEqual(Date.now())
        expect(written.elapsedMs).toBe(
          previousStatus === "in_progress"
            ? existing.elapsedMs + transitionMs - previousChangeMs
            : existing.elapsedMs
        )
        expect(written.startedAt).toBe(nextStatus === "in_progress" ? transitionMs : null)

        if (nextStatus === "completed") {
          expect(written.completedAt).toBe(transitionMs)
          expect(written.completionTimestamp).toBe(written.statusChangedAt)
        } else {
          expect(written.completedAt).toBeNull()
          expect(written.completionTimestamp).toBeUndefined()
          expect(written.completionEvidence).toBeUndefined()
        }
      }
    }
  })

  test("archives records omitted from a non-empty authoritative list", async () => {
    const sessionId = `omitted-task-${process.pid}`
    const dir = tasksDir(sessionId)
    await mkdir(dir, { recursive: true })
    await Bun.write(
      taskPath(sessionId, "1"),
      JSON.stringify({ id: "1", subject: "Current task", status: "pending" })
    )
    await Bun.write(
      taskPath(sessionId, "2"),
      JSON.stringify({ id: "2", subject: "Omitted task", status: "completed" })
    )

    const result = await reconcileTasks(
      [{ id: "1", subject: "Current task", status: "pending" }],
      TEST_HOME,
      sessionId
    )

    expect(result.failures).toEqual([])
    expect(result.archived).toBe(1)
    expect(await readSessionTasks(sessionId, TEST_HOME)).toMatchObject([{ id: "1" }])
    expect(await Bun.file(taskPath(sessionId, "2")).exists()).toBe(false)

    const archiveBatches = await readdir(join(dir, TASKLIST_ARCHIVE_DIRNAME))
    expect(archiveBatches).toHaveLength(1)
    expect(
      await Bun.file(join(dir, TASKLIST_ARCHIVE_DIRNAME, archiveBatches[0]!, "2.json")).exists()
    ).toBe(true)
  })
})
