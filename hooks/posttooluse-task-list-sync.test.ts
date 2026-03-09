import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionTaskPath, getSessionTasksDir } from "./hook-utils.ts"

const HOOK = join(import.meta.dir, "posttooluse-task-list-sync.ts")

async function runHook(
  input: Record<string, unknown>
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new Response(JSON.stringify(input)).body!,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: TMP_HOME },
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { stdout: stdout.trim(), exitCode: proc.exitCode ?? 1 }
}

const TMP_HOME = join(tmpdir(), `task-list-sync-test-${process.pid}`)
const SESSION_ID = "test-session-sync-abc"
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

function readTask(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(taskPath(id), "utf-8"))
}

function makeTaskListResponse(tasks: { id: string; subject: string; status: string }[]): unknown {
  return { tasks }
}

beforeAll(() => {
  mkdirSync(TASKS_DIR, { recursive: true })
  // Pre-populate one existing task
  writeFileSync(
    taskPath("10"),
    JSON.stringify({ id: "10", subject: "Existing task", status: "pending" })
  )
})

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true })
})

describe("posttooluse-task-list-sync", () => {
  test("no output for non-TaskList tools", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "Bash",
      tool_response: makeTaskListResponse([{ id: "1", subject: "Some task", status: "pending" }]),
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when no session_id", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([{ id: "1", subject: "Some task", status: "pending" }]),
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when tool_response is null", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: null,
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when tasks array is empty", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([]),
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("creates new task file when it does not exist", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([
        { id: "20", subject: "Brand new task", status: "in_progress" },
      ]),
    })
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 created")

    const task = readTask("20")
    expect(task.id).toBe("20")
    expect(task.subject).toBe("Brand new task")
    expect(task.status).toBe("in_progress")
  })

  test("skips task with no change (idempotent)", async () => {
    // Use a dedicated task ID for this test to avoid state from other tests
    writeFileSync(
      taskPath("11"),
      JSON.stringify({ id: "11", subject: "Stable task", status: "pending" })
    )
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([
        { id: "11", subject: "Stable task", status: "pending" },
      ]),
    })
    expect(exitCode).toBe(0)
    // No creates or updates → no output
    expect(stdout).toBe("")
  })

  test("updates task file when status changes", async () => {
    writeFileSync(
      taskPath("12"),
      JSON.stringify({ id: "12", subject: "Status change task", status: "pending" })
    )
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([
        { id: "12", subject: "Status change task", status: "completed" },
      ]),
    })
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 updated")

    const task = readTask("12")
    expect(task.status).toBe("completed")
    expect(task.subject).toBe("Status change task")
  })

  test("updates task file when subject changes", async () => {
    writeFileSync(
      taskPath("13"),
      JSON.stringify({ id: "13", subject: "Original subject", status: "pending" })
    )
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([
        { id: "13", subject: "Renamed subject", status: "pending" },
      ]),
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 updated")

    const task = readTask("13")
    expect(task.subject).toBe("Renamed subject")
    expect(task.status).toBe("pending")
  })

  test("preserves extra fields on existing task when merging", async () => {
    // Write a task with extra fields like description and completionEvidence
    writeFileSync(
      taskPath("30"),
      JSON.stringify({
        id: "30",
        subject: "Task with extras",
        status: "in_progress",
        description: "Important details",
        completionEvidence: "note:prior evidence",
      })
    )

    const { exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([
        { id: "30", subject: "Task with extras", status: "completed" },
      ]),
    })
    expect(exitCode).toBe(0)
    const task = readTask("30")
    expect(task.status).toBe("completed")
    // Extra fields must be preserved
    expect(task.description).toBe("Important details")
    expect(task.completionEvidence).toBe("note:prior evidence")
  })

  test("handles string tool_response (JSON-encoded)", async () => {
    const responseObj = makeTaskListResponse([
      { id: "40", subject: "String-encoded task", status: "pending" },
    ])
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: JSON.stringify(responseObj),
    })
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("1 created")
    const task = readTask("40")
    expect(task.subject).toBe("String-encoded task")
  })

  test("handles multiple tasks: mix of create, update, skip", async () => {
    // Use dedicated IDs for this test
    writeFileSync(
      taskPath("50"),
      JSON.stringify({ id: "50", subject: "Unchanged task", status: "pending" })
    )
    writeFileSync(
      taskPath("51"),
      JSON.stringify({ id: "51", subject: "Will be updated", status: "pending" })
    )
    // task "52" does not exist — will be created

    const { exitCode, stdout } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: makeTaskListResponse([
        { id: "50", subject: "Unchanged task", status: "pending" }, // skip
        { id: "51", subject: "Will be updated", status: "completed" }, // update
        { id: "52", subject: "New task C", status: "pending" }, // create
      ]),
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const ctx: string = parsed.hookSpecificOutput.additionalContext
    expect(ctx).toContain("1 created")
    expect(ctx).toContain("1 updated")
    expect(ctx).toContain("1 skipped")
    expect(ctx).toMatch(/3 task\(s\) in response/)
  })

  test("skips tasks with missing id or subject", async () => {
    const { exitCode, stdout } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskList",
      tool_response: {
        tasks: [
          { subject: "No id task", status: "pending" }, // no id
          { id: "99", status: "pending" }, // no subject
        ],
      },
    })
    expect(exitCode).toBe(0)
    // Nothing valid to create → no output
    expect(stdout).toBe("")
  })
})
