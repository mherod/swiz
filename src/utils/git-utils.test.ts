import { describe, expect, test } from "bun:test"
import {
  BRANCH_CHECK_RE,
  CI_WAIT_RE,
  classifyChangeScope,
  collectCheckoutNewBranchNames,
  collectPlainCheckoutSwitchTargets,
  extractCheckoutBranch,
  extractCheckoutNewBranchName,
  extractCheckoutStartPoint,
  extractMergeBranch,
  extractOwnerFromUrl,
  extractPrNumber,
  extractSwitchBranch,
  FORCE_PUSH_RE,
  GH_CMD_RE,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GH_PR_MERGE_RE,
  GH_PR_REVIEW_DISMISS_RE,
  GIT_ANY_CMD_RE,
  GIT_CHECKOUT_NEW_BRANCH_RE,
  GIT_CHECKOUT_RE,
  GIT_COMMIT_RE,
  GIT_MERGE_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  GIT_READ_RE,
  GIT_SWITCH_RE,
  GIT_SYNC_RE,
  GIT_WRITE_RE,
  hasGitPushForceFlag,
  PR_CHECK_RE,
  parseGitStatSummary,
  parseGitStatus,
  parseGitStatusV2Output,
  READ_CMD_RE,
  RECOVERY_CMD_RE,
  SETUP_CMD_RE,
  SOURCE_EXT_RE,
  SWIZ_ISSUE_RE,
  TEST_FILE_RE,
} from "./git-utils.ts"

// ── parseGitStatusV2Output — upstreamGone detection ──────────────────────────
// These tests verify that a "gone" upstream (branch.upstream present but
// branch.ab absent) is correctly detected and does not get confused with
// a healthy upstream that happens to be at zero divergence.

describe("parseGitStatusV2Output — upstreamGone", () => {
  test("upstreamGone=true when branch.upstream present but branch.ab absent", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feat/my-feature",
      "# branch.upstream origin/feat/my-feature",
      // branch.ab is intentionally absent — upstream is gone
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(true)
    expect(result!.upstream).toBe("origin/feat/my-feature")
    expect(result!.ahead).toBe(0)
    expect(result!.behind).toBe(0)
    expect(result!.branch).toBe("feat/my-feature")
  })

  test("upstreamGone=false when both branch.upstream and branch.ab are present", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(false)
    expect(result!.upstream).toBe("origin/main")
    expect(result!.ahead).toBe(0)
    expect(result!.behind).toBe(0)
  })

  test("upstreamGone=false when upstream has diverged commits (+3 -1)", () => {
    const out = [
      "# branch.oid def456",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +3 -1",
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(false)
    expect(result!.ahead).toBe(3)
    expect(result!.behind).toBe(1)
  })

  test("upstreamGone=false when no upstream tracking branch at all", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head local-only",
      // no branch.upstream, no branch.ab
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(false)
    expect(result!.upstream).toBeNull()
    expect(result!.ahead).toBe(0)
    expect(result!.behind).toBe(0)
  })

  test("upstreamGone=true does not affect file change counts", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feat/gone",
      "# branch.upstream origin/feat/gone",
      // no branch.ab — upstream gone
      "1 .M N... 100644 100644 100644 hash1 hash2 src/foo.ts",
      "? untracked.txt",
    ].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.upstreamGone).toBe(true)
    expect(result!.total).toBe(2)
    expect(result!.modified).toBe(1)
    expect(result!.untracked).toBe(1)
  })

  test("detached HEAD with no upstream yields upstreamGone=false", () => {
    const out = ["# branch.oid abc123", "# branch.head (detached)"].join("\n")

    const result = parseGitStatusV2Output(out)
    expect(result).not.toBeNull()
    expect(result!.branch).toBe("(detached)")
    expect(result!.upstreamGone).toBe(false)
    expect(result!.upstream).toBeNull()
  })
})

describe("parseGitStatusV2Output — returns null for empty input", () => {
  test("returns null for empty string", () => {
    expect(parseGitStatusV2Output("")).toBeNull()
  })
})

// ── Git command regexes ─────────────────────────────────────────────────────

describe("GIT_PUSH_RE", () => {
  test("matches plain git push", () => {
    expect(GIT_PUSH_RE.test("git push")).toBe(true)
  })
  test("matches git push with global opts", () => {
    expect(GIT_PUSH_RE.test("git -C /path push origin main")).toBe(true)
  })
  test("does not match git pull", () => {
    expect(GIT_PUSH_RE.test("git pull")).toBe(false)
  })
  test("matches after semicolon", () => {
    expect(GIT_PUSH_RE.test("echo hi; git push")).toBe(true)
  })
})

