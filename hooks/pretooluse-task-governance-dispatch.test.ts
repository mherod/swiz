import { describe, expect, test } from "bun:test"
import {
  evaluateBlockedTaskFilesPrecheck,
  evaluateNativeTaskUpdatePath,
  evaluateOtherShellToolPath,
  evaluatePendingOverflowGuard,
  evaluateTaskCreatePath,
} from "./pretooluse-task-governance.ts"

function permissionDecision(result: unknown): string | undefined {
  const hso = (result as { hookSpecificOutput?: { permissionDecision?: string } } | null)
    ?.hookSpecificOutput
  return hso?.permissionDecision
}

function decisionReason(result: unknown): string | undefined {
  const hso = (result as { hookSpecificOutput?: { permissionDecisionReason?: string } } | null)
    ?.hookSpecificOutput
  return hso?.permissionDecisionReason
}

describe("evaluateBlockedTaskFilesPrecheck", () => {
  test("returns null for non-blocked tool", () => {
    expect(evaluateBlockedTaskFilesPrecheck({}, "Read", {})).toBeNull()
  })

  test("returns null for Edit on a regular file path", () => {
    const input = { tool_input: { file_path: "src/foo.ts" } }
    expect(evaluateBlockedTaskFilesPrecheck(input, "Edit", { file_path: "src/foo.ts" })).toBeNull()
  })

  test("denies Edit when the target path is inside .claude/tasks", () => {
    const filePath = "/Users/example/.claude/tasks/session-abc/task-1.json"
    const input = { tool_input: { file_path: filePath } }
    const result = evaluateBlockedTaskFilesPrecheck(input, "Edit", { file_path: filePath })
    expect(permissionDecision(result)).toBe("deny")
    expect(decisionReason(result)).toContain(".claude/tasks")
  })

  test("denies Bash commands that mutate task files", () => {
    const command = "rm -rf ~/.claude/tasks/session-abc"
    const result = evaluateBlockedTaskFilesPrecheck({}, "Bash", { command })
    expect(permissionDecision(result)).toBe("deny")
  })

  test("returns null for Bash commands that do not touch task files", () => {
    const result = evaluateBlockedTaskFilesPrecheck({}, "Bash", { command: "ls -la" })
    expect(result).toBeNull()
  })
})

describe("evaluatePendingOverflowGuard", () => {
  test("returns null when the tool is TaskList itself", async () => {
    const result = await evaluatePendingOverflowGuard({}, "TaskList")
    expect(result).toBeNull()
  })

  test("returns null when the payload has no resolvable session id", async () => {
    // Empty payload → no session_id → guard exits before any I/O
    const result = await evaluatePendingOverflowGuard({}, "Edit")
    expect(result).toBeNull()
  })
})

describe("evaluateNativeTaskUpdatePath", () => {
  test("denies TaskUpdate when toolInput has an unsupported field", async () => {
    const toolInput = { taskId: "1", status: "completed", foo: "bar" }
    const input = { tool_name: "TaskUpdate", tool_input: toolInput }
    const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
    const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
    expect(permissionDecision(result)).toBe("deny")
    expect(decisionReason(result)).toContain("foo")
  })

  test("denies TaskUpdate listing every unsupported field", async () => {
    const toolInput = { taskId: "1", foo: "x", bar: "y" }
    const input = { tool_name: "TaskUpdate", tool_input: toolInput }
    const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
    const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
    const reason = decisionReason(result) ?? ""
    expect(reason).toContain("foo")
    expect(reason).toContain("bar")
  })
})

describe("evaluateTaskCreatePath", () => {
  test("denies an obviously compound subject when no session task buffer exists", async () => {
    // Use a session id that maps to no on-disk tasks so the duplicate check is a no-op
    // and the compound detector is the only decision-maker.
    const sessionId = `pgrep-dispatch-test-${Date.now()}`
    const input = { tool_name: "TaskCreate", session_id: sessionId }
    const result = await evaluateTaskCreatePath(input, {
      subject: "add user login and fix typo in header",
    })
    expect(permissionDecision(result)).toBe("deny")
  })

  test("allows a simple, focused subject", async () => {
    const sessionId = `pgrep-dispatch-test-allow-${Date.now()}`
    const input = { tool_name: "TaskCreate", session_id: sessionId }
    const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
    expect(permissionDecision(result)).toBe("allow")
  })
})

describe("evaluateOtherShellToolPath", () => {
  test("returns {} for a non-shell tool", async () => {
    const input = { tool_name: "Read" }
    const parsed = input as unknown as Parameters<typeof evaluateOtherShellToolPath>[1]
    const result = await evaluateOtherShellToolPath(input, parsed)
    expect(result).toEqual({})
  })
})
