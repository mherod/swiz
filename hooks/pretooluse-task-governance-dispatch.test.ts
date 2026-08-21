import { afterAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StopHookInput } from "../src/schemas.ts"
import { syncCodexUpdatePlanSnapshot } from "../src/tasks/codex-update-plan.ts"
import { type Task, writeTask as writeRepositoryTask } from "../src/tasks/task-repository.ts"
import { buildEffectiveTestSettings, writeTask } from "../src/utils/test-utils.ts"
import pretooluseTaskGovernance, {
  evaluateBlockedTaskFilesPrecheck,
  evaluateNativeTaskUpdatePath,
  evaluateOtherShellToolPath,
  evaluatePendingOverflowGuard,
  evaluateTaskCreatePath,
  getInProgressCap,
  MAX_COMPLETIONS_IN_WINDOW,
} from "./pretooluse-task-governance.ts"
import { evaluateStopIncompleteTasks } from "./stop-incomplete-tasks/evaluate.ts"

const TASK_HOME = join(
  tmpdir(),
  `swiz-task-governance-dispatch-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
)
const CODEX_TASKS_DIR = join(TASK_HOME, ".codex", "tasks")

afterAll(async () => {
  await rm(TASK_HOME, { recursive: true, force: true })
})

async function seedInProgressTasks(sessionId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await writeTask(TASK_HOME, sessionId, {
      id: String(i),
      subject: `Task ${i}`,
      status: "in_progress",
    })
  }
}

async function seedPendingTask(sessionId: string, id: string): Promise<void> {
  await writeTask(TASK_HOME, sessionId, { id, subject: "Pending task", status: "pending" })
}

async function seedPendingTasks(sessionId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await writeTask(TASK_HOME, sessionId, {
      id: String(i),
      subject: `Pending task ${i}`,
      status: "pending",
    })
  }
}

async function cleanupSession(sessionId: string): Promise<void> {
  await rm(join(TASK_HOME, ".claude", "tasks", sessionId), { recursive: true, force: true })
  await rm(join(CODEX_TASKS_DIR, sessionId), { recursive: true, force: true })
}

function codexTask(task: { id: string; subject: string; status: Task["status"] }): Task {
  return {
    id: task.id,
    subject: task.subject,
    description: "",
    status: task.status,
    blocks: [],
    blockedBy: [],
  }
}

async function seedCodexTask(
  sessionId: string,
  task: { id: string; subject: string; status: Task["status"] }
): Promise<void> {
  await writeRepositoryTask(sessionId, codexTask(task), process.cwd(), CODEX_TASKS_DIR)
}

function updatePlanInput(
  sessionId: string,
  plan: Array<{ step: string; status: string }>,
  extraToolInput: Record<string, unknown> = {}
) {
  const toolInput = { ...extraToolInput, plan }
  return {
    session_id: sessionId,
    tool_name: "update_plan",
    tool_input: toolInput,
    _taskHome: TASK_HOME,
    _env: { CODEX_THREAD_ID: "test-codex-thread" },
    _effectiveSettings: buildEffectiveTestSettings({
      auditStrictness: "strict",
      autoContinue: true,
    }),
  }
}

function uniqueSessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

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

function additionalContext(result: unknown): string | undefined {
  const hso = (result as { hookSpecificOutput?: { additionalContext?: string } } | null)
    ?.hookSpecificOutput
  return hso?.additionalContext
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

  test("denies update_plan when toolInput has an unsupported field", async () => {
    const sessionId = uniqueSessionId("update-plan-unsupported")
    try {
      await cleanupSession(sessionId)
      const input = updatePlanInput(sessionId, [], { taskId: "1" })
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("taskId")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when the projected final plan drops the pending buffer", async () => {
    const sessionId = uniqueSessionId("update-plan-buffer")
    try {
      await cleanupSession(sessionId)
      await seedCodexTask(sessionId, {
        id: "codex-1",
        subject: "Implement projection",
        status: "in_progress",
      })
      await seedCodexTask(sessionId, {
        id: "codex-2",
        subject: "Verify projection",
        status: "pending",
      })

      const input = updatePlanInput(sessionId, [
        { step: "Implement projection", status: "in_progress" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("at least 1 pending")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when a pending plan item jumps directly to completed", async () => {
    const sessionId = uniqueSessionId("update-plan-pending-complete")
    try {
      await cleanupSession(sessionId)
      await seedCodexTask(sessionId, {
        id: "codex-1",
        subject: "Write regression",
        status: "pending",
      })
      await seedCodexTask(sessionId, {
        id: "codex-2",
        subject: "Run regression",
        status: "pending",
      })
      await seedCodexTask(sessionId, {
        id: "codex-3",
        subject: "Implement fix",
        status: "in_progress",
      })

      const input = updatePlanInput(sessionId, [
        { step: "Write regression", status: "completed" },
        { step: "Run regression", status: "pending" },
        { step: "Implement fix", status: "in_progress" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("still pending")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when projected completion leaves no active task", async () => {
    const sessionId = uniqueSessionId("update-plan-no-active-completion")
    try {
      await cleanupSession(sessionId)
      await seedCodexTask(sessionId, {
        id: "codex-1",
        subject: "Implement projection",
        status: "in_progress",
      })
      await seedCodexTask(sessionId, {
        id: "codex-2",
        subject: "Verify projection",
        status: "pending",
      })
      await seedCodexTask(sessionId, {
        id: "codex-3",
        subject: "Commit projection",
        status: "pending",
      })

      const input = updatePlanInput(sessionId, [
        { step: "Implement projection", status: "completed" },
        { step: "Verify projection", status: "pending" },
        { step: "Commit projection", status: "pending" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("in_progress")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("allows update_plan when projected completion preserves active and pending tasks", async () => {
    const sessionId = uniqueSessionId("update-plan-valid-completion")
    try {
      await cleanupSession(sessionId)
      await seedCodexTask(sessionId, {
        id: "codex-1",
        subject: "Implement projection",
        status: "in_progress",
      })
      await seedCodexTask(sessionId, {
        id: "codex-2",
        subject: "Verify projection",
        status: "pending",
      })
      await seedCodexTask(sessionId, {
        id: "codex-3",
        subject: "Commit projection",
        status: "pending",
      })
      await seedCodexTask(sessionId, {
        id: "codex-4",
        subject: "Ship projection",
        status: "pending",
      })

      const input = updatePlanInput(sessionId, [
        { step: "Implement projection", status: "completed" },
        { step: "Verify projection", status: "in_progress" },
        { step: "Commit projection", status: "pending" },
        { step: "Ship projection", status: "pending" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("allows all-terminal update_plan then keeps repeated Codex Stop evaluations unblocked", async () => {
    const sessionId = uniqueSessionId("update-plan-terminal-stop")
    const terminalPlan: Array<{ step: string; status: Task["status"] }> = [
      { step: "Implement closeout", status: "completed" },
      { step: "Verify closeout", status: "completed" },
      { step: "Document closeout", status: "completed" },
    ]
    try {
      await cleanupSession(sessionId)
      for (let index = 0; index < terminalPlan.length; index++) {
        await seedCodexTask(sessionId, {
          id: `codex-${index + 1}`,
          subject: terminalPlan[index]?.step ?? "",
          status: "in_progress",
        })
      }

      const input = updatePlanInput(sessionId, terminalPlan)
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const preToolUseResult = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(preToolUseResult)).not.toBe("deny")

      await syncCodexUpdatePlanSnapshot(
        sessionId,
        { plan: terminalPlan },
        { cwd: process.cwd(), tasksDir: CODEX_TASKS_DIR }
      )

      const stopInput = {
        session_id: sessionId,
        _env: { CODEX_THREAD_ID: "test-codex-thread" },
      } as unknown as StopHookInput
      const firstStop = await evaluateStopIncompleteTasks(stopInput, { homeDir: TASK_HOME })
      const repeatedStop = await evaluateStopIncompleteTasks(stopInput, { homeDir: TASK_HOME })

      expect(firstStop).toEqual({})
      expect(repeatedStop).toEqual({})
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when a replacement plan has only pending tasks", async () => {
    const sessionId = uniqueSessionId("update-plan-only-pending")
    try {
      await cleanupSession(sessionId)

      const input = updatePlanInput(sessionId, [
        { step: "Implement projection", status: "pending" },
        { step: "Verify projection", status: "pending" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("in_progress")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when the projected final plan exceeds the in-progress cap", async () => {
    const sessionId = uniqueSessionId("update-plan-cap")
    try {
      await cleanupSession(sessionId)
      for (let i = 1; i <= getInProgressCap(); i++) {
        await seedCodexTask(sessionId, {
          id: `codex-${i}`,
          subject: `Active task ${i}`,
          status: "in_progress",
        })
      }
      await seedCodexTask(sessionId, {
        id: `codex-${getInProgressCap() + 1}`,
        subject: "Pending overflow",
        status: "pending",
      })

      const input = updatePlanInput(sessionId, [
        ...Array.from({ length: getInProgressCap() }, (_, index) => ({
          step: `Active task ${index + 1}`,
          status: "in_progress",
        })),
        { step: "Pending overflow", status: "in_progress" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain(String(getInProgressCap()))
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when the projected final plan has duplicate active subjects", async () => {
    const sessionId = uniqueSessionId("update-plan-duplicates")
    try {
      await cleanupSession(sessionId)
      const input = updatePlanInput(sessionId, [
        { step: "Implement projection", status: "in_progress" },
        { step: "Implement projection", status: "pending" },
        { step: "Verify projection", status: "pending" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("Duplicate task subjects")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies TaskUpdate when updating to a deferral subject", async () => {
    const sessionId = uniqueSessionId("task-update-deferral")
    try {
      await cleanupSession(sessionId)
      const toolInput = { taskId: "1", subject: "Future: add feature" }
      const input = {
        session_id: sessionId,
        tool_name: "TaskUpdate",
        tool_input: toolInput,
        _taskHome: TASK_HOME,
      }
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("Deferral tactic detected")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies update_plan when proposing a plan with a deferral step", async () => {
    const sessionId = uniqueSessionId("update-plan-deferral")
    try {
      await cleanupSession(sessionId)
      const input = updatePlanInput(sessionId, [
        { step: "Future: do later", status: "pending" },
        { step: "implement now", status: "in_progress" },
      ])
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, input.tool_input, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("Deferral tactic detected")
    } finally {
      await cleanupSession(sessionId)
    }
  })
})

describe("Codex task-store integration", () => {
  test("emits no task-governance output for Codex Bash after update_plan", async () => {
    const sessionId = uniqueSessionId("codex-plan-bash")
    try {
      await cleanupSession(sessionId)
      await syncCodexUpdatePlanSnapshot(
        sessionId,
        {
          plan: [
            { step: "Implement provider-aware task reads", status: "in_progress" },
            { step: "Verify provider-aware task reads", status: "pending" },
          ],
        },
        { cwd: process.cwd(), tasksDir: CODEX_TASKS_DIR }
      )

      const result = await pretooluseTaskGovernance.run({
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
        transcript_path: "",
        cwd: process.cwd(),
        _taskHome: TASK_HOME,
        _env: { CODEX_THREAD_ID: "test-codex-thread" },
        _effectiveSettings: buildEffectiveTestSettings({
          auditStrictness: "strict",
          autoContinue: true,
        }),
      })

      expect(result).toEqual({})
    } finally {
      await cleanupSession(sessionId)
    }
  })
})

describe("evaluateTaskCreatePath", () => {
  test("denies an obviously compound subject when no session task buffer exists", async () => {
    // Use a session id that maps to no on-disk tasks so the duplicate check is a no-op
    // and the compound detector is the only decision-maker.
    const sessionId = uniqueSessionId("pgrep-dispatch-test")
    try {
      await cleanupSession(sessionId)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, {
        subject: "add user login and fix typo in header",
      })
      expect(permissionDecision(result)).toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("allows a simple, focused subject", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-allow")
    try {
      await cleanupSession(sessionId)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
      expect(permissionDecision(result)).toBe("allow")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("allows a compound subject when pending task buffer is healthy", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-buffer")
    try {
      await cleanupSession(sessionId)
      await seedPendingTasks(sessionId, 2)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, {
        subject: "add user login and fix typo in header",
      })
      expect(permissionDecision(result)).toBe("allow")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies a compound subject when only an in-progress task exists", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-inprogress")
    try {
      await cleanupSession(sessionId)
      await seedInProgressTasks(sessionId, 1)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, {
        subject: "add user login and fix typo in header",
      })
      expect(permissionDecision(result)).toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies a work deferral subject", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-deferral")
    try {
      await cleanupSession(sessionId)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, { subject: "Future: implement auth" })
      expect(permissionDecision(result)).toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("allows a consider-phrased same-session subject", async () => {
    // Bare "Consider …" subjects are exactly what the planning-buffer nag asks
    // for as broader follow-on tasks; only explicit session-boundary deferrals
    // (issue refs, "Future:", "next session", …) are denied.
    const sessionId = uniqueSessionId("pgrep-dispatch-test-carryover")
    try {
      await cleanupSession(sessionId)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, { subject: "Consider extracting helpers" })
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("denies a consider subject that defers to an issue", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-issue-deferral")
    try {
      await cleanupSession(sessionId)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, {
        subject: "Consider issue #633: reduce governance complexity",
      })
      expect(permissionDecision(result)).toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
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

describe("pretooluseTaskGovernance context", () => {
  test("adds firm context for existing deferral-task subjects without exposing the trigger", async () => {
    const sessionId = uniqueSessionId("deferral-context")
    try {
      await cleanupSession(sessionId)
      await writeTask(TASK_HOME, sessionId, {
        id: "1",
        subject: "Consider issue #633: reduce governance complexity",
        status: "pending",
      })
      await writeTask(TASK_HOME, sessionId, {
        id: "2",
        subject: "Implement task subject governance context",
        status: "in_progress",
      })

      const result = await pretooluseTaskGovernance.run({
        tool_name: "Read",
        tool_input: {},
        session_id: sessionId,
        cwd: process.cwd(),
        _taskHome: TASK_HOME,
      })

      const context = additionalContext(result) ?? ""
      expect(permissionDecision(result)).toBe("allow")
      expect(context).toContain("Deferral tactic detected")
      expect(context).toContain("All work is to be completed in this session")
      expect(context).toContain("There is no follow-up session")
      expect(context.toLowerCase()).not.toContain("consider issue")
      expect(context).not.toContain("#633")
    } finally {
      await cleanupSession(sessionId)
    }
  })
})

describe("checkInProgressTransitionCap boundary (via evaluateNativeTaskUpdatePath)", () => {
  const CAP = getInProgressCap()

  test("allows transition when 0 tasks are in_progress", async () => {
    const sessionId = uniqueSessionId("cap-boundary-0")
    try {
      await cleanupSession(sessionId)
      await seedPendingTask(sessionId, "1")
      const toolInput = { taskId: "1", status: "in_progress" }
      const input = {
        session_id: sessionId,
        tool_name: "TaskUpdate",
        tool_input: toolInput,
        _taskHome: TASK_HOME,
      }
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test(`allows transition when ${CAP - 1} tasks are in_progress (cap - 1)`, async () => {
    const sessionId = uniqueSessionId(`cap-boundary-${CAP - 1}`)
    try {
      await cleanupSession(sessionId)
      await seedInProgressTasks(sessionId, CAP - 1)
      const pendingId = String(CAP)
      await seedPendingTask(sessionId, pendingId)
      const toolInput = { taskId: pendingId, status: "in_progress" }
      const input = {
        session_id: sessionId,
        tool_name: "TaskUpdate",
        tool_input: toolInput,
        _taskHome: TASK_HOME,
      }
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test(`denies transition when ${CAP} tasks are already in_progress (at cap)`, async () => {
    const sessionId = uniqueSessionId(`cap-boundary-${CAP}`)
    try {
      await cleanupSession(sessionId)
      await seedInProgressTasks(sessionId, CAP)
      const pendingId = String(CAP + 1)
      await seedPendingTask(sessionId, pendingId)
      const toolInput = { taskId: pendingId, status: "in_progress" }
      const input = {
        session_id: sessionId,
        tool_name: "TaskUpdate",
        tool_input: toolInput,
        _taskHome: TASK_HOME,
      }
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain(String(CAP))
    } finally {
      await cleanupSession(sessionId)
    }
  })

  // Stand-downs: the cap counts in-progress tasks, but two transitions at the cap must still pass
  // because they do not add one. The "at cap" denial above is the control for both.
  test(`stands down at cap when the task is already in_progress (no-op)`, async () => {
    const sessionId = uniqueSessionId(`cap-standdown-noop`)
    try {
      await cleanupSession(sessionId)
      await seedInProgressTasks(sessionId, CAP)
      const toolInput = { taskId: "1", status: "in_progress" }
      const input = {
        session_id: sessionId,
        tool_name: "TaskUpdate",
        tool_input: toolInput,
        _taskHome: TASK_HOME,
      }
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test(`stands down at cap when the task id is not on disk`, async () => {
    const sessionId = uniqueSessionId(`cap-standdown-unknown`)
    try {
      await cleanupSession(sessionId)
      await seedInProgressTasks(sessionId, CAP)
      const toolInput = { taskId: "no-such-task", status: "in_progress" }
      const input = {
        session_id: sessionId,
        tool_name: "TaskUpdate",
        tool_input: toolInput,
        _taskHome: TASK_HOME,
      }
      const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
      const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })
})

/**
 * The completion rate limit reads its task counts from disk, so a payload-only harness cannot
 * reach it: the planning-buffer bypass depends on how many pending and in-progress tasks the
 * session actually has. These drive the native TaskUpdate path against seeded task files.
 *
 * `completionTimestamps` is module state keyed by session id, so each test's unique session id
 * gives it a clean window without resetting anything global.
 */
describe("checkCompletionRateLimit on disk-backed state (via evaluateNativeTaskUpdatePath)", () => {
  const BURST = MAX_COMPLETIONS_IN_WINDOW + 1
  /** Distinguishes a rate-limit denial from the completion-threshold denial that shares the path. */
  const RATE_LIMIT_MARKER = "in the last 5s"

  /**
   * Pending filler with distinct subjects and ids that cannot collide with the in-progress
   * seeds. `seedPendingTask` writes one fixed subject, so seeding several of those trips the
   * duplicate-subject gate long before the rate limiter is reached.
   */
  async function seedDistinctPendingTasks(sessionId: string, count: number): Promise<void> {
    for (let i = 1; i <= count; i++) {
      await writeTask(TASK_HOME, sessionId, {
        id: `pending-${i}`,
        subject: `Queued follow-on ${i}`,
        status: "pending",
      })
    }
  }

  async function completeTask(
    sessionId: string,
    taskId: string
  ): Promise<{ decision?: string; reason?: string }> {
    const toolInput = { taskId, status: "completed" }
    const input = {
      session_id: sessionId,
      tool_name: "TaskUpdate",
      tool_input: toolInput,
      _taskHome: TASK_HOME,
    }
    const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
    const result = await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
    return { decision: permissionDecision(result), reason: decisionReason(result) }
  }

  test(`denies completion ${BURST} of a rapid burst when the planning buffer is thin`, async () => {
    const sessionId = uniqueSessionId("rate-limit-thin-buffer")
    try {
      await cleanupSession(sessionId)
      // One pending task only: below the pending >= 2 the bypass requires.
      await seedInProgressTasks(sessionId, BURST + 1)
      await seedDistinctPendingTasks(sessionId, 1)

      const outcomes = []
      for (let i = 1; i <= BURST; i++) outcomes.push(await completeTask(sessionId, String(i)))

      // The completions up to the limit pass; each one is recorded in the window, and only the
      // one that exceeds it is refused.
      for (const outcome of outcomes.slice(0, BURST - 1)) {
        expect(outcome.decision).not.toBe("deny")
      }
      const last = outcomes[BURST - 1]!
      expect(last.decision).toBe("deny")
      expect(last.reason).toContain(RATE_LIMIT_MARKER)
      expect(last.reason).toContain(String(MAX_COMPLETIONS_IN_WINDOW))
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test(`stands down for the same ${BURST}-completion burst when the planning buffer is healthy`, async () => {
    const sessionId = uniqueSessionId("rate-limit-healthy-buffer")
    try {
      await cleanupSession(sessionId)
      // Enough in-progress work to keep one running through the burst, and pending >= 2 throughout,
      // which is exactly the bypass condition the thin-buffer test above lacks.
      await seedInProgressTasks(sessionId, BURST + 1)
      await seedDistinctPendingTasks(sessionId, 3)

      for (let i = 1; i <= BURST; i++) {
        const outcome = await completeTask(sessionId, String(i))
        expect(outcome.reason ?? "").not.toContain(RATE_LIMIT_MARKER)
        expect(outcome.decision).not.toBe("deny")
      }
    } finally {
      await cleanupSession(sessionId)
    }
  })
})