describe("GIT_PUSH_DELETE_RE", () => {
  test("matches git push --delete", () => {
    expect(GIT_PUSH_DELETE_RE.test("git push --delete origin feat")).toBe(true)
  })
  test("matches git push origin :branch", () => {
    expect(GIT_PUSH_DELETE_RE.test("git push origin :old-branch")).toBe(true)
  })
  test("does not match plain git push", () => {
    expect(GIT_PUSH_DELETE_RE.test("git push origin main")).toBe(false)
  })
})

describe("GIT_COMMIT_RE", () => {
  test("matches git commit", () => {
    expect(GIT_COMMIT_RE.test('git commit -m "msg"')).toBe(true)
  })
  test("matches with global opts", () => {
    expect(GIT_COMMIT_RE.test('git -c user.name=x commit -m "msg"')).toBe(true)
  })
  test("does not match git push", () => {
    expect(GIT_COMMIT_RE.test("git push")).toBe(false)
  })
})

describe("GIT_READ_RE", () => {
  const readCmds = [
    "log",
    "status",
    "diff",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "rev-list",
    "reflog",
    "ls-files",
    "describe",
    "tag",
  ]
  for (const cmd of readCmds) {
    test(`matches git ${cmd}`, () => {
      expect(GIT_READ_RE.test(`git ${cmd}`)).toBe(true)
    })
  }
  test("does not match git push", () => {
    expect(GIT_READ_RE.test("git push")).toBe(false)
  })
  test("does not match git commit", () => {
    expect(GIT_READ_RE.test("git commit")).toBe(false)
  })
})

describe("GIT_WRITE_RE", () => {
  const writeCmds = [
    "add",
    "commit",
    "push",
    "pull",
    "fetch",
    "checkout",
    "switch",
    "restore",
    "reset",
    "rebase",
    "merge",
    "cherry-pick",
    "revert",
    "rm",
    "mv",
    "apply",
  ]
  for (const cmd of writeCmds) {
    test(`matches git ${cmd}`, () => {
      expect(GIT_WRITE_RE.test(`git ${cmd}`)).toBe(true)
    })
  }
  test("does not match git log", () => {
    expect(GIT_WRITE_RE.test("git log")).toBe(false)
  })
  test("matches stash push but not stash list", () => {
    expect(GIT_WRITE_RE.test("git stash push")).toBe(true)
    expect(GIT_WRITE_RE.test("git stash list")).toBe(false)
  })
})

describe("GIT_SYNC_RE", () => {
  test("matches push, pull, fetch", () => {
    expect(GIT_SYNC_RE.test("git push")).toBe(true)
    expect(GIT_SYNC_RE.test("git pull")).toBe(true)
    expect(GIT_SYNC_RE.test("git fetch")).toBe(true)
  })
  test("does not match git commit", () => {
    expect(GIT_SYNC_RE.test("git commit")).toBe(false)
  })
})

describe("GIT_MERGE_RE", () => {
  test("matches git merge", () => {
    expect(GIT_MERGE_RE.test("git merge feat")).toBe(true)
  })
  test("does not match git push", () => {
    expect(GIT_MERGE_RE.test("git push")).toBe(false)
  })
})

describe("GH_PR_MERGE_RE", () => {
  test("matches gh pr merge", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 123")).toBe(true)
  })
  test("does not match gh pr create", () => {
    expect(GH_PR_MERGE_RE.test("gh pr create")).toBe(false)
  })
})

describe("GH_PR_CREATE_RE", () => {
  test("matches gh pr create", () => {
    expect(GH_PR_CREATE_RE.test("gh pr create --title x")).toBe(true)
  })
  test("does not match gh pr merge", () => {
    expect(GH_PR_CREATE_RE.test("gh pr merge")).toBe(false)
  })
})

describe("GIT_CHECKOUT_RE", () => {
  test("matches git checkout", () => {
    expect(GIT_CHECKOUT_RE.test("git checkout main")).toBe(true)
  })
  test("matches with global opts", () => {
    expect(GIT_CHECKOUT_RE.test("git -C /dir checkout main")).toBe(true)
  })
})

