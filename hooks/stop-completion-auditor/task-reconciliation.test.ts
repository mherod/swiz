/**
 * Unit tests for task-reconciliation.ts
 *
 * Key behavior under test:
 * - requireTaskListSync recognizes a recent TaskList call regardless of whether the
 *   transcript recorded the bare name or an MCP-namespaced one. A session whose only
 *   task tools come from an MCP server reports `mcp__swiz__TaskList`; matching the bare
 *   name alone left the gate permanently unsatisfiable there, blocking stop forever.
 */

import { describe, expect, test } from "bun:test"
import type { SessionTask } from "../../src/tasks/task-recovery.ts"
import { requireTaskListSync } from "./task-reconciliation.ts"
import type { CompletionAuditContext } from "./types.ts"

const CLAUDE_PAYLOAD = { _agent: "claude" }

const task: SessionTask = {
  id: "t-1",
  subject: "Ship the thing",
  status: "completed",
}

function makeCtx(recentObservedToolNames: string[]): CompletionAuditContext {
  return {
    cwd: "/tmp/test",
    sessionId: "test-session",
    transcript: "",
    home: "/tmp/home",
    tasksDir: "/tmp/home/.claude/tasks/test-session",
    gates: { taskCreation: true, auditLog: true, ciEvidence: true },
    allTasks: [task],
    toolCallCount: 15,
    taskToolUsed: true,
    observedToolNames: [],
    recentObservedToolNames,
    summary: null,
  }
}

describe("requireTaskListSync", () => {
  test("accepts an MCP-namespaced TaskList call", () => {
    expect(requireTaskListSync(makeCtx(["mcp__swiz__TaskList"]), CLAUDE_PAYLOAD)).toBeNull()
  })

  test("accepts a bare TaskList call", () => {
    expect(requireTaskListSync(makeCtx(["TaskList"]), CLAUDE_PAYLOAD)).toBeNull()
  })

  // Control: without this the assertions above could pass because the gate never
  // fires at all, rather than because the tool name was recognized.
  test("still blocks when no TaskList call was observed", () => {
    const result = requireTaskListSync(makeCtx(["Bash", "mcp__swiz__TaskUpdate"]), CLAUDE_PAYLOAD)
    expect(result).not.toBeNull()
    expect(result?.reason).toContain("Call TaskList before stopping")
  })

  test("skips the gate when no tasks exist", () => {
    const ctx = { ...makeCtx([]), allTasks: [] }
    expect(requireTaskListSync(ctx, CLAUDE_PAYLOAD)).toBeNull()
  })
})
