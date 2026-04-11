import { describe, expect, mock, test } from "bun:test"

type Change = { kind: string; key: string; reason: string }

const mockSyncResult = {
  issues: {
    upserted: 0,
    removed: 0,
    skipped: 5,
    changes: [] as Change[],
  },
  pullRequests: {
    upserted: 0,
    removed: 0,
    skipped: 2,
    changes: [] as Change[],
  },
  ciStatuses: { upserted: 0, changes: [] as Change[] },
  comments: { upserted: 0 },
  labels: {
    upserted: 0,
    removed: 0,
    skipped: 3,
    changes: [] as Change[],
  },
  milestones: {
    upserted: 0,
    removed: 0,
    skipped: 0,
    changes: [] as Change[],
  },
  branchCi: { upserted: 0, changes: [] as Change[] },
  prBranchDetail: { upserted: 0, changes: [] as Change[] },
  branchProtection: { upserted: 0, changes: [] as Change[] },
}

let syncCallCount = 0
let syncShouldThrow = false

await mock.module("../src/issue-store-sync.ts", () => ({
  syncUpstreamState: () => {
    syncCallCount++
    if (syncShouldThrow) return Promise.reject(new Error("sync failed"))
    return Promise.resolve(mockSyncResult)
  },
}))

// The hook calls getRepoSlug which needs a git remote — run tests from the real repo root
// so getRepoSlug resolves to the actual repo slug.

const { evaluateIssueSyncBeforeCheckout } = await import(
  "./pretooluse-issue-sync-before-checkout.ts"
)

function makeInput(command: string, toolName = "Bash") {
  return { tool_name: toolName, tool_input: { command }, cwd: process.cwd() }
}

describe("pretooluse-issue-sync-before-checkout", () => {
  test("allows non-checkout commands without syncing", async () => {
    syncCallCount = 0
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git status"))
    expect(result).toEqual({})
    expect(syncCallCount).toBe(0)
  })

  test("allows non-shell tools without syncing", async () => {
    syncCallCount = 0
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git checkout feature", "Edit"))
    expect(result).toEqual({})
    expect(syncCallCount).toBe(0)
  })

  test("runs sync on git checkout <branch>", async () => {
    syncCallCount = 0
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git checkout feature-branch"))
    expect(syncCallCount).toBe(1)
    expect(result).toHaveProperty("systemMessage")
  })

  test("runs sync on git switch <branch>", async () => {
    syncCallCount = 0
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git switch feature-branch"))
    expect(syncCallCount).toBe(1)
    expect(result).toHaveProperty("systemMessage")
  })

  test("runs sync on git checkout -b <branch>", async () => {
    syncCallCount = 0
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git checkout -b new-branch"))
    expect(syncCallCount).toBe(1)
    expect(result).toHaveProperty("systemMessage")
  })

  test("does not block when sync fails", async () => {
    syncCallCount = 0
    syncShouldThrow = true
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git checkout feature-branch"))
    expect(syncCallCount).toBe(1)
    expect(result).toEqual({})
    syncShouldThrow = false
  })

  test("skips non-checkout git commands", async () => {
    syncCallCount = 0
    for (const cmd of ["git log --oneline", "git diff HEAD", "git commit -m 'test'", "git push"]) {
      const result = await evaluateIssueSyncBeforeCheckout(makeInput(cmd))
      expect(result).toEqual({})
    }
    expect(syncCallCount).toBe(0)
  })

  test("reports changes count when sync finds updates", async () => {
    syncCallCount = 0
    const savedChanges = mockSyncResult.issues.changes
    mockSyncResult.issues.changes = [{ kind: "new", key: "#99", reason: "new issue" }]
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git checkout feature"))
    expect(syncCallCount).toBe(1)
    const ctx = (result as { systemMessage?: string }).systemMessage ?? ""
    expect(ctx).toContain("1 change")
    mockSyncResult.issues.changes = savedChanges
  })
})