describe("GIT_SWITCH_RE", () => {
  test("matches git switch", () => {
    expect(GIT_SWITCH_RE.test("git switch feat")).toBe(true)
  })
  test("does not match git checkout", () => {
    expect(GIT_SWITCH_RE.test("git checkout main")).toBe(false)
  })
})

describe("GH_PR_CHECKOUT_RE", () => {
  test("matches gh pr checkout", () => {
    expect(GH_PR_CHECKOUT_RE.test("gh pr checkout 42")).toBe(true)
  })
})

describe("GH_PR_REVIEW_DISMISS_RE", () => {
  test("matches gh pr review --dismiss", () => {
    expect(GH_PR_REVIEW_DISMISS_RE.test("gh pr review 5 --dismiss")).toBe(true)
  })
  test("does not match gh pr review without dismiss", () => {
    expect(GH_PR_REVIEW_DISMISS_RE.test("gh pr review 5 --approve")).toBe(false)
  })
})

describe("GIT_CHECKOUT_NEW_BRANCH_RE", () => {
  test("matches checkout -b", () => {
    expect(GIT_CHECKOUT_NEW_BRANCH_RE.test("git checkout -b feat")).toBe(true)
  })
  test("matches switch -c", () => {
    expect(GIT_CHECKOUT_NEW_BRANCH_RE.test("git switch -c feat")).toBe(true)
  })
  test("does not match plain checkout", () => {
    expect(GIT_CHECKOUT_NEW_BRANCH_RE.test("git checkout main")).toBe(false)
  })
})

describe("GIT_ANY_CMD_RE", () => {
  test("matches any git command", () => {
    expect(GIT_ANY_CMD_RE.test("git status")).toBe(true)
    expect(GIT_ANY_CMD_RE.test("git push")).toBe(true)
  })
  test("does not match gh", () => {
    expect(GIT_ANY_CMD_RE.test("gh pr list")).toBe(false)
  })
})

describe("FORCE_PUSH_RE", () => {
  test("matches --force", () => {
    expect(FORCE_PUSH_RE.test("git push --force")).toBe(true)
  })
  test("matches --force-with-lease", () => {
    expect(FORCE_PUSH_RE.test("git push --force-with-lease")).toBe(true)
  })
  test("matches -f", () => {
    expect(FORCE_PUSH_RE.test("git push -f")).toBe(true)
  })
  test("does not match plain push", () => {
    expect(FORCE_PUSH_RE.test("git push origin main")).toBe(false)
  })
})

describe("READ_CMD_RE", () => {
  test("matches ls, rg, grep", () => {
    expect(READ_CMD_RE.test("ls -la")).toBe(true)
    expect(READ_CMD_RE.test("rg pattern")).toBe(true)
    expect(READ_CMD_RE.test("grep -r foo")).toBe(true)
  })
})

describe("RECOVERY_CMD_RE", () => {
  test("matches ps, lsof, trash, wc", () => {
    expect(RECOVERY_CMD_RE.test("ps aux")).toBe(true)
    expect(RECOVERY_CMD_RE.test("lsof -i")).toBe(true)
    expect(RECOVERY_CMD_RE.test("trash file")).toBe(true)
    expect(RECOVERY_CMD_RE.test("wc -l")).toBe(true)
  })
})

describe("SETUP_CMD_RE", () => {
  test("matches npm install", () => {
    expect(SETUP_CMD_RE.test("npm install")).toBe(true)
  })
  test("matches pnpm run lint", () => {
    expect(SETUP_CMD_RE.test("pnpm run lint")).toBe(true)
  })
  test("matches bun test", () => {
    expect(SETUP_CMD_RE.test("bun test")).toBe(true)
  })
  test("matches npx eslint", () => {
    expect(SETUP_CMD_RE.test("npx eslint")).toBe(true)
  })
})

describe("GH_CMD_RE", () => {
  test("matches gh commands", () => {
    expect(GH_CMD_RE.test("gh pr list")).toBe(true)
    expect(GH_CMD_RE.test("gh issue create")).toBe(true)
  })
})

describe("SWIZ_ISSUE_RE", () => {
  test("matches swiz issue close", () => {
    expect(SWIZ_ISSUE_RE.test("swiz issue close 1")).toBe(true)
  })
  test("matches swiz issue comment", () => {
    expect(SWIZ_ISSUE_RE.test("swiz issue comment 1")).toBe(true)
  })
  test("does not match swiz issue list", () => {
    expect(SWIZ_ISSUE_RE.test("swiz issue list")).toBe(false)
  })
})

