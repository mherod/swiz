import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyTaskCreateEvent,
  applyTaskUpdateEvent,
  clearAllEventState,
  needsReconciliation,
} from "../src/tasks/task-event-state.ts"
import { TASKLIST_ARCHIVE_DIRNAME } from "../src/tasks/task-list-reconciliation.ts"
import {
  getSessionTaskPath,
  getSessionTasksDir,
  readSessionTasks,
  readSessionTasksFresh,
  setGlobalTaskStateCache,
} from "../src/tasks/task-recovery.ts"
import { TaskStateCache } from "../src/tasks/task-state-cache.ts"
import { taskListSyncSentinelPath } from "../src/temp-paths.ts"
import { runHook } from "../src/utils/test-utils.ts"
import { evaluatePosttooluseTaskListSync } from "./posttooluse-task-sync.ts"

const HOOK = join(import.meta.dir, "posttooluse-task-list-sync.ts")

const TMP_HOME = join(tmpdir(), `task-list-sync-test-${process.pid}`)
const SESSION_ID = `test-session-sync-${process.pid}`
const TASKS_DIR =
  getSessionTasksDir(SESSION_ID, TMP_HOME) ??
  (() => {
    throw new Error("Failed to resolve session tasks directory")
  })()

function taskPath(id: string): string {
  return (
    getSessionTaskPath(SESSION_ID, id, TMP_HOME) ??
    (() => {
      throw new Error(`Failed to resolve task path for ${id}`)
    })()
  )
}

function taskPathForSession(sessionId: string, id: string): string {
  return (
    getSessionTaskPath(sessionId, id, TMP_HOME) ??
    (() => {
      throw new Error(`Failed to resolve task path for ${id}`)
    })()
  )
}

async function readTask(id: string): Promise<Record<string, any>> {
  return JSON.parse(await Bun.file(taskPath(id)).text())
}

function makeTaskListResponse(tasks: { id: string; subject: string; status: string }[]): unknown {
  return { tasks }
}

beforeAll(async () => {
  await mkdir(TASKS_DIR, { recursive: true })
  // Pre-populate one existing task
  await Bun.write(
    taskPath("10"),
    JSON.stringify({ id: "10", subject: "Existing task", status: "pending" })
  )
})

afterAll(async () => {
  await rm(TMP_HOME, { recursive: true, force: true })
})

