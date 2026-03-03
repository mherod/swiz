import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const HOOK_PATH = resolve(process.cwd(), "hooks/posttooluse-task-evidence.ts")
const SESSION_ID = "test-evidence-session-abc123"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function createFixture(): Promise<{ home: string; tasksDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "swiz-evidence-test-"))
  tempDirs.push(home)
  const tasksDir = join(home, ".claude", "tasks", SESSION_ID)
  await mkdir(tasksDir, { recursive: true })
  return { home, tasksDir }
}

async function runHook(
  home: string,
  toolInput: Record<string, unknown>,
  toolName = "TaskUpdate"
): Promise<string> {
  const payload = JSON.stringify({
    cwd: process.cwd(),
    session_id: SESSION_ID,
    tool_name: toolName,
    tool_input: toolInput,
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDECODE
  delete env.CURSOR_TRACE_ID
  delete env.GEMINI_CLI
  delete env.GEMINI_PROJECT_DIR
  delete env.CODEX_MANAGED_BY_NPM
  delete env.CODEX_THREAD_ID

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited
  return raw.trim()
}

describe("posttooluse-task-evidence", () => {
  it("writes completionEvidence when metadata.evidence is provided", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "1",
      subject: "Push and verify CI",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "1.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "1",
      status: "completed",
      metadata: { evidence: "CI green — conclusion: success" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "1.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green — conclusion: success")
    expect(updated.completionTimestamp).toBeDefined()
  })

  it("does nothing when metadata.evidence is absent", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "2",
      subject: "Some task",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "2.json"), JSON.stringify(task, null, 2))

    await runHook(home, { taskId: "2", status: "completed" })

    const updated = JSON.parse(await readFile(join(tasksDir, "2.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })

  it("does nothing when metadata.evidence is empty string", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "3",
      subject: "Another task",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "3.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "3",
      status: "completed",
      metadata: { evidence: "" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "3.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })

  it("preserves existing task fields when writing evidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "4",
      subject: "CI verification task",
      description: "Verify CI passes",
      activeForm: "Verifying CI",
      status: "completed",
      blocks: ["5"],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "4.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "4",
      status: "completed",
      metadata: { evidence: "CI passed" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "4.json"), "utf-8"))
    expect(updated.subject).toBe("CI verification task")
    expect(updated.description).toBe("Verify CI passes")
    expect(updated.activeForm).toBe("Verifying CI")
    expect(updated.blocks).toEqual(["5"])
    expect(updated.completionEvidence).toBe("CI passed")
  })

  it("handles missing task file gracefully", async () => {
    const { home } = await createFixture()
    // No task file written — hook should not crash
    const output = await runHook(home, {
      taskId: "99",
      status: "completed",
      metadata: { evidence: "CI green" },
    })
    // Should exit cleanly with no output
    expect(output).toBe("")
  })

  it("extracts evidence from metadata.completionEvidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "5", subject: "Alt key", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "5.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "5",
      status: "completed",
      metadata: { completionEvidence: "CI green — all jobs passed" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "5.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green — all jobs passed")
    expect(updated.completionTimestamp).toBeDefined()
  })

  it("works with update_plan tool name (Codex)", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "6", subject: "Codex task", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "6.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "6", status: "completed", metadata: { evidence: "CI passed" } },
      "update_plan"
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "6.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI passed")
  })

  it("is idempotent — does not overwrite identical evidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "7",
      subject: "Idempotent test",
      status: "completed",
      blocks: [],
      blockedBy: [],
      completionEvidence: "CI green",
      completionTimestamp: "2026-01-01T00:00:00.000Z",
    }
    await writeFile(join(tasksDir, "7.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "7",
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "7.json"), "utf-8"))
    // Timestamp should be unchanged since evidence was identical
    expect(updated.completionTimestamp).toBe("2026-01-01T00:00:00.000Z")
  })

  it("handles numeric taskId", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "8", subject: "Numeric ID", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "8.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: 8,
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "8.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("ignores non-update task tools", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "9", subject: "Ignore me", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "9.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "9", status: "completed", metadata: { evidence: "CI green" } },
      "TaskCreate"
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "9.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })
})
