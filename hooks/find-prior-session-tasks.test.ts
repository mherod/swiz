import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"
import { findPriorSessionTasks } from "./hook-utils.ts"

const tempDirs: string[] = []

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-prior-tasks-"))
  tempDirs.push(dir)
  return dir
}

/** Write a task JSON file into ~/.claude/tasks/<sessionId>/<id>.json */
async function writeTask(
  homeDir: string,
  sessionId: string,
  task: { id: string; subject: string; status: string }
) {
  const dir = join(homeDir, ".claude", "tasks", sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${task.id}.json`),
    JSON.stringify({ ...task, description: "", blocks: [], blockedBy: [] }, null, 2)
  )
}

/** Write a stub transcript file into ~/.claude/projects/<projectKey>/<sessionId>.jsonl */
async function writeTranscript(homeDir: string, cwd: string, sessionId: string) {
  const projectKey = projectKeyFromCwd(cwd)
  const dir = join(homeDir, ".claude", "projects", projectKey)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), "")
}

describe("findPriorSessionTasks", () => {
  test("returns null when no project directory exists", async () => {
    const homeDir = await createTempHome()
    const result = await findPriorSessionTasks("/nonexistent/project", "current-session", homeDir)
    expect(result).toBeNull()
  })

  test("returns null when prior session has no tasks", async () => {
    const homeDir = await createTempHome()
    const cwd = "/Users/test/myproject"
    await writeTranscript(homeDir, cwd, "prior-session-1")
    // No task files written for prior-session-1
    const result = await findPriorSessionTasks(cwd, "current-session", homeDir)
    expect(result).toBeNull()
  })

  test("returns null when prior session tasks are all completed", async () => {
    const homeDir = await createTempHome()
    const cwd = "/Users/test/myproject"
    await writeTranscript(homeDir, cwd, "prior-session-1")
    await writeTask(homeDir, "prior-session-1", {
      id: "1",
      subject: "Done task",
      status: "completed",
    })
    const result = await findPriorSessionTasks(cwd, "current-session", homeDir)
    expect(result).toBeNull()
  })

  test("returns incomplete tasks with session ID from prior session", async () => {
    const homeDir = await createTempHome()
    const cwd = "/Users/test/myproject"
    await writeTranscript(homeDir, cwd, "prior-session-1")
    await writeTask(homeDir, "prior-session-1", {
      id: "1",
      subject: "Implement feature X",
      status: "in_progress",
    })
    await writeTask(homeDir, "prior-session-1", {
      id: "2",
      subject: "Write tests for X",
      status: "pending",
    })
    await writeTask(homeDir, "prior-session-1", {
      id: "3",
      subject: "Already done task",
      status: "completed",
    })

    const result = await findPriorSessionTasks(cwd, "current-session", homeDir)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe("prior-session-1")
    expect(result!.tasks).toHaveLength(2)
    expect(result!.tasks.map((t) => t.subject)).toContain("Implement feature X")
    expect(result!.tasks.map((t) => t.subject)).toContain("Write tests for X")
    expect(result!.tasks.map((t) => t.subject)).not.toContain("Already done task")
  })

  test("excludes the current session from results", async () => {
    const homeDir = await createTempHome()
    const cwd = "/Users/test/myproject"
    await writeTranscript(homeDir, cwd, "current-session")
    await writeTask(homeDir, "current-session", {
      id: "1",
      subject: "Current session task",
      status: "in_progress",
    })

    const result = await findPriorSessionTasks(cwd, "current-session", homeDir)
    expect(result).toBeNull()
  })

  test("returns tasks from most recent session with incomplete work", async () => {
    const homeDir = await createTempHome()
    const cwd = "/Users/test/myproject"

    // older session with only completed tasks
    await writeTranscript(homeDir, cwd, "old-session")
    await writeTask(homeDir, "old-session", {
      id: "1",
      subject: "Old completed task",
      status: "completed",
    })

    // small delay to ensure distinct mtimes
    await new Promise((r) => setTimeout(r, 10))

    // newer session with pending task
    await writeTranscript(homeDir, cwd, "recent-session")
    await writeTask(homeDir, "recent-session", {
      id: "1",
      subject: "Recent pending task",
      status: "pending",
    })

    const result = await findPriorSessionTasks(cwd, "current-session", homeDir)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe("recent-session")
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0]?.subject).toBe("Recent pending task")
  })

  test("handles paths with dots correctly via projectKeyFromCwd", async () => {
    const homeDir = await createTempHome()
    // Path with dots — must use projectKeyFromCwd encoding (both / and . → -)
    const cwd = "/Users/jane.doe/my.project"
    await writeTranscript(homeDir, cwd, "prior-session-1")
    await writeTask(homeDir, "prior-session-1", {
      id: "1",
      subject: "Task for dotted path",
      status: "in_progress",
    })

    const result = await findPriorSessionTasks(cwd, "current-session", homeDir)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe("prior-session-1")
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0]?.subject).toBe("Task for dotted path")
  })

  test("returns null when home is empty string", async () => {
    const result = await findPriorSessionTasks("/some/project", "current-session", "")
    expect(result).toBeNull()
  })
})