describe("CI_WAIT_RE", () => {
  test("matches swiz ci-wait", () => {
    expect(CI_WAIT_RE.test("swiz ci-wait abc123")).toBe(true)
  })
  test("matches bun ci-wait", () => {
    expect(CI_WAIT_RE.test("bun run index.ts ci-wait abc")).toBe(true)
  })
})

describe("BRANCH_CHECK_RE", () => {
  test("matches git branch --show-current", () => {
    expect(BRANCH_CHECK_RE.test("git branch --show-current")).toBe(true)
  })
  test("does not match git branch -a", () => {
    expect(BRANCH_CHECK_RE.test("git branch -a")).toBe(false)
  })
})

describe("PR_CHECK_RE", () => {
  test("matches gh pr list --head", () => {
    expect(PR_CHECK_RE.test("gh pr list --head feat")).toBe(true)
  })
  test("does not match gh pr list without --head", () => {
    expect(PR_CHECK_RE.test("gh pr list")).toBe(false)
  })
})

describe("SOURCE_EXT_RE", () => {
  test("matches common source extensions", () => {
    for (const ext of ["ts", "tsx", "js", "jsx", "py", "go", "rs", "swift", "java"]) {
      expect(SOURCE_EXT_RE.test(`file.${ext}`)).toBe(true)
    }
  })
  test("does not match .md or .json", () => {
    expect(SOURCE_EXT_RE.test("file.md")).toBe(false)
    expect(SOURCE_EXT_RE.test("file.json")).toBe(false)
  })
})

describe("TEST_FILE_RE", () => {
  test("matches test files", () => {
    expect(TEST_FILE_RE.test("foo.test.ts")).toBe(true)
    expect(TEST_FILE_RE.test("foo.spec.ts")).toBe(true)
    expect(TEST_FILE_RE.test("__tests__/foo.ts")).toBe(true)
    expect(TEST_FILE_RE.test("/test/foo.ts")).toBe(true)
  })
  test("does not match regular source files", () => {
    expect(TEST_FILE_RE.test("src/foo.ts")).toBe(false)
  })
})

// ── Extractor functions ─────────────────────────────────────────────────────

describe("extractPrNumber", () => {
  test("extracts PR number from gh pr merge", () => {
    expect(extractPrNumber("gh pr merge 42")).toBe("42")
  })
  test("returns null for non-matching", () => {
    expect(extractPrNumber("gh pr create")).toBeNull()
  })
})

describe("extractMergeBranch", () => {
  test("extracts branch from git merge", () => {
    expect(extractMergeBranch("git merge feat/login")).toBe("feat/login")
  })
  test("extracts branch with global opts", () => {
    expect(extractMergeBranch("git -C /dir merge feat")).toBe("feat")
  })
  test("skips flags", () => {
    expect(extractMergeBranch("git merge --no-ff feat")).toBe("feat")
  })
  test("returns null for no branch", () => {
    expect(extractMergeBranch("git merge")).toBeNull()
  })
  test("returns null if branch starts with -", () => {
    expect(extractMergeBranch("git merge -")).toBeNull()
  })
})

describe("extractCheckoutBranch", () => {
  test("extracts branch from git checkout", () => {
    expect(extractCheckoutBranch("git checkout main")).toBe("main")
  })
  test("ignores -b form", () => {
    expect(extractCheckoutBranch("git checkout -b new")).toBeNull()
  })
  test("returns null for no branch", () => {
    expect(extractCheckoutBranch("echo hi")).toBeNull()
  })
})

describe("extractSwitchBranch", () => {
  test("extracts branch from git switch", () => {
    expect(extractSwitchBranch("git switch feat")).toBe("feat")
  })
  test("ignores -c form", () => {
    expect(extractSwitchBranch("git switch -c new")).toBeNull()
  })
})

describe("extractCheckoutStartPoint", () => {
  test("extracts start point from checkout -b", () => {
    expect(extractCheckoutStartPoint("git checkout -b feat origin/main")).toBe("origin/main")
  })
  test("extracts start point from switch -c", () => {
    expect(extractCheckoutStartPoint("git switch -c feat origin/main")).toBe("origin/main")
  })
  test("returns null when no start point", () => {
    expect(extractCheckoutStartPoint("git checkout -b feat")).toBeNull()
  })
  test("returns null for non-matching", () => {
    expect(extractCheckoutStartPoint("git push")).toBeNull()
  })
})

