import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { SyncChange, UpstreamSyncResult } from "../src/issue-store-sync.ts"
import { evaluateIssueSyncBeforeCheckout } from "./pretooluse-issue-sync-before-checkout.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")
const resolveRepoSlug = () => Promise.resolve("mherod/swiz")

function makeSyncResult(issueChanges: SyncChange[] = []): UpstreamSyncResult {
  const empty = (): {
    upserted: number
    removed: number
    skipped: number
    changes: SyncChange[]
  } => ({
    upserted: 0,
    removed: 0,
    skipped: 0,
    changes: [],
  })
  return {
    issues: { ...empty(), skipped: 5, changes: issueChanges },
    pullRequests: { ...empty(), skipped: 2 },
    ciStatuses: { upserted: 0, changes: [] },
    comments: { upserted: 0 },
    labels: { ...empty(), skipped: 3 },
    milestones: empty(),
    branchCi: { upserted: 0, changes: [] },
    prBranchDetail: { upserted: 0, changes: [] },
    branchProtection: { upserted: 0, changes: [] },
    events: { inserted: 0, cursor: null },
  }
}

// The hook calls getRepoSlug which needs a git remote — run tests from the real repo root
// so getRepoSlug resolves to the actual repo slug.

function makeInput(command: string, toolName = "Bash") {
  return { tool_name: toolName, tool_input: { command }, cwd: REPO_ROOT }
}

describe("pretooluse-issue-sync-before-checkout", () => {
  test("allows non-checkout commands without syncing", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult())
    }
    const result = await evaluateIssueSyncBeforeCheckout(makeInput("git status"), syncFn)
    expect(result).toEqual({})
    expect(callCount).toBe(0)
  })

  test("allows non-shell tools without syncing", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult())
    }
    const result = await evaluateIssueSyncBeforeCheckout(
      makeInput("git checkout feature", "Edit"),
      syncFn
    )
    expect(result).toEqual({})
    expect(callCount).toBe(0)
  })

  test("runs sync on git checkout <branch>", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult())
    }
    const result = await evaluateIssueSyncBeforeCheckout(
      makeInput("git checkout feature-branch"),
      syncFn,
      resolveRepoSlug
    )
    expect(callCount).toBe(1)
    expect(result).toHaveProperty("systemMessage")
  })

  test("runs sync on git switch <branch>", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult())
    }
    const result = await evaluateIssueSyncBeforeCheckout(
      makeInput("git switch feature-branch"),
      syncFn,
      resolveRepoSlug
    )
    expect(callCount).toBe(1)
    expect(result).toHaveProperty("systemMessage")
  })

  test("runs sync on git checkout -b <branch>", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult())
    }
    const result = await evaluateIssueSyncBeforeCheckout(
      makeInput("git checkout -b new-branch"),
      syncFn,
      resolveRepoSlug
    )
    expect(callCount).toBe(1)
    expect(result).toHaveProperty("systemMessage")
  })

  test("does not block when sync fails", async () => {
    let callCount = 0
    const syncFn = (): Promise<UpstreamSyncResult> => {
      callCount++
      return Promise.reject(new Error("sync failed"))
    }
    const result = await evaluateIssueSyncBeforeCheckout(
      makeInput("git checkout feature-branch"),
      syncFn,
      resolveRepoSlug
    )
    expect(callCount).toBe(1)
    expect(result).toEqual({})
  })

  test("skips non-checkout git commands", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult())
    }
    for (const cmd of ["git log --oneline", "git diff HEAD", "git commit -m 'test'", "git push"]) {
      const result = await evaluateIssueSyncBeforeCheckout(makeInput(cmd), syncFn)
      expect(result).toEqual({})
    }
    expect(callCount).toBe(0)
  })

  test("reports changes count when sync finds updates", async () => {
    let callCount = 0
    const syncFn = () => {
      callCount++
      return Promise.resolve(makeSyncResult([{ kind: "new", key: "#99", reason: "new issue" }]))
    }
    const result = await evaluateIssueSyncBeforeCheckout(
      makeInput("git checkout feature"),
      syncFn,
      resolveRepoSlug
    )
    expect(callCount).toBe(1)
    const ctx = (result as { systemMessage?: string }).systemMessage ?? ""
    expect(ctx).toContain("1 change")
  })
})
