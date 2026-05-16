import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  createTestRepo,
  makeWorkflowHookRunner,
  skillLine,
  textLine,
  writeTranscript,
} from "../src/utils/test-utils.ts"

const runHook = makeWorkflowHookRunner("hooks/pretooluse-pr-head-checkout-gate.ts")

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

afterAll(async () => {
  for (const dir of cleanupDirs) {
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pretooluse-pr-head-checkout-gate", () => {
  describe("when no work-on-prs skill is in the transcript", () => {
    test("allows Edit without skill", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [textLine("head=feat/pr-609")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git commit without skill", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [textLine("head=feat/pr-609")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'fix'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when in work-on-prs workflow but no head branch declared", () => {
    test("allows Edit (fail-open — head not yet known)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-prs")])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git commit (fail-open)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [skillLine("work-on-prs")])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'fix'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("when starting from main (not PR head branch)", () => {
    test("blocks Edit when head=feat/pr-609 declared", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("Existing related PR: #609 head=feat/pr-609 base=main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/pr-609")
      expect(result.reason).toContain("main")
    })

    test("blocks Write", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Write", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/pr-609")
    })

    test("blocks git commit", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'address review feedback'",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/pr-609")
    })

    test("blocks git rebase", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git rebase main",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
    })

    test("blocks git merge", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git merge main",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
    })

    test("blocks gh pr view --comments (feedback inspection)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh pr view 609 --comments",
        transcriptPath: tp,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/pr-609")
    })

    test("denial message names the checkout command", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.reason).toContain("git checkout feat/pr-609")
    })
  })

  describe("when starting from dev/develop", () => {
    test("blocks Edit when on dev branch", async () => {
      const repo = await makeRepo({ branch: "dev" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("dev")
    })

    test("blocks Edit when on develop branch", async () => {
      const repo = await makeRepo({ branch: "develop" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
    })
  })

  describe("when starting from an unrelated feature branch", () => {
    test("blocks Edit when on unrelated branch", async () => {
      const repo = await makeRepo({ branch: "feat/unrelated" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/unrelated")
    })
  })

  describe("when already on the PR head branch", () => {
    test("allows Edit when on feat/pr-609", async () => {
      const repo = await makeRepo({ branch: "feat/pr-609" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when declared PR head has sentence punctuation", async () => {
      const repo = await makeRepo({ branch: "feat/pr-609" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("Existing related PR: #609 head=feat/pr-609. base=main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when declared PR head is a remote branch reference", async () => {
      const repo = await makeRepo({ branch: "feat/pr-609" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("Existing related PR: #609 head=origin/feat/pr-609 base=main"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBeUndefined()
    })

    test("allows git commit when on PR head branch", async () => {
      const repo = await makeRepo({ branch: "feat/pr-609" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git commit -m 'fix review'",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows gh pr view --comments when on PR head branch", async () => {
      const repo = await makeRepo({ branch: "feat/pr-609" })
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh pr view 609 --comments",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("checkout to PR head branch is always allowed", () => {
    test("allows git checkout feat/pr-609 from main", async () => {
      const repo = await makeRepo() // on main
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git checkout feat/pr-609",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows git switch feat/pr-609 from main", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git switch feat/pr-609",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("discovery commands are always allowed before alignment", () => {
    test("allows git fetch", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
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
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
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
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "git log --oneline -5",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows gh pr view (without --comments)", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh pr view 609 --json headRefName,baseRefName",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows gh pr list", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("head=feat/pr-609"),
      ])
      const result = await runHook({
        cwd: repo,
        toolName: "Bash",
        command: "gh pr list --state open",
        transcriptPath: tp,
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("head branch extraction patterns", () => {
    test("extracts from 'head branch: <name>' pattern", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine("The head branch: feat/pr-609 has 3 commits"),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("feat/pr-609")
    })

    test("extracts from standup handoff 'head=<name> base=<name>'", async () => {
      const repo = await makeRepo()
      const tp = await makeTranscript(repo, [
        skillLine("work-on-prs"),
        textLine(
          "Existing related PR: #522 head=improve/skill-review-optimization base=main url=https://github.com/mherod/swiz/pull/522"
        ),
      ])
      const result = await runHook({ cwd: repo, toolName: "Edit", transcriptPath: tp })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("improve/skill-review-optimization")
    })
  })

  describe("when not in a git repo", () => {
    test("allows Edit outside git repo", async () => {
      const tmpDir = await Bun.$`mktemp -d`.text().then((s) => s.trim())
      cleanupDirs.push(tmpDir)
      const tp = join(tmpDir, "t.jsonl")
      await writeTranscript(tp, [skillLine("work-on-prs"), textLine("head=feat/pr-609")])
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
