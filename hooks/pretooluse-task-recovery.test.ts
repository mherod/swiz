import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOOK = join(import.meta.dir, "pretooluse-task-recovery.ts")

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

const TMP_HOME = join(tmpdir(), `pretooluse-task-recovery-test-${process.pid}`)
const SESSION_ID = "test-session-pre-abc123"
const TASKS_DIR = join(TMP_HOME, ".claude", "tasks", SESSION_ID)

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

describe("pretooluse-task-recovery", () => {
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

  test("creates stub file for missing task — silent (no stdout)", async () => {
    const stubPath = join(TASKS_DIR, "777.json")
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "777", status: "completed" },
    })
    expect(exitCode).toBe(0)
    // No output — recovery is transparent
    expect(stdout).toBe("")
    // File was written to disk
    expect(existsSync(stubPath)).toBe(true)
  })

  test("stub file has correct structure with in_progress status", async () => {
    const stubPath = join(TASKS_DIR, "888.json")
    await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "888", status: "completed" },
    })
    const stub = JSON.parse(readFileSync(stubPath, "utf8"))
    expect(stub.id).toBe("888")
    expect(stub.status).toBe("in_progress")
    expect(stub.subject).toContain("#888")
    expect(stub.subject).toContain("compaction")
    expect(stub.blocks).toEqual([])
    expect(stub.blockedBy).toEqual([])
  })

  test("creates stub for TaskGet on missing task — silent", async () => {
    const stubPath = join(TASKS_DIR, "42.json")
    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: SESSION_ID,
      tool_name: "TaskGet",
      tool_input: { taskId: "42" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(existsSync(stubPath)).toBe(true)
  })

  test("no output and no file for TaskCreate (no taskId reference)", async () => {
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

  test("creates directory and stub when tasks dir does not exist", async () => {
    const newSessionId = "pretooluse-new-session-xyz"
    const newTasksDir = join(TMP_HOME, ".claude", "tasks", newSessionId)
    const stubPath = join(newTasksDir, "1.json")

    const { stdout, exitCode } = await runHook({
      cwd: "/tmp",
      session_id: newSessionId,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "completed" },
    })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(existsSync(stubPath)).toBe(true)
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
