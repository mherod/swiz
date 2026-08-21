/**
 * The way out of an empty task queue must never be gated.
 *
 * `pretooluse-require-tasks` needs an open task before Bash/Edit/Write. That is only recoverable
 * because TaskCreate/TaskUpdate are not gated — otherwise no task means no tool call, and the
 * only tools that could create one are blocked. Until #834 that held purely by omission from a
 * matcher string, which is the kind of invariant that survives right up until someone tightens
 * the matcher.
 */

import { describe, expect, test } from "bun:test"
import {
  evaluatePretooluseRequireTasks,
  isQueueRecoveryTool,
  requireTasksHook,
} from "./pretooluse-task-governance.ts"

const RECOVERY_TOOLS = ["TaskCreate", "TaskUpdate"]
const GATED_TOOLS = ["Bash", "Edit", "Write"]

describe("isQueueRecoveryTool", () => {
  test.each(RECOVERY_TOOLS)("%s can always run", (tool) => {
    expect(isQueueRecoveryTool(tool)).toBe(true)
  })

  test.each(
    GATED_TOOLS
  )("control: %s is not a recovery tool, so the gate still applies", (tool) => {
    // Without this the assertions above would pass even if the predicate returned true for all.
    expect(isQueueRecoveryTool(tool)).toBe(false)
  })
})

describe("evaluatePretooluseRequireTasks", () => {
  /** No tasks on disk and no session: the worst case the gate can see. */
  function emptyQueuePayload(toolName: string): Record<string, any> {
    return {
      tool_name: toolName,
      tool_input: { subject: "anything" },
      session_id: `escape-hatch-${toolName}`,
      cwd: process.cwd(),
      transcript_path: "/tmp/does-not-exist-escape-hatch.jsonl",
    }
  }

  test.each(RECOVERY_TOOLS)("%s is allowed with an empty queue", async (tool) => {
    const result = await evaluatePretooluseRequireTasks(emptyQueuePayload(tool))
    const decision = (result as { hookSpecificOutput?: { permissionDecision?: string } })
      ?.hookSpecificOutput?.permissionDecision
    expect(decision).not.toBe("deny")
  })
})

describe("requireTasksHook matcher", () => {
  test("does not list the recovery tools, so they never reach the gate at all", () => {
    for (const tool of RECOVERY_TOOLS) {
      expect(requireTasksHook.matcher).not.toContain(tool)
    }
  })

  test("control: it does list the tools it is meant to gate", () => {
    for (const tool of GATED_TOOLS) {
      expect(requireTasksHook.matcher).toContain(tool)
    }
  })
})
