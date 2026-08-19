import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatIncompleteReason } from "../tasks/task-governance-messages.ts"
import type { SessionTask } from "../tasks/task-recovery.ts"
import { checkIncompleteTasks, getIncompleteDetails } from "./stop-incomplete-tasks-core.ts"

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

describe("getIncompleteDetails — deduplication is no longer performed", () => {
  it("returns duplicate-subject incomplete tasks (no longer auto-completed)", () => {
    const tasks: SessionTask[] = [
      task("1", "completed", "Push changes to main"),
      task("2", "in_progress", "Push changes to main"),
    ]
    // Before auto-transition removal, deduplicateStaleTasks would have silently
    // completed task #2 because its subject matched the completed task #1.
    // Now the duplicate must still surface so it blocks stop.
    const details = getIncompleteDetails(tasks)
    expect(details).toHaveLength(1)
    expect(details[0]).toContain("Push changes to main")
    expect(details[0]).toContain("task #2")
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

  it("names update_plan when TaskList is unavailable", () => {
    const details = ["Update Codex messaging (task #11)"]
    const reason = formatIncompleteReason(details, {
      tasksDir: "/home/.codex/tasks/sess",
      sessionId: "sess",
      taskListAvailable: false,
      taskUpdateToolName: "update_plan",
    })

    expect(reason).toContain("Use update_plan to update task statuses")
    expect(reason).not.toContain("TaskList")
    expect(reason).not.toContain("TaskUpdate")
  })

  it("uses TaskList only for review and names TaskUpdate as the status action", () => {
    const details = ["Finish hook repair (task #12)"]
    const reason = formatIncompleteReason(details, {
      tasksDir: "/home/.claude/tasks/sess",
      sessionId: "sess",
      taskListAvailable: true,
      taskListToolName: "TaskList",
      taskUpdateToolName: "TaskUpdate",
    })

    expect(reason).toContain(
      "Use TaskList to review tasks, then TaskUpdate to update their status."
    )
    expect(reason).not.toContain("Run TaskList now")
  })
})

// A session driven through the MCP task tools keeps its queue under
// projectKeyFromCwd(cwd), not the session id. Reading only the session directory reported an empty
// queue and waved stop straight through, defeating the gate entirely for those sessions.
describe("checkIncompleteTasks — project-keyed queue", () => {
  const HOME = join(tmpdir(), `swiz-stop-union-${process.pid}`)
  const SESSION_ID = "00000000-0000-0000-0000-0000000000ab"
  const CWD = "/Users/someone/Development/demo"
  const PROJECT_KEY = "-Users-someone-Development-demo"

  async function writeTask(storeKey: string, id: string, status: string): Promise<void> {
    const dir = join(HOME, ".claude", "tasks", storeKey)
    await mkdir(dir, { recursive: true })
    await Bun.write(
      join(dir, `${id}.json`),
      JSON.stringify({ id, subject: `subject ${id}`, description: "", status })
    )
  }

  beforeAll(async () => {
    await writeTask(PROJECT_KEY, "349d-1", "in_progress")
  })

  afterAll(async () => {
    await rm(HOME, { recursive: true, force: true })
  })

  it("allows stop when no cwd is supplied and the session store is empty (control)", async () => {
    // Proves the block below comes from the union, not from some other tasks on disk.
    expect(await checkIncompleteTasks(SESSION_ID, HOME)).toBeNull()
  })

  it("blocks stop on an incomplete task held in the project-keyed store", async () => {
    const result = await checkIncompleteTasks(SESSION_ID, HOME, { cwd: CWD })
    expect(result?.decision).toBe("block")
    expect(result?.reason).toContain("349d-1")
  })
})
