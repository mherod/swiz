import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  createTestRepo,
  makeWorkflowHookRunner,
  skillLine,
  textLine,
  writeTranscript,
} from "../src/utils/test-utils.ts"

const runHook = makeWorkflowHookRunner("hooks/pretooluse-issue-workflow-gate.ts")

// ── Test repos ────────────────────────────────────────────────────────────────

const cleanupDirs: string[] = []

async function makeRepo(opts: { branch?: string } = {}): Promise<string> {
  const repo = await createTestRepo("https://github.com/test/repo.git", {
    featureBranch: opts.branch,
  })
  cleanupDirs.push(repo)
  return repo
}

async function makeTranscript(repo: string, lines: string[]): Promise<string> {
  const path = join(repo, "transcript.jsonl")
  await writeTranscript(path, lines)
  return path
}

// Helpers to generate Bash tool-use lines (prior commands already executed in session)
function bashLine(command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "b1",
          name: "Bash",
          input: { command, cwd: "/tmp" },
        },
      ],
    },
  })
}

afterAll(async () => {
  for (const dir of cleanupDirs) {
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pretooluse-issue-workflow-gate", () => {
  describe("when no work-on-issue skill is in the transcript", () => {
    test("allows Edit without skill", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [textLine("Working on something")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git commit without skill", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [textLine("Working on something")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'fix'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when in work-on-issue workflow but no preflight evidence", () => {
    test("blocks Edit before git fetch or gh activity", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("preflight required")
      expect(result.reason).toContain("git fetch")
    })

    test("blocks Write before preflight", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: repo, toolName: "Write", transcriptPath: tp })
      expect(result.decision).toBe("deny")
    })

    test("blocks git commit before preflight", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'wip'",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("preflight required")
    })

    test("blocks git rebase before preflight", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git rebase main",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
    })

    test("blocks git merge before preflight", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git merge develop",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
    })

    test("denial message names the next required command", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.reason).toContain("gh auth status")
      expect(result.reason).toContain("git fetch origin --prune")
    })
  })

  describe("discovery commands always allowed before preflight", () => {
    test("allows git fetch", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git fetch origin --prune",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows git status", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git status",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows git log", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git log --oneline -5",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows gh issue view", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh issue view 42 --json title,body",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows gh pr list", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh pr list --state open --search '#42'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows git checkout of existing branch (alignment)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout main",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows git checkout -b (branch creation)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout -b feat/issue-42",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when git fetch evidence is present (preflight satisfied)", () => {
    test("allows Edit after git fetch in transcript", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git commit after git fetch in transcript", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'feat: implement issue'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when gh activity evidence is present (preflight satisfied)", () => {
    test("allows Edit after gh issue view in transcript", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("gh issue view 42 --json title,body"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit after gh pr list in transcript", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("gh pr list --state open --search '#42'"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit after gh auth status in transcript", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("gh auth status"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when linked PR head branch is declared", () => {
    test("blocks Edit on main when PR head is feat/issue-42", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Found linked PR: #99 head=feat/issue-42 base=main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/issue-42")
      expect(result.reason).toContain("main")
    })

    test("blocks git commit when on wrong branch", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("head=feat/issue-42"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'fix'",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/issue-42")
    })

    test("denial message names checkout command and work-on-prs routing", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("head=feat/issue-42"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.reason).toContain("git checkout feat/issue-42")
      expect(result.reason).toContain("work-on-prs")
    })

    test("allows Edit when already on PR head branch", async () => {
      const repo = await makeRepo({ branch: "feat/issue-42" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("head=feat/issue-42"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when routed to work-on-prs", async () => {
      const repo = await makeRepo() // on main, not on PR branch
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("head=feat/issue-42"),
        skillLine("work-on-prs"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git checkout feat/issue-42 from main", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("head=feat/issue-42"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout feat/issue-42",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when target branch is declared but worktree is misaligned", () => {
    test("blocks Edit when on main but target branch is feat/issue-42", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: feat/issue-42\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/issue-42")
      expect(result.reason).toContain("main")
    })

    test("allows Edit when on the declared target branch", async () => {
      const repo = await makeRepo({ branch: "feat/issue-42" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: feat/issue-42\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when target branch has sentence punctuation", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: main.\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when target branch is wrapped in a code span", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: `main`.\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when remote target branch matches local branch", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: origin/main\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("ignores invalid target branch references instead of blocking", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: main..topic\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git checkout to target branch", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: feat/issue-42\nIntegration base: main"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout feat/issue-42",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("blocks git commit on unrelated branch after target declared", async () => {
      const repo = await makeRepo({ branch: "feat/unrelated" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("Target branch: feat/issue-42\nIntegration base: main"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'changes'",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/issue-42")
    })
  })

  describe("linked PR takes priority over target branch", () => {
    test("blocks for PR head when both PR head and target branch declared", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        bashLine("git fetch origin --prune"),
        textLine("head=feat/pr-99 base=main"),
        textLine("Target branch: feat/issue-42\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/pr-99")
    })
  })

  describe("when not in a git repo", () => {
    test("allows Edit outside git repo", async () => {
      const tmpDir = await Bun.$`mktemp -d`.text().then((s) => s.trim())
      cleanupDirs.push(tmpDir)
      const tp = join(tmpDir, "t.jsonl")
      await writeTranscript(tp, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: tmpDir, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when transcript_path is empty", () => {
    test("allows Edit when no transcript path provided", async () => {
      const repo = await makeRepo()
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: "" })
      expect(result.decision).toBeUndefined()
    })
  })
})
