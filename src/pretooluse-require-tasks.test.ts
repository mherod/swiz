import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBootstrapTask } from "../hooks/pretooluse-require-tasks.ts"

const HOOK_PATH = join(import.meta.dir, "..", "hooks", "pretooluse-require-tasks.ts")

// ── Unit tests for createBootstrapTask ────────────────────────────────────────

describe("createBootstrapTask", () => {
  let tmpHome: string

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "swiz-bootstrap-test-"))
  })

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true })
  })

  test("creates task file with in_progress status", async () => {
    const sessionId = `test-session-${Date.now()}`
    const id = await createBootstrapTask(sessionId, tmpHome)
    expect(id).toBe("1")

    const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "1.json")
    const task = await Bun.file(taskPath).json()
    expect(task.id).toBe("1")
    expect(task.status).toBe("in_progress")
    expect(task.subject).toContain("bootstrap")
  })

  test("picks next ID after existing task files", async () => {
    const sessionId = `test-session-next-${Date.now()}`
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Seed existing tasks at IDs 1 and 5
    await Bun.write(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "existing",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    )
    await Bun.write(
      join(tasksDir, "5.json"),
      JSON.stringify({
        id: "5",
        subject: "existing2",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    )

    const id = await createBootstrapTask(sessionId, tmpHome)
    expect(id).toBe("6")

    const task = await Bun.file(join(tasksDir, "6.json")).json()
    expect(task.status).toBe("in_progress")
  })

  test("returns null for empty sessionId", async () => {
    const id = await createBootstrapTask("", tmpHome)
    expect(id).toBeNull()
  })

  test("returns null for empty home", async () => {
    const id = await createBootstrapTask("some-session", "")
    expect(id).toBeNull()
  })
})

// ── Integration tests for the hook subprocess ─────────────────────────────────

interface HookResult {
  stdout: string
  exitCode: number | null
  parsed: Record<string, unknown> | null
}

async function runHook(
  payload: Record<string, unknown>,
  env?: Record<string, string>
): Promise<HookResult> {
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  })
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {}
  return { stdout: stdout.trim(), exitCode: proc.exitCode, parsed }
}

describe("pretooluse-require-tasks hook", () => {
  test("allows non-blocked tools (e.g. Read)", async () => {
    const result = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      session_id: `test-allow-${Date.now()}`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("allows exempt shell commands (git status)", async () => {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
      session_id: `test-exempt-${Date.now()}`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("allows CLAUDE.md edits without tasks", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/some/project/CLAUDE.md", new_string: "test" },
      session_id: `test-memory-${Date.now()}`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("auto-creates bootstrap task when session has no tasks", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-test-"))
    const sessionId = `test-bootstrap-${Date.now()}`
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      // Hook should deny but auto-create a task
      expect(result.exitCode).toBe(0)
      expect(result.parsed).not.toBeNull()
      const reason = (result.parsed as Record<string, unknown>)?.hookSpecificOutput as
        | Record<string, unknown>
        | undefined
      expect(reason?.permissionDecision).toBe("deny")

      // Verify the bootstrap task file was created
      const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "1.json")
      const task = await Bun.file(taskPath).json()
      expect(task.status).toBe("in_progress")
      expect(task.subject).toContain("bootstrap")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  test("allows Bash when all tasks are completed (wrap-up exemption)", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-wrapup-"))
    const sessionId = `test-wrapup-${Date.now()}`
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Create a completed task
    await Bun.write(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Done task",
        description: "Already done",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    )
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      // Should be allowed — wrap-up exemption
      expect(result.exitCode).toBe(0)
      expect(result.parsed).toBeNull()
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })
})
