import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getIssueStore, resetIssueStore } from "./issue-store.ts"
import type { SwizHookOutput } from "./SwizHook.ts"
import { hookOutputSchema } from "./schemas.ts"
import { extractPrNumber, GH_PR_MERGE_RE } from "./utils/hook-utils.ts"

// ── Mocks ────────────────────────────────────────────────────────────────────

void mock.module("../src/git-helpers.ts", () => ({
  ghJsonViaDaemon: async (args: string[]) => {
    if (args.join(" ").includes("pulls/101")) {
      return {
        base: {
          ref: "main",
        },
        mergeStateStatus: "MERGEABLE",
        mergeable: true,
        reviewDecision: "APPROVED",
      }
    }
    return null
  },
  getRepoSlug: async () => "mherod/swiz",
}))

void mock.module("../src/collaboration-policy.ts", () => ({
  detectProjectCollaborationPolicy: async () => ({
    isCollaborative: true,
    repoOwner: "mherod",
    repoName: "swiz",
    signals: ["mock-signal"],
  }),
}))

void mock.module("../src/settings.ts", () => ({
  getEffectiveSwizSettings: () => ({
    strictNoDirectMain: true,
  }),
  readProjectSettings: async () => ({
    trunkMode: false,
  }),
  readSwizSettings: async () => ({}),
  resolvePolicy: () => ({
    trivialMaxFiles: 3,
    trivialMaxLines: 50,
  }),
}))

let evaluatePretooluseMainBranchScopeGate: (input: unknown) => Promise<SwizHookOutput>

// ── gh pr merge command detection ────────────────────────────────────────────
// These tests verify the regex and helper used by the scope gate hook to
// intercept `gh pr merge` commands (issue #212).

describe("GH_PR_MERGE_RE (scope gate — blocked commands)", () => {
  test("matches plain gh pr merge <number>", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 1011")).toBe(true)
  })

  test("matches gh pr merge --squash variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --squash")).toBe(true)
  })

  test("matches gh pr merge --rebase variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --rebase 2>&1")).toBe(true)
  })

  test("matches gh pr merge --merge variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --merge")).toBe(true)
  })

  test("matches gh pr merge --auto --squash variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --auto --squash")).toBe(true)
  })

  test("matches gh pr merge in && chain", () => {
    expect(GH_PR_MERGE_RE.test("git push origin feat/x && gh pr merge 42 --squash")).toBe(true)
  })

  test("matches gh pr merge after heredoc body assignment", () => {
    const command = [
      "body=$(cat <<'EOF'",
      "## Summary",
      "- sample",
      "EOF",
      ")",
      'gh pr create --body "$body"',
      "gh pr merge 1072 --squash",
    ].join("\n")
    expect(GH_PR_MERGE_RE.test(command)).toBe(true)
  })
})

describe("GH_PR_MERGE_RE (scope gate — allowed commands)", () => {
  test("does not match gh pr view", () => {
    expect(GH_PR_MERGE_RE.test("gh pr view 42")).toBe(false)
  })

  test("does not match gh pr list", () => {
    expect(GH_PR_MERGE_RE.test("gh pr list --state open")).toBe(false)
  })

  test("does not match gh pr create", () => {
    expect(GH_PR_MERGE_RE.test("gh pr create --base main")).toBe(false)
  })

  test("does not match gh pr checks", () => {
    expect(GH_PR_MERGE_RE.test("gh pr checks 42")).toBe(false)
  })

  test("does not match git push origin main", () => {
    expect(GH_PR_MERGE_RE.test("git push origin main")).toBe(false)
  })

  test("does not match echo containing gh pr merge text", () => {
    expect(GH_PR_MERGE_RE.test('echo "run gh pr merge to finish"')).toBe(false)
  })
})

