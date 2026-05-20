import { describe, expect, mock, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hookOutputSchema } from "../src/schemas.ts"
import type { GitStatusV2 } from "../src/utils/git-utils.ts"
import { evaluateUserpromptsubmitGitContext } from "./userpromptsubmit-git-context.ts"

const mockGitStatusByCwd = new Map<string, GitStatusV2 | null>()

await mock.module("../src/utils/git-utils.ts", () => {
  return {
    getGitStatusV2: (cwd: string) => mockGitStatusByCwd.get(cwd) ?? null,
  }
})

function testCwd(name: string): string {
  return join(tmpdir(), `swiz-userpromptsubmit-git-context-${name}`)
}

function gitStatus(overrides: Partial<GitStatusV2>): GitStatusV2 {
  return {
    added: 0,
    ahead: 0,
    behind: 0,
    branch: "main",
    deleted: 0,
    lines: [],
    modified: 0,
    total: 0,
    untracked: 0,
    upstream: "origin/main",
    upstreamGone: false,
    ...overrides,
  }
}

function additionalContext(result: unknown): string | undefined {
  return hookOutputSchema.parse(result).hookSpecificOutput?.additionalContext
}

describe("userpromptsubmit-git-context", () => {
  test("returns basic context on clean working tree", async () => {
    const cwd = testCwd("clean")
    mockGitStatusByCwd.set(cwd, gitStatus({ total: 0 }))

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: "test",
      cwd,
    })

    const context = additionalContext(result)
    expect(context).toContain("On branch main tracking origin/main. The working tree is clean.")
    expect(context).not.toContain("Uncommitted files:")
  })

  test("includes uncommitted file list when working tree has changes", async () => {
    const cwd = testCwd("changed")
    mockGitStatusByCwd.set(
      cwd,
      gitStatus({
        modified: 1,
        added: 1,
        lines: ["src/file1.ts", "src/file2.ts"],
        total: 2,
      })
    )

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: "test",
      cwd,
    })

    const context = additionalContext(result)
    expect(context).toContain("On branch main tracking origin/main.")
    expect(context).toContain("Uncommitted files:")
    expect(context).toContain("  - src/file1.ts")
    expect(context).toContain("  - src/file2.ts")
  })

  test("clamps the uncommitted file list to max visible files (30)", async () => {
    const cwd = testCwd("clamped")
    const lines = Array.from({ length: 45 }, (_, i) => `src/file-${i}.ts`)
    mockGitStatusByCwd.set(
      cwd,
      gitStatus({
        modified: 45,
        lines,
        total: 45,
      })
    )

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: "test",
      cwd,
    })

    const context = additionalContext(result)
    expect(context).toContain("Uncommitted files:")
    expect(context).toContain("  - src/file-29.ts")
    expect(context).not.toContain("  - src/file-30.ts")
    expect(context).toContain("... and 15 more file(s)")
  })
})
