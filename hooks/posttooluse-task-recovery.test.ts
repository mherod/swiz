import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionTasksDir } from "./hook-utils.ts"

const HOOK = join(import.meta.dir, "posttooluse-task-recovery.ts")

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

const TMP_HOME = join(tmpdir(), `task-recovery-test-${process.pid}`)
const SESSION_ID = "test-session-abc123"
const TASKS_DIR =
  getSessionTasksDir(SESSION_ID, TMP_HOME) ??
  (() => {
    throw new Error("Failed to resolve session tasks directory")
  })()

beforeAll(() => {
  mkdirSync(TASKS_DIR, { recursive: true })
  // Create a task file for ID "5"
  writeFileSync(
    join(TASKS_DIR, "5.json"),
    JSON.stringify({ id: "5", subject: "Existing task", status: "in_progress" })
  )
})

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true })
})

describe("posttooluse-task-recovery", () => {
  test("no output when task exists on disk", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "5", status: "completed" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("auto-recovers missing task and confirms recovery in context", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "999", status: "completed" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).not.toBe("")
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Task #999 was missing")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("automatically recovered")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("status 'completed'")
  })

  test("auto-recovers missing task for TaskGet and confirms recovery", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskGet",
      tool_input: { taskId: "42" },
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Task #42 was missing")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("automatically recovered")
  })

  test("no output for TaskCreate (no taskId reference)", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskCreate",
      tool_input: { subject: "New task", description: "..." },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output for non-task tools", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("no output when no session_id", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "999" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("auto-recovers when tasks directory does not exist", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: "nonexistent-session",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "completed" },
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Task #1 was missing")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("automatically recovered")
  })

  test("no output when taskId is empty", async () => {
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })
})
