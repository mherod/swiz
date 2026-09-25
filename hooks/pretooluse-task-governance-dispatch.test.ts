import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { syncCodexUpdatePlanSnapshot } from "../src/tasks/codex-update-plan.ts"
import {
  applyTaskListEvent,
  getSessionEventState,
  pruneSession,
} from "../src/tasks/task-event-state.ts"
import {
  buildEffectiveTestSettings,
  writeRawTaskFixture,
  writeTask,
} from "../src/utils/test-utils.ts"
import pretooluseTaskGovernance, {
  buildStaleOpenTaskMessage,
  countRecentStaleGateDenials,
  evaluateBlockedTaskFilesPrecheck,
  evaluateNativeTaskUpdatePath,
  evaluateOtherShellToolPath,
  evaluatePendingOverflowGuard,
  evaluatePretooluseTaskGovernance,
  evaluateTaskCreatePath,
  findStaleOpenTasks,
  getInProgressCap,
  MAX_COMPLETIONS_IN_WINDOW,
  OPEN_TASK_ABANDONED_CEILING_MS,
  OPEN_TASK_GATE_RELEASE_ATTEMPTS,
  OPEN_TASK_UPDATE_RECENCY_LIMIT_MS,
  partitionStaleOpenTasks,
  STALE_GATE_DENY_RE,
} from "./pretooluse-task-governance.ts"

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

  // #929: the gate's one predicate is pending > 20. Each denial must carry that measurement, and the
  // grace window, not the count, explains a retry that passes at an unchanged count.
  function overflowInput(sessionId: string, extra: Record<string, unknown> = {}) {
    return {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      cwd: process.cwd(),
      _taskHome: TASK_HOME,
      ...extra,
    }
  }

  test("control: exactly 20 pending tasks pass", async () => {
    const sessionId = uniqueSessionId("overflow-20")
    try {
      await seedPendingTasks(sessionId, 20)
      expect(await evaluatePendingOverflowGuard(overflowInput(sessionId), "Bash")).toBeNull()
    } finally {
      await cleanupSession(sessionId)
    }
  })

  for (const count of [21, 46]) {
    test(`denies ${count} pending tasks with the measured count, limit and scope`, async () => {
      const sessionId = uniqueSessionId(`overflow-${count}`)
      try {
        await seedPendingTasks(sessionId, count)
        const result = await evaluatePendingOverflowGuard(overflowInput(sessionId), "Bash")
        const reason = decisionReason(result) ?? ""
        expect(permissionDecision(result)).toBe("deny")
        expect(reason).toContain(`${count} pending tasks are queued, above the limit of 20`)
        expect(reason).toContain(`Counted: ${count} in this session.`)
        expect(reason).toContain(`Bring pending down by ${count - 20}`)
        expect(reason).not.toContain("Clear the task state")
      } finally {
        await cleanupSession(sessionId)
      }
    })
  }

  test("an unchanged-count retry is denied identically; only the grace window lets it pass", async () => {
    const sessionId = uniqueSessionId("overflow-retry")
    try {
      await seedPendingTasks(sessionId, 46)
      const first = decisionReason(
        await evaluatePendingOverflowGuard(overflowInput(sessionId), "Bash")
      )
      const retry = decisionReason(
        await evaluatePendingOverflowGuard(overflowInput(sessionId), "Bash")
      )
      expect(first).toContain("46 pending tasks are queued")
      expect(retry).toBe(first)

      const readInput = overflowInput(sessionId, { tool_name: "Read", tool_input: {} })
      const outsideGrace = await evaluatePretooluseTaskGovernance(readInput)
      expect(permissionDecision(outsideGrace)).toBe("deny")
      const withinGrace = await evaluatePretooluseTaskGovernance({
        ...readInput,
        _lastUserMessageAt: Date.now(),
      })
      expect(permissionDecision(withinGrace)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
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

describe("findStaleOpenTasks", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const isoAgo = (ms: number) => new Date(now - ms).toISOString()

  test("flags an open task whose last update is past the limit", () => {
    const stale = findStaleOpenTasks(
      [
        {
          id: "1",
          status: "in_progress",
          subject: "Stale",
          updatedAt: isoAgo(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000),
        },
      ],
      now
    )
    expect(stale.map((t) => t.id)).toEqual(["1"])
  })

  test("leaves a recently updated open task alone", () => {
    const stale = findStaleOpenTasks(
      [{ id: "1", status: "pending", subject: "Fresh", updatedAt: isoAgo(60_000) }],
      now
    )
    expect(stale).toEqual([])
  })

  test("ignores terminal tasks however old", () => {
    const stale = findStaleOpenTasks(
      [
        {
          id: "1",
          status: "completed",
          subject: "Done",
          updatedAt: isoAgo(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS * 10),
        },
        {
          id: "2",
          status: "cancelled",
          subject: "Dropped",
          updatedAt: isoAgo(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS * 10),
        },
      ],
      now
    )
    expect(stale).toEqual([])
  })

  test("falls back to statusChangedAt, then fails open with no timestamp at all", () => {
    const stale = findStaleOpenTasks(
      [
        {
          id: "1",
          status: "pending",
          subject: "Legacy",
          statusChangedAt: isoAgo(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000),
        },
        { id: "2", status: "pending", subject: "Timestampless" },
      ],
      now
    )
    expect(stale.map((t) => t.id)).toEqual(["1"])
  })

  test("stops blocking on a task past the abandoned ceiling", () => {
    // The project store is shared, so a row left behind by a session that has moved on
    // would otherwise deny every later session's first TaskCreate with no reachable remedy.
    const { blocking, abandoned } = partitionStaleOpenTasks(
      [
        {
          id: "1",
          status: "in_progress",
          subject: "Abandoned",
          updatedAt: isoAgo(OPEN_TASK_ABANDONED_CEILING_MS + 60_000),
        },
        {
          id: "2",
          status: "pending",
          subject: "Merely stale",
          updatedAt: isoAgo(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000),
        },
      ],
      now
    )
    expect(blocking.map((t) => t.id)).toEqual(["2"])
    expect(abandoned.map((t) => t.id)).toEqual(["1"])
  })

  test("names every stale task in the block message", () => {
    const message = buildStaleOpenTaskMessage(
      [
        {
          id: "7",
          status: "in_progress",
          subject: "Stale work",
          updatedAt: isoAgo(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000),
        },
      ],
      now
    )
    expect(message).toContain("#7")
    expect(message).toContain("Stale work")
    expect(message).toContain("TaskUpdate")
  })
})

describe("evaluateTaskCreatePath — open-task update recency", () => {
  /**
   * Write a transcript of `count` TaskCreate calls, each paired with the result the
   * real flow would record: this gate's actual deny message when `denied`, a plain
   * success otherwise. Using the real builder keeps the fixture honest — a fixture
   * with invented deny text would pass while production never matched.
   */
  async function writeGateTranscript(
    sessionId: string,
    count: number,
    { denied }: { denied: boolean }
  ): Promise<string> {
    const dir = join(TASK_HOME, "transcripts", sessionId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, "session.jsonl")
    const denyText = buildStaleOpenTaskMessage(
      [
        {
          id: "1",
          status: "in_progress",
          subject: "Stale",
          updatedAt: new Date(
            Date.now() - (OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
          ).toISOString(),
        },
      ],
      Date.now()
    )
    const lines: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `call-${i}`
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name: "TaskCreate", input: {} }] },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                is_error: denied,
                content: denied ? denyText : "Task created.",
              },
            ],
          },
        })
      )
    }
    await Bun.write(path, `${lines.join("\n")}\n`)
    return path
  }

  async function seedTaskUpdatedAgo(sessionId: string, id: string, agoMs: number): Promise<void> {
    // Historical write times are the scenario; the repository writer would stamp now.
    await writeRawTaskFixture(TASK_HOME, sessionId, {
      id,
      subject: `Open task ${id}`,
      status: "in_progress",
      updatedAt: new Date(Date.now() - agoMs).toISOString(),
      statusChangedAt: new Date(Date.now() - agoMs).toISOString(),
    })
  }

  test("denies creation while an open task has gone stale", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-stale")
    try {
      await cleanupSession(sessionId)
      await seedTaskUpdatedAgo(sessionId, "1", OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("#1")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  // The user's own interrupt: a fresh user message suspends all task governance,
  // this gate included, so the loop is never something only the agent can break.
  test("stands down inside the user-message grace window", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-grace")
    try {
      await cleanupSession(sessionId)
      await seedTaskUpdatedAgo(sessionId, "1", OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
      const result = await pretooluseTaskGovernance.run({
        tool_name: "TaskCreate",
        session_id: sessionId,
        cwd: process.cwd(),
        _taskHome: TASK_HOME,
        _lastUserMessageAt: Date.now(),
        tool_input: { subject: "fix login bug" },
      })
      expect(permissionDecision(result)).not.toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  test("releases after repeated creation attempts rather than wedging", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-release")
    try {
      await cleanupSession(sessionId)
      await seedTaskUpdatedAgo(sessionId, "1", OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
      const transcriptPath = await writeGateTranscript(sessionId, OPEN_TASK_GATE_RELEASE_ATTEMPTS, {
        denied: true,
      })
      const input = {
        tool_name: "TaskCreate",
        session_id: sessionId,
        _taskHome: TASK_HOME,
        transcript_path: transcriptPath,
      }
      const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
      expect(permissionDecision(result)).toBe("allow")
      expect(additionalContext(result)).toContain("released")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  // Control: one denial short of the threshold must still deny, proving the
  // release above comes from the valve and not from the gate having stopped firing.
  test("still denies one denial below the release threshold", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-below")
    try {
      await cleanupSession(sessionId)
      await seedTaskUpdatedAgo(sessionId, "1", OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
      const transcriptPath = await writeGateTranscript(
        sessionId,
        OPEN_TASK_GATE_RELEASE_ATTEMPTS - 1,
        { denied: true }
      )
      const input = {
        tool_name: "TaskCreate",
        session_id: sessionId,
        _taskHome: TASK_HOME,
        transcript_path: transcriptPath,
      }
      const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
      expect(permissionDecision(result)).toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  // #937: a planning burst is several successful creates in a row. Counting attempts
  // read that as a wedge and released the gate on the first genuinely stale task.
  test("keeps enforcing after a burst of successful creates", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-burst")
    try {
      await cleanupSession(sessionId)
      await seedTaskUpdatedAgo(sessionId, "1", OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
      const transcriptPath = await writeGateTranscript(
        sessionId,
        OPEN_TASK_GATE_RELEASE_ATTEMPTS + 2,
        { denied: false }
      )
      const input = {
        tool_name: "TaskCreate",
        session_id: sessionId,
        _taskHome: TASK_HOME,
        transcript_path: transcriptPath,
      }
      const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
      expect(permissionDecision(result)).toBe("deny")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  // A denial from a different governance gate must not release this one.
  test("ignores denials that are not this gate's", () => {
    const outcomes = Array.from({ length: OPEN_TASK_GATE_RELEASE_ATTEMPTS + 2 }, () => ({
      name: "TaskCreate",
      success: false,
      resultText: "Duplicate task: collides with existing #1",
    }))
    expect(countRecentStaleGateDenials(outcomes)).toBe(0)
  })

  // Ties the detector to the builder: if the deny wording changes, this fails
  // rather than the valve silently never firing again.
  test("this gate's deny message is detectable by the counter", () => {
    const message = buildStaleOpenTaskMessage(
      [
        {
          id: "1",
          status: "in_progress",
          subject: "Stale",
          updatedAt: new Date(
            Date.now() - (OPEN_TASK_UPDATE_RECENCY_LIMIT_MS + 60_000)
          ).toISOString(),
        },
      ],
      Date.now()
    )
    expect(STALE_GATE_DENY_RE.test(message)).toBe(true)
  })

  // Control: the same seed, updated moments ago, must pass — proving the deny
  // above comes from the recency gate and not from the surrounding governance.
  test("allows creation when the same open task was just updated", async () => {
    const sessionId = uniqueSessionId("pgrep-dispatch-test-fresh")
    try {
      await cleanupSession(sessionId)
      await seedTaskUpdatedAgo(sessionId, "1", 30_000)
      const input = { tool_name: "TaskCreate", session_id: sessionId, _taskHome: TASK_HOME }
      const result = await evaluateTaskCreatePath(input, { subject: "fix login bug" })
      expect(permissionDecision(result)).toBe("allow")
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
      // #963: the trace is advice, so it must not approve the call and skip the prompt.
      expect(permissionDecision(result)).toBeUndefined()
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
 * #930: at the WIP cap a finished pending task had no legal completion. The direct close was
 * refused as a shortcut and the in_progress step by the cap, so the work could only be recorded
 * as cancelled. The one-step close now follows the service contract instead: auto-transition on
 * and evidence in the update.
 */
describe("pending completion at the WIP cap (via evaluateNativeTaskUpdatePath)", () => {
  const CAP = getInProgressCap()
  const FINISHED = "finished"
  const EVIDENCE = "commit:abc1234 test:bun test pass"

  /** Two further pending tasks satisfy the completion threshold, so any denial is the gate's. */
  async function seedFinishedWorkAtCap(sessionId: string): Promise<void> {
    await seedInProgressTasks(sessionId, CAP)
    for (const [id, subject] of [
      [FINISHED, "Finished checkout fix"],
      ["p1", "Write release notes"],
      ["p2", "Audit logging config"],
    ] as const) {
      await writeTask(TASK_HOME, sessionId, { id, subject, status: "pending" })
    }
  }

  async function updateFinished(
    sessionId: string,
    fields: Record<string, string>,
    settings = buildEffectiveTestSettings()
  ) {
    const toolInput = { taskId: FINISHED, ...fields }
    const input = {
      session_id: sessionId,
      tool_name: "TaskUpdate",
      tool_input: toolInput,
      _taskHome: TASK_HOME,
      _effectiveSettings: settings,
    }
    const parsed = input as unknown as Parameters<typeof evaluateNativeTaskUpdatePath>[2]
    return await evaluateNativeTaskUpdatePath(input, toolInput, parsed)
  }

  test("completes evidenced finished work and records the hop as two legal edges", async () => {
    const sessionId = uniqueSessionId("cap-complete-evidenced")
    try {
      await cleanupSession(sessionId)
      await seedFinishedWorkAtCap(sessionId)
      applyTaskListEvent(sessionId, [
        ...Array.from({ length: CAP }, (_, i) => ({
          id: String(i + 1),
          status: "in_progress",
          subject: `Task ${i + 1}`,
        })),
        { id: FINISHED, status: "pending", subject: "Finished checkout fix" },
      ])

      const result = await updateFinished(sessionId, { status: "completed", description: EVIDENCE })

      expect(permissionDecision(result)).not.toBe("deny")
      // A direct pending → completed would be reverted to pending by event state.
      const tracked = getSessionEventState(sessionId)?.find((task) => task.id === FINISHED)
      expect(tracked?.status).toBe("completed")
    } finally {
      pruneSession(sessionId)
      await cleanupSession(sessionId)
    }
  })

  test("control: the in_progress step for the same task is still capped", async () => {
    const sessionId = uniqueSessionId("cap-complete-control")
    try {
      await cleanupSession(sessionId)
      await seedFinishedWorkAtCap(sessionId)
      const result = await updateFinished(sessionId, { status: "in_progress" })
      expect(permissionDecision(result)).toBe("deny")
      expect(decisionReason(result)).toContain("Cannot move #finished to in_progress")
    } finally {
      await cleanupSession(sessionId)
    }
  })

  for (const [label, fields] of [
    ["no description", { status: "completed" }],
    ["a whitespace-only description", { status: "completed", description: "  \n" }],
  ] as const) {
    test(`refuses ${label} and names the evidenced retry instead of cancellation`, async () => {
      const sessionId = uniqueSessionId("cap-complete-no-evidence")
      try {
        await cleanupSession(sessionId)
        await seedFinishedWorkAtCap(sessionId)
        const result = await updateFinished(sessionId, fields)
        const reason = decisionReason(result) ?? ""
        expect(permissionDecision(result)).toBe("deny")
        expect(reason).toContain("records no evidence of finished work")
        expect(reason).toContain("retry this TaskUpdate with the evidence in its description")
        expect(reason).not.toContain("tasks back to pending")
        expect(reason).not.toMatch(/\bcancel/i)
      } finally {
        await cleanupSession(sessionId)
      }
    })
  }

  test("disabled auto-transition refuses even with evidence and forbids cancelling real work", async () => {
    const sessionId = uniqueSessionId("cap-complete-disabled")
    try {
      await cleanupSession(sessionId)
      await seedFinishedWorkAtCap(sessionId)
      const result = await updateFinished(
        sessionId,
        { status: "completed", description: EVIDENCE },
        buildEffectiveTestSettings({ taskAutoTransition: false })
      )
      const reason = decisionReason(result) ?? ""
      expect(permissionDecision(result)).toBe("deny")
      expect(reason).toContain("task auto-transition is disabled")
      expect(reason).toContain("Do not cancel real work to free a slot")
      expect(reason).not.toContain("retry this TaskUpdate with the evidence")
      expect(reason).not.toContain("tasks back to pending")
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
