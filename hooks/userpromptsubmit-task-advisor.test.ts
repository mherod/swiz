// Unit tests for the userPromptSubmit task-advisor hook.
import { describe, expect, test } from "bun:test"
import { acquireEnvLock, releaseEnvLockFn, useTempDir, writeTask } from "../src/utils/test-utils.ts"
import { evaluateUserpromptsubmitTaskAdvisor } from "./userpromptsubmit-task-advisor.ts"

describe("userpromptsubmit-task-advisor inline validation", () => {
  const tmp = useTempDir("task-advisor-test-")

  test("injects advisory context for codex/update_plan-style planning agents", async () => {
    const homeDir = await tmp.create()
    const originalHome = process.env.HOME
    // process.env.HOME is process-global; serialize this window with the env
    // lock so it cannot bleed into concurrent test files (issue #680).
    await acquireEnvLock()
    try {
      process.env.HOME = homeDir
      const result = await evaluateUserpromptsubmitTaskAdvisor({
        session_id: "test-session",
        _env: {
          CODEX_THREAD_ID: "via-test",
        },
      })
      expect(result).toMatchObject({
        hookSpecificOutput: {
          additionalContext: expect.stringContaining("Task"),
        },
      })
    } finally {
      process.env.HOME = originalHome
      releaseEnvLockFn()
    }
  })

  test("returns count summary and advice when task tools are present", async () => {
    const homeDir = await tmp.create()
    const sessionId = "adv-session-1"

    // Seed task queue with: 1 pending, 1 in_progress
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Do task 1",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Do task 2",
      status: "pending",
    })

    const originalHome = process.env.HOME
    // Serialize the HOME mutation with the env lock (issue #680). The writeTask
    // seeding above targets homeDir directly, so it is safe outside the lock.
    await acquireEnvLock()
    try {
      process.env.HOME = homeDir

      const result = await evaluateUserpromptsubmitTaskAdvisor({
        session_id: sessionId,
        agent_configuration: {
          tools: [{ name: "TaskCreate" }, { name: "TaskUpdate" }],
        },
      })

      const hso = (result as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput
      const context = hso?.additionalContext

      // Check that count summary and task advisor advice are both present!
      expect(context).toContain("Planning buffer thin.")
      expect(context).toContain("create a task for this prompt")
    } finally {
      process.env.HOME = originalHome
      releaseEnvLockFn()
    }
  })
})
