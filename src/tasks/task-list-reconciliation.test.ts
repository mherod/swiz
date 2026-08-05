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
    for (const status of ["pending", "in_progress", "completed", "cancelled"] as const) {
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
