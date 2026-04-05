/**
 * Tests for stop-branch-conflicts hook extraction.
 *
 * Validates branch conflict detection across all modules:
 * - GitHub PR state validation (mergeable conflicts)
 * - Local merge-tree validation (textual conflicts)
 * - Stale branch detection (divergence threshold)
 */

import { beforeEach, describe, expect, it } from "bun:test"
import type { ForkTopology } from "../../src/git-helpers.ts"
import {
  buildPRConflictOutput,
  buildStaleBranchOutput,
  buildTextualConflictOutput,
} from "./action-plan.ts"
import { isPRConflicting, isPRMergeable } from "./github-pr-validator.ts"
import {
  hasTextualConflicts,
  isStaleBranch,
  STALE_BRANCH_THRESHOLD,
} from "./local-merge-validator.ts"
import type { BranchCheckContext, GitHubPRState, GitMergeState } from "./types.ts"

const mockForkTopology: ForkTopology = {
  originSlug: "user/repo",
  upstreamSlug: "org/repo",
  hasUpstreamRemote: false,
}

describe("GitHub PR Validator", () => {
  it("detects conflicting PR state", () => {
    const pr: GitHubPRState = {
      number: 42,
      url: "https://github.com/user/repo/pull/42",
      state: "OPEN",
      mergeable: "CONFLICTING",
      mergeStateStatus: "BLOCKED",
    }
    expect(isPRConflicting(pr)).toBe(true)
  })

  it("returns false for non-conflicting PR", () => {
    const pr: GitHubPRState = {
      number: 42,
      url: "https://github.com/user/repo/pull/42",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }
    expect(isPRConflicting(pr)).toBe(false)
  })

  it("detects mergeable PR state", () => {
    const pr: GitHubPRState = {
      number: 42,
      url: "https://github.com/user/repo/pull/42",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }
    expect(isPRMergeable(pr)).toBe(true)
  })

  it("handles null PR state", () => {
    expect(isPRConflicting(null)).toBe(false)
    expect(isPRMergeable(null)).toBe(false)
  })
})

describe("Local Merge Validator", () => {
  it("detects textual conflicts", () => {
    const merge: GitMergeState = {
      conflictCount: 3,
      behindCount: 5,
    }
    expect(hasTextualConflicts(merge)).toBe(true)
  })

  it("returns false when no conflicts", () => {
    const merge: GitMergeState = {
      conflictCount: 0,
      behindCount: 5,
    }
    expect(hasTextualConflicts(merge)).toBe(false)
  })

  it("detects stale branch", () => {
    const merge: GitMergeState = {
      conflictCount: 0,
      behindCount: STALE_BRANCH_THRESHOLD + 10,
    }
    expect(isStaleBranch(merge)).toBe(true)
  })

  it("returns false for branch at threshold", () => {
    const merge: GitMergeState = {
      conflictCount: 0,
      behindCount: STALE_BRANCH_THRESHOLD - 1,
    }
    expect(isStaleBranch(merge)).toBe(false)
  })

  it("handles null merge state", () => {
    expect(hasTextualConflicts(null)).toBe(false)
    expect(isStaleBranch(null)).toBe(false)
  })
})

describe("Action Plan - Output Formatting", () => {
  let ctx: BranchCheckContext

  beforeEach(() => {
    ctx = {
      cwd: "/tmp/test-repo",
      branch: "feature/test",
      defaultBranch: "main",
      defaultRemoteRef: "origin/main",
      forkTopology: mockForkTopology,
    }
  })

  it("formats PR conflict output", () => {
    const pr: GitHubPRState = {
      number: 42,
      url: "https://github.com/user/repo/pull/42",
      state: "OPEN",
      mergeable: "CONFLICTING",
      mergeStateStatus: "BLOCKED",
    }
    const output = buildPRConflictOutput(ctx, pr)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("conflict")
  })

  it("formats textual conflict output", () => {
    const merge: GitMergeState = {
      conflictCount: 2,
      behindCount: 5,
    }
    const output = buildTextualConflictOutput(ctx, merge)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("conflict")
  })

  it("formats stale branch output", () => {
    const merge: GitMergeState = {
      conflictCount: 0,
      behindCount: STALE_BRANCH_THRESHOLD + 20,
    }
    const output = buildStaleBranchOutput(ctx, merge, STALE_BRANCH_THRESHOLD)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("stale")
  })
})
