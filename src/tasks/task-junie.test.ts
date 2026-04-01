import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readTasks } from "./task-repository.ts"

describe("Junie tasks", () => {
  const tempDir = join(process.cwd(), ".tmp-junie-tasks-test")

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {}
  })

  test("readTasks parses tasks from AgentPlanUpdatedEvent in events.jsonl", async () => {
    const sessionId = "session-123"
    const sessionDir = join(tempDir, sessionId)
    await mkdir(sessionDir, { recursive: true })

    const events = [
      {
        kind: "SessionA2uxEvent",
        event: {
          agentEvent: {
            kind: "AgentPlanUpdatedEvent",
            items: [
              { status: "IN_PROGRESS", description: "Task 1" },
              { status: "PENDING", description: "Task 2" },
              { status: "COMPLETED", description: "Task 3" },
            ],
          },
        },
      },
    ]

    await writeFile(
      join(sessionDir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n")
    )

    const tasks = await readTasks(sessionId, tempDir)
    expect(tasks).toHaveLength(3)
    expect(tasks[0]).toMatchObject({ id: "1", subject: "Task 1", status: "in_progress" })
    expect(tasks[1]).toMatchObject({ id: "2", subject: "Task 2", status: "pending" })
    expect(tasks[2]).toMatchObject({ id: "3", subject: "Task 3", status: "completed" })
  })

  /*
  test("getSessions discovers Junie sessions by scanning events.jsonl for cwd", async () => {
    const sessionId = "session-junie-cwd"
    const sessionDir = join(tempDir, "sessions", sessionId)
    await mkdir(sessionDir, { recursive: true })

    const filterCwd = "/path/to/project"
    const events = [
      {
        kind: "SessionA2uxEvent",
        event: {
          agentEvent: {
            kind: "AgentStateUpdatedEvent",
            blob: JSON.stringify({ currentDirectory: filterCwd }),
          },
        },
      },
    ]

    await writeFile(
      join(sessionDir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n")
    )

    // Mock createDefaultTaskStore to use tempDir as projectsDir/tasksDir
    const sessions = await getSessions(
      filterCwd,
      join(tempDir, "sessions/"),
      join(tempDir, "sessions/")
    )

    expect(sessions).toContain(sessionId)
  })
  */
})
