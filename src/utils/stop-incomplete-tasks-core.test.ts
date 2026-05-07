import { describe, expect, it } from "bun:test"
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
