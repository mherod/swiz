import { describe, expect, it } from "bun:test"
import { formatIncompleteReason } from "../tasks/task-governance-messages.ts"
import type { SessionTask } from "../tasks/task-recovery.ts"
import { getIncompleteDetails } from "./stop-incomplete-tasks-core.ts"

function task(id: string, status: SessionTask["status"], subject: string): SessionTask {
  return {
    id,
    subject,
    description: "",
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SessionTask
}

describe("getIncompleteDetails — deferred-subject exemption (#580)", () => {
  it("excludes pending tasks whose subject starts with 'Future:'", () => {
    const tasks: SessionTask[] = [
      task("1", "pending", "Future: break down ceremony epic"),
      task("2", "pending", "Future: address dependabot alerts"),
    ]
    expect(getIncompleteDetails(tasks)).toEqual([])
  })

  it("excludes pending tasks whose subject starts with 'Consider'", () => {
    const tasks: SessionTask[] = [
      task("3", "pending", "Consider weekly retro on codex governance batch"),
      task("4", "pending", "Consider /work-on-issue 579 next session"),
    ]
    expect(getIncompleteDetails(tasks)).toEqual([])
  })

  it("excludes pending tasks whose subject starts with 'Follow-up:'", () => {
    const tasks: SessionTask[] = [task("5", "pending", "Follow-up: triage codex #575 next session")]
    expect(getIncompleteDetails(tasks)).toEqual([])
  })

  it("still surfaces non-deferred incomplete tasks alongside deferred ones", () => {
    const tasks: SessionTask[] = [
      task("10", "in_progress", "Wire up the migration"),
      task("11", "pending", "Consider extracting helper"),
      task("12", "pending", "Future: revisit cache TTL"),
    ]
    const details = getIncompleteDetails(tasks)
    expect(details).toHaveLength(1)
    expect(details[0]).toContain("Wire up the migration")
  })

  it("filters case-insensitively (FUTURE:, future:, Future:)", () => {
    const tasks: SessionTask[] = [
      task("20", "pending", "FUTURE: capital prefix"),
      task("21", "pending", "future: lowercase prefix"),
    ]
    expect(getIncompleteDetails(tasks)).toEqual([])
  })

  it("does not mistake substrings — 'consider' must be at start, not anywhere", () => {
    const tasks: SessionTask[] = [task("30", "pending", "Wire up — please consider the cache flow")]
    const details = getIncompleteDetails(tasks)
    expect(details).toHaveLength(1)
  })
})

describe("formatIncompleteReason — source context (#613)", () => {
  it("includes tasksDir path when sourceCtx is provided", () => {
    const details = ["Implement feature (task #1)"]
    const reason = formatIncompleteReason(details, {
      tasksDir: "/Users/dev/.claude/tasks/session-abc123",
      sessionId: "session-abc123",
    })
    expect(reason).toContain("Task files:")
    expect(reason).toContain("/Users/dev/.claude/tasks/session-abc123")
  })

  it("falls back to session-derived path when tasksDir is null", () => {
    const details = ["Wire up migration (task #2)"]
    const reason = formatIncompleteReason(details, {
      tasksDir: null,
      sessionId: "my-session-id",
    })
    expect(reason).toContain("Task files:")
    expect(reason).toContain("my-session-id")
  })

  it("omits task files line when no sourceCtx is provided (backwards compat)", () => {
    const details = ["Finish implementation (task #3)"]
    const reason = formatIncompleteReason(details)
    expect(reason).not.toContain("Task files:")
    expect(reason).toContain("Finish implementation")
  })

  it("still includes task subjects and completion guidance", () => {
    const details = ["Ship the feature (task #10)"]
    const reason = formatIncompleteReason(details, {
      tasksDir: "/home/.claude/tasks/sess",
      sessionId: "sess",
    })
    expect(reason).toContain("Ship the feature")
    expect(reason).toContain("task #10")
    expect(reason).toContain("Complete these tasks before stopping")
  })
})