describe("evaluatePretooluseMainBranchScopeGate (Pull Request merge state transitions)", () => {
  const TEST_REPO = "mherod/swiz"
  let testStore: ReturnType<typeof getIssueStore>
  let tempDbDir: string

  beforeAll(async () => {
    const hookModule = await import("../hooks/pretooluse-main-branch-scope-gate.ts")
    evaluatePretooluseMainBranchScopeGate = hookModule.evaluatePretooluseMainBranchScopeGate
    tempDbDir = join(
      tmpdir(),
      `swiz-scope-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(tempDbDir, { recursive: true })
    const dbPath = join(tempDbDir, "test.db")
    resetIssueStore()
    testStore = getIssueStore(dbPath)
  })

  afterAll(() => {
    testStore.close()
    resetIssueStore()
    try {
      rmSync(tempDbDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test("denies PR merge if PR has CONFLICTING mergeable status in database (Cache Fast-Path)", async () => {
    const prNumber = 123
    const headBranch = "feat/conflicting-change"

    testStore.upsertPullRequests(TEST_REPO, [
      {
        number: prNumber,
        title: "Conflicting PR",
        state: "OPEN",
        baseRefName: "main",
        headRefName: headBranch,
        updatedAt: new Date().toISOString(),
      },
    ])

    testStore.upsertPrBranchDetail(TEST_REPO, headBranch, {
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
      commentCount: 5,
    })

    const result = await evaluatePretooluseMainBranchScopeGate({
      tool_name: "Bash",
      tool_input: {
        command: `gh pr merge ${prNumber} --squash`,
        cwd: process.cwd(),
      },
      cwd: process.cwd(),
      transcript_path: "mock-transcript.jsonl",
    })
    const parsed = hookOutputSchema.parse(result)

    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain("CONFLICTING")
  })

  test("denies PR merge if PR has CHANGES_REQUESTED review decision (Cache Fast-Path)", async () => {
    const prNumber = 456
    const headBranch = "feat/needs-work"

    testStore.upsertPullRequests(TEST_REPO, [
      {
        number: prNumber,
        title: "Feedback PR",
        state: "OPEN",
        baseRefName: "main",
        headRefName: headBranch,
        updatedAt: new Date().toISOString(),
      },
    ])

    testStore.upsertPrBranchDetail(TEST_REPO, headBranch, {
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      commentCount: 2,
    })

    const result = await evaluatePretooluseMainBranchScopeGate({
      tool_name: "Bash",
      tool_input: {
        command: `gh pr merge ${prNumber} --merge`,
        cwd: process.cwd(),
      },
      cwd: process.cwd(),
      transcript_path: "mock-transcript.jsonl",
    })
    const parsed = hookOutputSchema.parse(result)

    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain("changes requested")
  })

  test("allows PR merge after daemon cache refresh clears stale CONFLICTING detail", async () => {
    const prNumber = 101
    const headBranch = "feat/refreshed-merge-state"

    testStore.upsertPullRequests(TEST_REPO, [
      {
        number: prNumber,
        title: "Refreshed PR",
        state: "OPEN",
        baseRefName: "main",
        headRefName: headBranch,
        updatedAt: new Date().toISOString(),
      },
    ])

    testStore.upsertPrBranchDetail(TEST_REPO, headBranch, {
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
      commentCount: 1,
    })

    const staleResult = await evaluatePretooluseMainBranchScopeGate({
      tool_name: "Bash",
      tool_input: {
        command: `gh pr merge ${prNumber} --squash`,
        cwd: process.cwd(),
      },
      cwd: process.cwd(),
      transcript_path: "mock-transcript.jsonl",
    })
    const staleParsed = hookOutputSchema.parse(staleResult)

    expect(staleParsed.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(staleParsed.hookSpecificOutput?.permissionDecisionReason).toContain("CONFLICTING")

    testStore.upsertPrBranchDetail(TEST_REPO, headBranch, {
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      commentCount: 1,
    })

    const result = await evaluatePretooluseMainBranchScopeGate({
      tool_name: "Bash",
      tool_input: {
        command: `gh pr merge ${prNumber} --squash`,
        cwd: process.cwd(),
      },
      cwd: process.cwd(),
      transcript_path: "mock-transcript.jsonl",
    })
    const parsed = hookOutputSchema.parse(result)

    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("allow")
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain(
      "approved-production-merge"
    )
  })
})

describe("extractPrNumber (used by scope gate for richer error messages)", () => {
  test("extracts PR number from gh pr merge <number>", () => {
    expect(extractPrNumber("gh pr merge 1011")).toBe("1011")
  })

  test("extracts PR number from gh pr merge <number> --squash", () => {
    expect(extractPrNumber("gh pr merge 42 --squash")).toBe("42")
  })

  test("extracts PR number from gh pr merge <number> --rebase", () => {
    expect(extractPrNumber("gh pr merge 99 --rebase 2>&1")).toBe("99")
  })

  test("returns null when no number present", () => {
    expect(extractPrNumber("gh pr merge --squash")).toBeNull()
  })
})