describe("posttooluse-task-list-sync", () => {
  test("no output for non-TaskList tools", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_response: makeTaskListResponse([{ id: "1", subject: "Some task", status: "pending" }]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when no session_id", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([{ id: "1", subject: "Some task", status: "pending" }]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when tool_response is null", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: null,
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when tasks array is empty", async () => {
    const sessionId = `${SESSION_ID}-empty-output`
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: sessionId,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("authoritative empty TaskList clears reconciliation state", async () => {
    const sessionId = `${SESSION_ID}-empty-reconciliation`
    const tasksDir = getSessionTasksDir(sessionId, TMP_HOME)!
    const staleTask = { id: "1", subject: "Task", status: "completed" }
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(taskPathForSession(sessionId, "1"), JSON.stringify(staleTask))

    const cache = new TaskStateCache({ maxEntries: 10 })
    cache.applyTaskListSnapshot(sessionId, [staleTask], Date.now() - 1_000)
    setGlobalTaskStateCache(cache)
    applyTaskCreateEvent(sessionId, "1", "Task")
    applyTaskUpdateEvent(sessionId, "1", { status: "completed" })
    expect(needsReconciliation(sessionId)).toBe(true)

    try {
      const output = await evaluatePosttooluseTaskListSync(
        {
          _agent: "claude",
          cwd: "/tmp",
          session_id: sessionId,
          tool_name: "TaskList",
          tool_response: makeTaskListResponse([]),
        },
        { home: TMP_HOME }
      )

      expect(output).toEqual({})
      expect(needsReconciliation(sessionId)).toBe(false)
      expect(await readSessionTasks(sessionId, TMP_HOME)).toEqual([])
      expect(await readSessionTasksFresh(sessionId, TMP_HOME)).toEqual([])
      expect(await Bun.file(taskPathForSession(sessionId, "1")).exists()).toBe(false)

      const archiveBatches = await readdir(join(tasksDir, TASKLIST_ARCHIVE_DIRNAME))
      expect(archiveBatches).toHaveLength(1)
      expect(
        await Bun.file(
          join(tasksDir, TASKLIST_ARCHIVE_DIRNAME, archiveBatches[0]!, "1.json")
        ).exists()
      ).toBe(true)
    } finally {
      setGlobalTaskStateCache(null)
      cache.close()
      clearAllEventState()
    }
  })

  test("persistence failures do not advance sentinel, cache, or event state", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    setGlobalTaskStateCache(cache)

    try {
      for (const operation of ["create", "update", "parse"] as const) {
        const sessionId = `${SESSION_ID}-${operation}-failure`
        const tasksDir = getSessionTasksDir(sessionId, TMP_HOME)!
        const staleTask = { id: "old", subject: "Prior task", status: "pending" }
        await mkdir(tasksDir, { recursive: true })
        cache.applyTaskListSnapshot(sessionId, [staleTask], Date.now() - 1_000)
        applyTaskCreateEvent(sessionId, "old", "Prior task")
        applyTaskUpdateEvent(sessionId, "old", { status: "completed" })

        let sentinelWrites = 0
        const output = (await evaluatePosttooluseTaskListSync(
          {
            _agent: "claude",
            cwd: "/tmp",
            session_id: sessionId,
            tool_name: "TaskList",
            tool_response: makeTaskListResponse([
              { id: "new", subject: "Sensitive task content", status: "pending" },
            ]),
          },
          {
            home: TMP_HOME,
            reconcile() {
              return Promise.resolve({
                created: 0,
                updated: 0,
                skipped: 0,
                archived: 0,
                failures: [{ operation, taskId: "new" }],
                resolvedTasks: [],
              })
            },
            writeSentinel() {
              sentinelWrites++
              return Promise.resolve(Date.now())
            },
          }
        )) as { hookSpecificOutput?: { additionalContext?: string } }

        const context = output.hookSpecificOutput?.additionalContext ?? ""
        expect(context).toContain("TaskList persistence was incomplete")
        expect(context).toContain("run TaskList again")
        expect(context).not.toContain("Sensitive task content")
        expect(sentinelWrites).toBe(0)
        expect(await Bun.file(taskListSyncSentinelPath(sessionId)).exists()).toBe(false)
        expect(needsReconciliation(sessionId)).toBe(true)
        expect((await cache.getState(sessionId, tasksDir)).tasks).toMatchObject([{ id: "old" }])
      }
    } finally {
      setGlobalTaskStateCache(null)
      cache.close()
      clearAllEventState()
    }
  })

  test("unknown status preserves reconciliation and freshness state", async () => {
    const sessionId = `${SESSION_ID}-unknown-status`
    applyTaskCreateEvent(sessionId, "1", "Task")
    applyTaskUpdateEvent(sessionId, "1", { status: "completed" })

    try {
      const output = (await evaluatePosttooluseTaskListSync({
        _agent: "claude",
        cwd: "/tmp",
        session_id: sessionId,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "1", subject: "Sensitive task content", status: "mystery" },
        ]),
      })) as { hookSpecificOutput?: { additionalContext?: string } }

      const context = output.hookSpecificOutput?.additionalContext ?? ""
      expect(context).toContain("TaskList response format was not recognized")
      expect(context).not.toContain("Sensitive task content")
      expect(needsReconciliation(sessionId)).toBe(true)
      expect(await Bun.file(taskListSyncSentinelPath(sessionId)).exists()).toBe(false)
    } finally {
      clearAllEventState()
    }
  })

  test("unrecognized non-empty TaskList preserves reconciliation with sanitized guidance", async () => {
    const sessionId = `${SESSION_ID}-unrecognized-reconciliation`
    const privateTaskContent = "private task content must stay hidden"
    applyTaskCreateEvent(sessionId, "1", "Task")
    applyTaskUpdateEvent(sessionId, "1", { status: "completed" })
    expect(needsReconciliation(sessionId)).toBe(true)

    try {
      const output = (await evaluatePosttooluseTaskListSync({
        _agent: "claude",
        cwd: "/tmp",
        session_id: sessionId,
        tool_name: "TaskList",
        tool_response: { results: [{ subject: privateTaskContent }] },
      })) as { hookSpecificOutput?: { additionalContext?: string } }
      const context = output.hookSpecificOutput?.additionalContext ?? ""

      expect(needsReconciliation(sessionId)).toBe(true)
      expect(context).toContain("TaskList response format was not recognized")
      expect(context).toContain("Run TaskList again")
      expect(context).not.toContain(privateTaskContent)
    } finally {
      clearAllEventState()
    }
  })

  test("creates new task file when it does not exist", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "20", subject: "Brand new task", status: "in_progress" },
        ]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 created")

    const task = await readTask("20")
    expect(task.id).toBe("20")
    expect(task.subject).toBe("Brand new task")
    expect(task.status).toBe("in_progress")

    const sentinel = await Bun.file(taskListSyncSentinelPath(SESSION_ID)).text()
    expect(Number.parseInt(sentinel.trim(), 10)).toBeGreaterThan(0)
  })

  test("skips task with no change (idempotent)", async () => {
    // Use a dedicated task ID for this test to avoid state from other tests
    await Bun.write(
      taskPath("11"),
      JSON.stringify({ id: "11", subject: "Stable task", status: "pending" })
    )
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "11", subject: "Stable task", status: "pending" },
        ]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    // No creates or updates, but count context is still emitted
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain(
      "Tasks: 0 in_progress, 1 pending"
    )
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(
      /No (active|engaged|ongoing|live|open|current|running) task yet/
    )
  })

  test("updates task file when status changes", async () => {
    await Bun.write(
      taskPath("12"),
      JSON.stringify({ id: "12", subject: "Status change task", status: "pending" })
    )
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "12", subject: "Status change task", status: "completed" },
        ]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 updated")

    const task = await readTask("12")
    expect(task.status).toBe("completed")
    expect(task.subject).toBe("Status change task")
  })

  test("updates task file when subject changes", async () => {
    await Bun.write(
      taskPath("13"),
      JSON.stringify({ id: "13", subject: "Original subject", status: "pending" })
    )
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "13", subject: "Renamed subject", status: "pending" },
        ]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 updated")

    const task = await readTask("13")
    expect(task.subject).toBe("Renamed subject")
    expect(task.status).toBe("pending")
  })

  test("preserves extra fields on existing task when merging", async () => {
    // Write a task with extra fields like description and completionEvidence
    await Bun.write(
      taskPath("30"),
      JSON.stringify({
        id: "30",
        subject: "Task with extras",
        status: "in_progress",
        description: "Important details",
        completionEvidence: "note:prior evidence",
      })
    )

    const { exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "30", subject: "Task with extras", status: "completed" },
        ]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    const task = await readTask("30")
    expect(task.status).toBe("completed")
    // Extra fields must be preserved
    expect(task.description).toBe("Important details")
    expect(task.completionEvidence).toBe("note:prior evidence")
  })

  test("handles string tool_response (JSON-encoded)", async () => {
    const responseObj = makeTaskListResponse([
      { id: "40", subject: "String-encoded task", status: "pending" },
    ])
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: JSON.stringify(responseObj),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 created")
    const task = await readTask("40")
    expect(task.subject).toBe("String-encoded task")
  })

  test("handles multiple tasks: mix of create, update, skip", async () => {
    // Use dedicated IDs for this test
    await Bun.write(
      taskPath("50"),
      JSON.stringify({ id: "50", subject: "Unchanged task", status: "pending" })
    )
    await Bun.write(
      taskPath("51"),
      JSON.stringify({ id: "51", subject: "Will be updated", status: "pending" })
    )
    // task "52" does not exist — will be created

    const { exitCode, stdout } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "50", subject: "Unchanged task", status: "pending" }, // skip
          { id: "51", subject: "Will be updated", status: "completed" }, // update
          { id: "52", subject: "New task C", status: "pending" }, // create
        ]),
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const ctx: string = parsed.hookSpecificOutput.additionalContext
    expect(ctx).toContain("1 created")
    expect(ctx).toContain("1 updated")
    expect(ctx).toContain("1 skipped")
    expect(ctx).toMatch(/3 task\(s\) in response/)
  })

  test("emits direct repair guidance when TaskList contains duplicate active subjects", async () => {
    const { exitCode, stdout } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: makeTaskListResponse([
          { id: "60", subject: "Resolve task state", status: "pending" },
          { id: "61", subject: "Resolve task state", status: "in_progress" },
        ]),
      },
      { HOME: TMP_HOME }
    )

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const ctx: string = parsed.hookSpecificOutput.additionalContext
    expect(ctx).toMatch(
      /resolve them before (continuing|moving on|proceeding|keeping going|pressing on|moving forward)/
    )
    expect(ctx).toContain("Pick the duplicate entry")
    expect(ctx).toContain('"Resolve task state" is on #60 (pending), #61 (in_progress)')
  })

  test("reports malformed tasks without exposing their content", async () => {
    const { exitCode, stdout } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskList",
        tool_response: {
          tasks: [
            { subject: "No id task", status: "pending" }, // no id
            { id: "99", status: "pending" }, // no subject
          ],
        },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const context: string = parsed.hookSpecificOutput.additionalContext
    expect(context).toContain("TaskList response format was not recognized")
    expect(context).toContain("Run TaskList again")
    expect(context).not.toContain("No id task")
  })
})
