// Unit tests for the userPromptSubmit task-advisor hook.
import { describe, expect, test } from "bun:test"
import { useTempDir, writeTask } from "../src/utils/test-utils.ts"
import { evaluateUserpromptsubmitTaskAdvisor } from "./userpromptsubmit-task-advisor.ts"

describe("userpromptsubmit-task-advisor inline validation", () => {
  const tmp = useTempDir("task-advisor-test-")

  test("returns empty if agent has no task tools in payload (e.g., codex)", async () => {
    const homeDir = await tmp.create()
    const originalHome = process.env.HOME
    try {
      process.env.HOME = homeDir
      const result = await evaluateUserpromptsubmitTaskAdvisor({
        session_id: "test-session",
        _env: {
          CODEX_THREAD_ID: "via-test",
        },
      })
      expect(result).toEqual({})
    } finally {
      process.env.HOME = originalHome
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
      expect(context).toContain("Use TaskCreate to create a task for this prompt")
    } finally {
      process.env.HOME = originalHome
    }
  })
})
