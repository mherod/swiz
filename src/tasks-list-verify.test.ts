import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = process.env.HOME ?? ""
const TASKS_LIST = join(HOME, ".claude", "hooks", "tasks-list.ts")

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

async function runTasksList(args: string[], env?: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", TASKS_LIST, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: proc.exitCode }
}

describe("tasks-list.ts --complete with placeholder subjects", () => {
  let tmpHome: string
  const sessionId = `test-placeholder-${Date.now()}`

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "swiz-tasklist-verify-"))
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    await mkdir(tasksDir, { recursive: true })

    // Create a recovered task (compaction placeholder)
    await Bun.write(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Recovered task #1 (lost during compaction)",
        description: "Auto-recovered stub",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      })
    )

    // Create a normal task for comparison
    await Bun.write(
      join(tasksDir, "2.json"),
      JSON.stringify({
        id: "2",
        subject: "Push and verify CI",
        description: "Normal task with real subject",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      })
    )

    // Create a bootstrap placeholder task
    await Bun.write(
      join(tasksDir, "3.json"),
      JSON.stringify({
        id: "3",
        subject: "Session bootstrap — describe current work",
        description: "Auto-created by pretooluse-require-tasks",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      })
    )
  })

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true })
  })

  test("completes a recovered task with mismatched verification text", async () => {
    // The caller provides verification based on original subject ("Push and verify")
    // but the actual subject is "Recovered task #1 (lost during compaction)"
    const result = await runTasksList(
      [
        "--all-projects",
        "--session",
        sessionId,
        "--complete",
        "1",
        "Push and verify",
        "--evidence",
        "CI green",
      ],
      { HOME: tmpHome }
    )
    expect(result.exitCode).toBe(0)

    // Verify the task was actually marked completed
    const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "1.json")
    const task = await Bun.file(taskPath).json()
    expect(task.status).toBe("completed")
  })

  test("still rejects mismatched verification for normal tasks", async () => {
    const result = await runTasksList(
      [
        "--all-projects",
        "--session",
        sessionId,
        "--complete",
        "2",
        "Wrong prefix",
        "--evidence",
        "some evidence",
      ],
      { HOME: tmpHome }
    )
    // Verification fails — stderr contains error, task status unchanged
    expect(result.stderr).toContain("Verification Error")

    // Verify the task was NOT marked completed
    const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "2.json")
    const task = await Bun.file(taskPath).json()
    expect(task.status).toBe("in_progress")
  })

  test("completes a normal task with correct verification prefix", async () => {
    const result = await runTasksList(
      [
        "--all-projects",
        "--session",
        sessionId,
        "--complete",
        "2",
        "Push and verify",
        "--evidence",
        "CI green",
      ],
      { HOME: tmpHome }
    )
    expect(result.exitCode).toBe(0)

    const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "2.json")
    const task = await Bun.file(taskPath).json()
    expect(task.status).toBe("completed")
  })

  test("completes a bootstrap placeholder with mismatched verification text", async () => {
    const result = await runTasksList(
      [
        "--all-projects",
        "--session",
        sessionId,
        "--complete",
        "3",
        "Investigate codebase",
        "--evidence",
        "Investigation complete",
      ],
      { HOME: tmpHome }
    )
    expect(result.exitCode).toBe(0)

    const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "3.json")
    const task = await Bun.file(taskPath).json()
    expect(task.status).toBe("completed")
  })
})
