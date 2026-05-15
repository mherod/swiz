import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  createTestRepo,
  makeWorkflowHookRunner,
  skillLine,
  textLine,
  writeTranscript,
} from "../src/utils/test-utils.ts"

const runHook = makeWorkflowHookRunner("hooks/pretooluse-branch-intent-gate.ts")

// ── Test repos and transcripts ────────────────────────────────────────────────

const cleanupDirs: string[] = []

async function makeRepo(): Promise<string> {
  const repo = await createTestRepo("https://github.com/test/repo.git")
  cleanupDirs.push(repo)
  return repo
}

async function makeTranscript(repo: string, lines: string[]): Promise<string> {
  const path = join(repo, "transcript.jsonl")
  await writeTranscript(path, lines)
  return path
}

afterAll(async () => {
  for (const dir of cleanupDirs) {
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pretooluse-branch-intent-gate", () => {
  describe("when no workflow skill is in the transcript", () => {
    test("allows Edit without any declarations", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        textLine("Working on some feature"),
        textLine("target branch: feat/abc\nintegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Bash branch-create without any declarations", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [textLine("Let me create a branch")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout -b feat/no-skill",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when work-on-issue skill is active but branches not declared", () => {
    test("blocks Edit", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Branch intent not declared")
      expect(result.reason).toContain("target branch")
      expect(result.reason).toContain("integration base")
    })

    test("blocks Write", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: repo, toolName: "Write", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Branch intent not declared")
    })

    test("blocks Bash branch-create (git checkout -b)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout -b feat/issue-42",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Branch intent not declared")
    })

    test("blocks Bash branch-create (git checkout -B)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout -B fix/reset-branch",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
    })

    test("blocks Bash branch-create (git branch <name>)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git branch feat/new",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
    })

    test("denial message includes next-action steps", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.reason).toContain("existing-work check")
      expect(result.reason).toContain("TaskUpdate")
    })
  })

  describe("when work-on-prs skill is active but branches not declared", () => {
    test("blocks Edit", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-prs")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Branch intent not declared")
    })
  })

  describe("when both branches are declared in the transcript", () => {
    test("allows Edit after trunk-based declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine("Target branch: feat/issue-42\nIntegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Write after trunk-based declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine("target branch: feat/my-work\nintegration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Write", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit after git-flow declaration (integration base: develop)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine(
          "Branch model handoff:\n- Likely integration base: develop\n- target branch: feat/issue-608"
        ),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit after PR branch declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("Target branch: fix/auth-flow\nIntegration base: main (PR base)"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit after release branch declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine("Target branch: fix/hotfix-1.2\nIntegration base: release/1.2"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Bash branch-create after declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine("target branch: feat/issue-100\nintegration base: main"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout -b feat/issue-100",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("discovery commands are always allowed", () => {
    test("allows git status without declaration", async () => {
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

    test("allows git fetch without declaration", async () => {
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

    test("allows git log without declaration", async () => {
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

    test("allows git branch listing without declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git branch -r --list '*issue*'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows gh issue view without declaration", async () => {
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

    test("allows gh pr list without declaration", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-issue")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh pr list --state open --head feat/issue-42",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows git checkout of existing branch (alignment) without declaration", async () => {
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
  })

  describe("when not in a git repo", () => {
    test("allows Edit outside git repo without checking transcript", async () => {
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

  describe("partial declarations", () => {
    test("blocks when only target branch is declared", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine("target branch: feat/issue-42"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
    })

    test("blocks when only integration base is declared", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-issue"),
        textLine("integration base: main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
    })
  })
})
