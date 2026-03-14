import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionTasksDir } from "./hook-utils.ts"
import { runHook } from "./test-utils.ts"

const HOOK = join(import.meta.dir, "posttooluse-task-recovery.ts")

const TMP_HOME = join(tmpdir(), `task-recovery-test-${process.pid}`)
const SESSION_ID = "test-session-abc123"
const TASKS_DIR =
  getSessionTasksDir(SESSION_ID, TMP_HOME) ??
  (() => {
    throw new Error("Failed to resolve session tasks directory")
  })()

beforeAll(async () => {
  await mkdir(TASKS_DIR, { recursive: true })
  // Create a task file for ID "5"
  await Bun.write(
    join(TASKS_DIR, "5.json"),
    JSON.stringify({ id: "5", subject: "Existing task", status: "in_progress" })
  )
})

afterAll(async () => {
  await rm(TMP_HOME, { recursive: true, force: true })
})

describe("posttooluse-task-recovery", () => {
  test("no output when task exists on disk", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskUpdate",
        tool_input: { taskId: "5", status: "completed" },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("auto-recovers missing task and confirms recovery in context", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskUpdate",
        tool_input: { taskId: "999", status: "completed" },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Task #999 was missing")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("automatically recovered")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("status 'completed'")
  })

  test("auto-recovers missing task for TaskGet and confirms recovery", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskGet",
        tool_input: { taskId: "42" },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Task #42 was missing")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("automatically recovered")
  })

  test("no output for TaskCreate (no taskId reference)", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskCreate",
        tool_input: { subject: "New task", description: "..." },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output for non-task tools", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
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
        tool_name: "TaskUpdate",
        tool_input: { taskId: "999" },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("auto-recovers when tasks directory does not exist", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: "nonexistent-session",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "1", status: "completed" },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Task #1 was missing")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("automatically recovered")
  })

  test("no output when taskId is empty", async () => {
    const { stdout, exitCode } = await runHook(
      HOOK,
      {
        cwd: "/tmp",
        session_id: SESSION_ID,
        tool_name: "TaskUpdate",
        tool_input: { taskId: "" },
      },
      { HOME: TMP_HOME }
    )
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })
})
