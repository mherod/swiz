import { describe, expect, mock, test } from "bun:test"
import { evaluateUserpromptsubmitGitContext } from "./userpromptsubmit-git-context.ts"

// Clean mockup state for git-utils
let mockGitStatus: any = null

await mock.module("../src/utils/git-utils.ts", () => {
  return {
    getGitStatusV2: () => mockGitStatus,
  }
})

describe("userpromptsubmit-git-context", () => {
  test("returns basic context on clean working tree", async () => {
    mockGitStatus = {
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
    }

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: "test",
    })

    const additionalContext = (result as any).hookSpecificOutput?.additionalContext
    expect(additionalContext).toContain(
      "On branch main tracking origin/main. The working tree is clean."
    )
    expect(additionalContext).not.toContain("Uncommitted files:")
  })

  test("includes uncommitted file list when working tree has changes", async () => {
    mockGitStatus = {
      branch: "main",
      total: 2,
      modified: 1,
      added: 1,
      deleted: 0,
      untracked: 0,
      lines: ["src/file1.ts", "src/file2.ts"],
      ahead: 0,
      behind: 0,
      upstream: "origin/main",
      upstreamGone: false,
    }

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: "test",
    })

    const additionalContext = (result as any).hookSpecificOutput?.additionalContext
    expect(additionalContext).toContain("On branch main tracking origin/main.")
    expect(additionalContext).toContain("Uncommitted files:")
    expect(additionalContext).toContain("  - src/file1.ts")
    expect(additionalContext).toContain("  - src/file2.ts")
  })

  test("clamps the uncommitted file list to max visible files (30)", async () => {
    const lines = Array.from({ length: 45 }, (_, i) => `src/file-${i}.ts`)
    mockGitStatus = {
      branch: "main",
      total: 45,
      modified: 45,
      added: 0,
      deleted: 0,
      untracked: 0,
      lines,
      ahead: 0,
      behind: 0,
      upstream: "origin/main",
      upstreamGone: false,
    }

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: "test",
    })

    const additionalContext = (result as any).hookSpecificOutput?.additionalContext
    expect(additionalContext).toContain("Uncommitted files:")
    expect(additionalContext).toContain("  - src/file-29.ts")
    expect(additionalContext).not.toContain("  - src/file-30.ts")
    expect(additionalContext).toContain("... and 15 more file(s)")
  })
})
