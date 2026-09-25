import { describe, expect, test } from "bun:test"
import { getAgent } from "../agents.ts"
import { buildTaskGovernanceMessage } from "./task-governance-messages.ts"
import { countPendingByScope } from "./task-queue-view.ts"

const CLAUDE = getAgent("claude") ?? null

function overflow(pendingCount: number, otherSessions = 0) {
  return {
    kind: "pending-overflow" as const,
    toolName: "Bash",
    pendingCount,
    limit: 20,
    scope: { thisSession: pendingCount - otherSessions, projectQueue: 0, otherSessions },
  }
}

// #929: the denial named no count, and its TaskList-capable branch prescribed only a sync, which
// cannot lower a count. Agents shed real backlog chasing a cause the message never stated.
describe("pending-overflow denial", () => {
  test("names the measured count, the limit and the excess", () => {
    const reason = buildTaskGovernanceMessage(overflow(46), { translationAgent: CLAUDE })
    expect(reason).toContain("46 pending tasks are queued, above the limit of 20")
    expect(reason).toContain("Bring pending down by 26 (to 20 or fewer)")
    expect(reason).toContain("Counted: 46 in this session.")
  })

  for (const [label, agent] of [
    ["a TaskList-capable agent", CLAUDE],
    ["an agent without TaskList", null],
  ] as const) {
    test(`never offers a sync as the fix for ${label}`, () => {
      const reason = buildTaskGovernanceMessage(overflow(21), { translationAgent: agent })
      expect(reason).toContain("21 pending tasks are queued")
      // The sync is not the fix, but it does prune stale records; the copy must say exactly that.
      expect(reason).toContain(
        "A TaskList sync lowers the count only by pruning tasks untouched for 2 days"
      )
      // The two pre-#929 capability branches: a sync-only remedy and an unqualified cleanup.
      expect(reason).not.toContain("Clear the task state")
      expect(reason).not.toContain("clean up or complete pending tasks")
      expect(reason).toContain("Do not cancel real planned work to satisfy this count")
    })
  }

  test("only a TaskList-capable agent is told to inspect the queue with TaskList", () => {
    expect(buildTaskGovernanceMessage(overflow(21), { translationAgent: CLAUDE })).toContain(
      "Run TaskList now."
    )
    expect(buildTaskGovernanceMessage(overflow(21), { translationAgent: null })).not.toContain(
      "Run TaskList now."
    )
  })

  test("explains why a retry can pass without the count changing", () => {
    const reason = buildTaskGovernanceMessage(overflow(46), { translationAgent: CLAUDE })
    expect(reason).toContain("relaxed briefly after a user message and while a skill runs")
  })

  test("tells the caller to leave other sessions' tasks alone only when some were counted", () => {
    const shared = buildTaskGovernanceMessage(overflow(30, 12), { translationAgent: CLAUDE })
    expect(shared).toContain("Counted: 18 in this session, 12 owned by other sessions.")
    expect(shared).toContain("Leave tasks owned by other sessions to their owners.")
    const own = buildTaskGovernanceMessage(overflow(30), { translationAgent: CLAUDE })
    expect(own).not.toContain("owned by other sessions")
  })
})

// The sync gate and the count gate fail on independent predicates; each denial must name its own.
describe("canonical-tasklist-stale denial", () => {
  test("reports that no sync was ever recorded", () => {
    const reason = buildTaskGovernanceMessage({
      kind: "canonical-tasklist-stale",
      toolName: "Bash",
      lastSyncAgeMs: null,
    })
    expect(reason).toContain("no canonical TaskList sync is recorded for this session")
    expect(reason).toContain("It checks sync age only")
  })

  test("reports the measured age of a stale sync", () => {
    const reason = buildTaskGovernanceMessage({
      kind: "canonical-tasklist-stale",
      toolName: "Bash",
      lastSyncAgeMs: 27 * 60_000,
    })
    expect(reason).toContain("the last canonical TaskList sync for this session was 27m ago")
    expect(reason).not.toContain("pending tasks are queued")
  })
})

describe("countPendingByScope", () => {
  test("splits pending tasks by owning store and ignores other statuses", () => {
    const tasks = [
      { status: "pending", storeKey: { kind: "session" as const, id: "me" } },
      { status: "pending" },
      { status: "pending", storeKey: { kind: "project" as const, key: "-repo" } },
      { status: "pending", storeKey: { kind: "session" as const, id: "peer" } },
      { status: "in_progress", storeKey: { kind: "session" as const, id: "peer" } },
      { status: "completed", storeKey: { kind: "project" as const, key: "-repo" } },
    ]
    expect(countPendingByScope(tasks, "me")).toEqual({
      thisSession: 2,
      projectQueue: 1,
      otherSessions: 1,
    })
  })
})
