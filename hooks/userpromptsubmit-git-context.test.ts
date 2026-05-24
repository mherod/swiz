import { describe, expect, mock, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hookOutputSchema } from "../src/schemas.ts"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"
import type { GitStatusV2 } from "../src/utils/git-utils.ts"
import { evaluateUserpromptsubmitGitContext } from "./userpromptsubmit-git-context.ts"

const mockGitStatusByCwd = new Map<string, GitStatusV2 | null>()
const mockSessionEdits = new Map<string, { file_path: string }[]>()

await mock.module("../src/utils/git-utils.ts", () => {
  return {
    getGitStatusV2: (cwd: string) => mockGitStatusByCwd.get(cwd) ?? null,
  }
})

await mock.module("../src/issue-store.ts", () => {
  // The hook resolves session edits via getIssueStoreReader (daemon-fallback
  // reader added in 17046fd2); getIssueStore is kept for any sync callers.
  const reader = {
    listSessionEdits: (projectKey: string, sessionId: string) => {
      return mockSessionEdits.get(`${projectKey}:${sessionId}`) ?? []
    },
  }
  return {
    getIssueStore: () => reader,
    getIssueStoreReader: () => reader,
  }
})

await mock.module("../src/git-helpers.ts", () => {
  return {
    git: (args: string[], cwd?: string) => {
      if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return Promise.resolve(cwd ?? process.cwd())
      }
      return Promise.resolve("")
    },
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

  test("partitions uncommitted files into session edits and external edits", async () => {
    const cwd = testCwd("partitioned")
    const projKey = projectKeyFromCwd(cwd)
    const sessionId = "session-xyz"

    // Mock two files edited by us in this session
    mockSessionEdits.set(`${projKey}:${sessionId}`, [
      { file_path: "src/file1.ts" },
      { file_path: "src/file2.ts" },
    ])

    mockGitStatusByCwd.set(
      cwd,
      gitStatus({
        modified: 3,
        lines: ["src/file1.ts", "src/file2.ts", "src/file3.ts"],
        total: 3,
      })
    )

    const result = await evaluateUserpromptsubmitGitContext({
      session_id: sessionId,
      cwd,
    })

    const context = additionalContext(result)
    expect(context).toContain("Uncommitted files:")
    expect(context).toContain("  Edited in this session (by us):")
    expect(context).toContain("    - src/file1.ts")
    expect(context).toContain("    - src/file2.ts")
    expect(context).toContain("  Edited externally (by tools or other parallel agents):")
    expect(context).toContain("    - src/file3.ts")
    expect(context).not.toContain(
      "    - src/file1.ts" + "\n" + "    - src/file2.ts" + "\n" + "    - src/file3.ts"
    ) // shouldn't be under one single list
  })
})
