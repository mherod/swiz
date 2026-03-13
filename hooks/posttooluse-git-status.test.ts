import { describe, expect, it } from "vitest"
import { buildGitContextLine } from "./posttooluse-git-status.ts"
import type { GitStatusV2 } from "./utils/git-utils.ts"

function makeStatus(overrides: Partial<GitStatusV2> = {}): GitStatusV2 {
  return {
    branch: "main",
    total: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    lines: [],
    ahead: 0,
    behind: 0,
    upstream: "origin/main",
    upstreamGone: false,
    ...overrides,
  }
}

describe("buildGitContextLine", () => {
  it("includes branch name", () => {
    const result = buildGitContextLine(makeStatus({ branch: "feat/foo" }))
    expect(result).toContain("[git] branch: feat/foo")
  })

  it("includes upstream ref when available", () => {
    const result = buildGitContextLine(makeStatus({ upstream: "origin/main" }))
    expect(result).toContain("upstream: origin/main")
    expect(result).not.toContain("no upstream")
    expect(result).not.toContain("(gone)")
  })

  it("shows no upstream when upstream is null", () => {
    const result = buildGitContextLine(makeStatus({ upstream: null }))
    expect(result).toContain("no upstream")
  })

  it("shows gone upstream", () => {
    const result = buildGitContextLine(
      makeStatus({ upstream: "origin/deleted-branch", upstreamGone: true })
    )
    expect(result).toContain("upstream: origin/deleted-branch (gone)")
  })

  it("includes uncommitted file count", () => {
    const result = buildGitContextLine(makeStatus({ total: 3 }))
    expect(result).toContain("uncommitted files: 3")
  })

  it("shows clean state with zero uncommitted", () => {
    const result = buildGitContextLine(makeStatus({ total: 0 }))
    expect(result).toContain("uncommitted files: 0")
  })

  it("shows ahead count as unpushed commits", () => {
    const result = buildGitContextLine(makeStatus({ ahead: 2 }))
    expect(result).toContain("2 unpushed commit(s)")
  })

  it("shows behind count", () => {
    const result = buildGitContextLine(makeStatus({ behind: 5 }))
    expect(result).toContain("5 behind remote")
  })

  it("shows diverged when both ahead and behind", () => {
    const result = buildGitContextLine(makeStatus({ ahead: 3, behind: 2 }))
    expect(result).toContain("diverged: 3 ahead, 2 behind")
  })

  it("omits ahead/behind when both zero", () => {
    const result = buildGitContextLine(makeStatus({ ahead: 0, behind: 0 }))
    expect(result).not.toContain("unpushed")
    expect(result).not.toContain("behind")
    expect(result).not.toContain("diverged")
  })

  it("omits collab mode when auto", () => {
    const result = buildGitContextLine(makeStatus(), "auto")
    expect(result).not.toContain("collab:")
  })

  it("includes collab mode when not auto", () => {
    const result = buildGitContextLine(makeStatus(), "solo")
    expect(result).toContain("collab: solo")
  })

  it("combines all fields for a full status line", () => {
    const result = buildGitContextLine(
      makeStatus({
        branch: "feat/issue-42",
        upstream: "origin/feat/issue-42",
        total: 2,
        ahead: 1,
      }),
      "team"
    )
    expect(result).toBe(
      "[git] branch: feat/issue-42 | upstream: origin/feat/issue-42 | uncommitted files: 2 | 1 unpushed commit(s) | collab: team"
    )
  })
})