describe("extractCheckoutNewBranchName", () => {
  test("extracts new branch from checkout -b", () => {
    expect(extractCheckoutNewBranchName("git checkout -b feat/new")).toBe("feat/new")
  })
  test("extracts new branch from switch -c", () => {
    expect(extractCheckoutNewBranchName("git switch -c feat/new")).toBe("feat/new")
  })
  test("returns null for plain checkout", () => {
    expect(extractCheckoutNewBranchName("git checkout main")).toBeNull()
  })
})

describe("collectCheckoutNewBranchNames", () => {
  test("collects multiple new branches from compound command", () => {
    const cmd = "git checkout -b a && git switch -c b"
    expect(collectCheckoutNewBranchNames(cmd)).toEqual(["a", "b"])
  })
  test("returns empty for no matches", () => {
    expect(collectCheckoutNewBranchNames("git push")).toEqual([])
  })
})

describe("collectPlainCheckoutSwitchTargets", () => {
  test("collects checkout and switch targets", () => {
    const cmd = "git checkout main && git switch dev"
    expect(collectPlainCheckoutSwitchTargets(cmd)).toEqual(["main", "dev"])
  })
  test("excludes -b/-c forms", () => {
    const cmd = "git checkout -b feat && git switch main"
    expect(collectPlainCheckoutSwitchTargets(cmd)).toEqual(["main"])
  })
})

// ── hasGitPushForceFlag (token-based) ───────────────────────────────────────

describe("hasGitPushForceFlag", () => {
  test("detects --force", () => {
    expect(hasGitPushForceFlag("git push --force")).toBe(true)
  })
  test("detects -f", () => {
    expect(hasGitPushForceFlag("git push -f")).toBe(true)
  })
  test("detects --force-with-lease", () => {
    expect(hasGitPushForceFlag("git push --force-with-lease")).toBe(true)
  })
  test("detects --force-if-includes", () => {
    expect(hasGitPushForceFlag("git push --force-if-includes")).toBe(true)
  })
  test("does not detect --force after -- (refspec)", () => {
    expect(hasGitPushForceFlag("git push -- --force")).toBe(false)
  })
  test("handles -C global opt", () => {
    expect(hasGitPushForceFlag("git -C /path push -f")).toBe(true)
  })
  test("plain push is not force", () => {
    expect(hasGitPushForceFlag("git push origin main")).toBe(false)
  })
  test("handles compound commands", () => {
    expect(hasGitPushForceFlag("echo hi && git push --force")).toBe(true)
  })
})

// ── extractOwnerFromUrl ─────────────────────────────────────────────────────

describe("extractOwnerFromUrl", () => {
  test("extracts owner from SSH URL", () => {
    expect(extractOwnerFromUrl("git@github.com:owner/repo.git")).toBe("owner")
  })
  test("extracts owner from HTTPS URL", () => {
    expect(extractOwnerFromUrl("https://github.com/owner/repo.git")).toBe("owner")
  })
  test("returns null for non-GitHub URL", () => {
    expect(extractOwnerFromUrl("https://gitlab.com/owner/repo")).toBeNull()
  })
})

// ── parseGitStatus ──────────────────────────────────────────────────────────

describe("parseGitStatus", () => {
  test("parses porcelain output", () => {
    const result = parseGitStatus(" M file.ts\nA  new.ts\nD  old.ts\n?? untracked.ts")
    expect(result.total).toBe(4)
    expect(result.modified).toBe(1)
    expect(result.added).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.untracked).toBe(1)
  })
  test("handles empty output", () => {
    const result = parseGitStatus("")
    expect(result.total).toBe(0)
  })
})

// ── parseGitStatSummary ─────────────────────────────────────────────────────

describe("parseGitStatSummary", () => {
  test("parses full summary line", () => {
    const result = parseGitStatSummary(" 3 files changed, 10 insertions(+), 5 deletions(-)")
    expect(result.filesChanged).toBe(3)
    expect(result.insertions).toBe(10)
    expect(result.deletions).toBe(5)
  })
  test("handles insertions only", () => {
    const result = parseGitStatSummary(" 1 file changed, 5 insertions(+)")
    expect(result.filesChanged).toBe(1)
    expect(result.insertions).toBe(5)
    expect(result.deletions).toBe(0)
  })
  test("handles deletions only", () => {
    const result = parseGitStatSummary(" 2 files changed, 3 deletions(-)")
    expect(result.filesChanged).toBe(2)
    expect(result.insertions).toBe(0)
    expect(result.deletions).toBe(3)
  })
  test("returns zeros for empty input", () => {
    const result = parseGitStatSummary("")
    expect(result).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
})

// ── classifyChangeScope ─────────────────────────────────────────────────────

describe("classifyChangeScope", () => {
  test("docs-only when all files are docs/config", () => {
    const result = classifyChangeScope({ filesChanged: 2, insertions: 5, deletions: 3 }, [
      "README.md",
      "config.json",
    ])
    expect(result.isDocsOnly).toBe(true)
  })
  test("trivial for small non-src changes", () => {
    const result = classifyChangeScope({ filesChanged: 1, insertions: 3, deletions: 2 }, [
      ".eslintrc.js",
    ])
    expect(result.isTrivial).toBe(true)
    expect(result.isSmallFix).toBe(true)
  })
  test("not trivial when src/ files involved", () => {
    const result = classifyChangeScope({ filesChanged: 1, insertions: 3, deletions: 2 }, [
      "src/utils.ts",
    ])
    expect(result.isTrivial).toBe(false)
  })
  test("statParsingFailed when files exist but stat shows 0", () => {
    const result = classifyChangeScope({ filesChanged: 0, insertions: 0, deletions: 0 }, [
      "src/foo.ts",
    ])
    expect(result.statParsingFailed).toBe(true)
    expect(result.isTrivial).toBe(false)
  })
  test("small-fix for ≤2 files and ≤30 lines", () => {
    const result = classifyChangeScope({ filesChanged: 2, insertions: 15, deletions: 10 }, [
      "src/a.ts",
      "src/b.ts",
    ])
    expect(result.isSmallFix).toBe(true)
  })
})

// ── buildGitContextLine ─────────────────────────────────────────────────────

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

import { buildGitContextLine, type GitStatusV2 } from "./git-utils.ts"

describe("buildGitContextLine", () => {
  test("includes branch name", () => {
    const result = buildGitContextLine(makeStatus({ branch: "feat/foo" }))
    expect(result).toContain("[git] branch: feat/foo")
  })

  test("includes upstream ref when available", () => {
    const result = buildGitContextLine(makeStatus({ upstream: "origin/main" }))
    expect(result).toContain("upstream: origin/main")
    expect(result).not.toContain("no upstream")
    expect(result).not.toContain("(gone)")
  })

  test("shows no upstream when upstream is null", () => {
    const result = buildGitContextLine(makeStatus({ upstream: null }))
    expect(result).toContain("no upstream")
  })

  test("shows gone upstream", () => {
    const result = buildGitContextLine(
      makeStatus({ upstream: "origin/deleted-branch", upstreamGone: true })
    )
    expect(result).toContain("upstream: origin/deleted-branch (gone)")
  })

  test("includes uncommitted file count", () => {
    const result = buildGitContextLine(makeStatus({ total: 3 }))
    expect(result).toContain("uncommitted files: 3")
  })

  test("shows clean state with zero uncommitted", () => {
    const result = buildGitContextLine(makeStatus({ total: 0 }))
    expect(result).toContain("uncommitted files: 0")
  })

  test("shows ahead count as unpushed commits", () => {
    const result = buildGitContextLine(makeStatus({ ahead: 2 }))
    expect(result).toContain("2 unpushed commit(s)")
  })

  test("shows behind count", () => {
    const result = buildGitContextLine(makeStatus({ behind: 5 }))
    expect(result).toContain("5 behind remote")
  })

  test("shows diverged when both ahead and behind", () => {
    const result = buildGitContextLine(makeStatus({ ahead: 3, behind: 2 }))
    expect(result).toContain("diverged: 3 ahead, 2 behind")
  })

  test("omits ahead/behind when both zero", () => {
    const result = buildGitContextLine(makeStatus({ ahead: 0, behind: 0 }))
    expect(result).not.toContain("unpushed")
    expect(result).not.toContain("behind")
    expect(result).not.toContain("diverged")
  })

  test("omits collab mode when auto", () => {
    const result = buildGitContextLine(makeStatus(), "auto")
    expect(result).not.toContain("collab:")
  })

  test("includes collab mode when not auto", () => {
    const result = buildGitContextLine(makeStatus(), "solo")
    expect(result).toContain("collab: solo")
  })

  test("combines all fields for a full status line", () => {
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
