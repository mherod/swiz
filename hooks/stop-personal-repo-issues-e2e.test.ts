/**
 * End-to-end fixture-based tests for stop-personal-repo-issues.ts.
 *
 * Strategy: spawn the hook as a real subprocess, intercept all `gh` CLI calls
 * with a bun-based mock binary placed first in PATH, and feed real-world-style
 * issue/PR payloads from environment variables.  Git repos get a GitHub remote
 * so the hook's early-exit guards all pass.
 *
 * Each fixture set is modelled on the ramp3-spike label taxonomy we surveyed,
 * but kept self-contained so the tests never hit the network.
 */
import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { useTempDir } from "./test-utils.ts"

// ─── Infrastructure ───────────────────────────────────────────────────────────

const HOOK_PATH = resolve(process.cwd(), "hooks/stop-personal-repo-issues.ts")

const tmp = useTempDir()

async function createTempDir(suffix = ""): Promise<string> {
  return tmp.create(`swiz-issues-e2e${suffix}-`)
}

/**
 * Create a git repo with a GitHub remote so isGitRepo / isGitHubRemote pass.
 * `owner` controls whether the repo looks personal (owner === currentUser) or org.
 */
async function createGitRepoWithGitHubRemote(
  suffix: string,
  owner = "testowner",
  repo = "testrepo"
): Promise<string> {
  const dir = await createTempDir(suffix)
  const run = (args: string[]) => Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" })
  run(["git", "init"])
  run(["git", "config", "user.email", "test@test.com"])
  run(["git", "config", "user.name", "Test"])
  run(["git", "commit", "--allow-empty", "-m", "init"])
  run(["git", "remote", "add", "origin", `git@github.com:${owner}/${repo}.git`])
  return dir
}

/**
 * Write a mock `gh` bun script into `binDir/gh` that serves fixture responses
 * from environment variables:
 *   GH_MOCK_USER    — login string returned by `gh api user --jq .login`
 *   GH_MOCK_PRS     — JSON array for `gh pr list` (already-filtered)
 *   GH_MOCK_ISSUES  — JSON array for `gh issue list`
 */
async function writeMockGh(binDir: string): Promise<void> {
  const script = `#!/usr/bin/env bun
const args = process.argv.slice(2).join(" ")
if (args.includes("api") && args.includes("user")) {
  process.stdout.write(process.env.GH_MOCK_USER ?? "testuser")
} else if (args.includes("pr") && args.includes("list")) {
  process.stdout.write(process.env.GH_MOCK_PRS ?? "[]")
} else if (args.includes("issue") && args.includes("list")) {
  process.stdout.write(process.env.GH_MOCK_ISSUES ?? "[]")
}
process.exit(0)
`
  const ghPath = join(binDir, "gh")
  await writeFile(ghPath, script, { mode: 0o755 })
}

interface HookResult {
  blocked: boolean
  reason?: string
  raw: string
}

interface RunOptions {
  /** current user login returned by the mock gh */
  user?: string
  /** already-filtered PR array (CHANGES_REQUESTED / REVIEW_REQUIRED only) */
  prs?: object[]
  /** full open issue list returned by the mock gh */
  issues?: object[]
}

/**
 * Run the hook against `repoDir` with mock gh fixtures injected via PATH.
 */
async function runHook(repoDir: string, opts: RunOptions = {}): Promise<HookResult> {
  const { user = "testuser", prs = [], issues = [] } = opts

  const binDir = await createTempDir("-bin")
  await writeMockGh(binDir)

  const payload = JSON.stringify({ cwd: repoDir, session_id: "e2e-test" })

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GH_MOCK_USER: user,
      GH_MOCK_PRS: JSON.stringify(prs),
      GH_MOCK_ISSUES: JSON.stringify(issues),
    },
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const raw = await new Response(proc.stdout).text()
  await proc.exited

  const trimmed = raw.trim()
  if (!trimmed) return { blocked: false, raw: trimmed }
  const parsed = JSON.parse(trimmed)
  return { blocked: parsed.decision === "block", reason: parsed.reason, raw: trimmed }
}

// ─── Fixture data ─────────────────────────────────────────────────────────────

/** Minimal issue factory matching the hook's Issue interface. */
function makeIssue(
  number: number,
  title: string,
  labels: string[],
  opts: { authorLogin?: string; assigneeLogins?: string[] } = {}
) {
  return {
    number,
    title,
    labels: labels.map((name) => ({ name })),
    author: { login: opts.authorLogin ?? "testuser" },
    assignees: (opts.assigneeLogins ?? []).map((login) => ({ login })),
  }
}

/** Minimal PR factory. */
function makePR(
  number: number,
  title: string,
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED",
  opts: { createdAt?: string; mergeable?: "CONFLICTING" | "MERGEABLE" | "UNKNOWN" } = {}
) {
  return {
    number,
    title,
    url: `https://github.com/testowner/testrepo/pull/${number}`,
    reviewDecision,
    mergeable: opts.mergeable ?? "MERGEABLE",
    createdAt: opts.createdAt,
  }
}

// Realistic ramp3-spike-style issue backlog (8 issues, varied priority)
const RAMP3_ISSUES = [
  makeIssue(935, "fix(captiv8): ensure MongoDB connection before sync", [
    "bug",
    "backend",
    "priority:high",
  ]),
  makeIssue(934, "Redesign /admin/campaigns for campaign management", ["feature", "frontend"]),
  makeIssue(933, "Apply useOptimistic to URL-synced filter controls", [
    "feature",
    "frontend",
    "area:dashboard",
  ]),
  makeIssue(878, "Refactor /admin/settings to remove redundant fields", [
    "maintenance",
    "tech-debt",
    "backend",
    "frontend",
  ]),
  makeIssue(859, "fix(stats): align metric labels with Meta Views unification", [
    "bug",
    "backend",
    "frontend",
    "area:stats",
    "ready",
    "priority:high",
  ]),
  makeIssue(756, "Remove entity_type filtering — all entities are brands", [
    "tech-debt",
    "backend",
    "frontend",
  ]),
  makeIssue(569, "Split monolithic functions/src/index.ts into modules", [
    "maintenance",
    "tech-debt",
    "backend",
    "priority:high",
    "ready",
  ]),
  makeIssue(492, "Move business logic from route to handler", [
    "maintenance",
    "tech-debt",
    "backend",
    "priority:medium",
    "ready",
  ]),
]

// ─── Early-exit guards ────────────────────────────────────────────────────────

describe("E2E stop-personal-repo-issues: early-exit guards", () => {
  test("non-git directory exits silently", async () => {
    const dir = await createTempDir("-nogit")
    const binDir = await createTempDir("-bin")
    await writeMockGh(binDir)
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    })
    proc.stdin.write(JSON.stringify({ cwd: dir, session_id: "test" }))
    proc.stdin.end()
    const raw = await new Response(proc.stdout).text()
    await proc.exited
    expect(raw.trim()).toBe("")
  })

  test("git repo without GitHub remote exits silently", async () => {
    const dir = await createTempDir("-nohub")
    Bun.spawnSync(["git", "init"], { cwd: dir })
    Bun.spawnSync(["git", "config", "user.email", "t@t.com"], { cwd: dir })
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: dir })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
    Bun.spawnSync(["git", "remote", "add", "origin", "https://gitlab.com/org/repo.git"], {
      cwd: dir,
    })
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
    expect(result.raw).toBe("")
  })

  test("GitHub repo with no open issues or PRs exits silently", async () => {
    const dir = await createGitRepoWithGitHubRemote("-clean", "testuser", "myrepo")
    const result = await runHook(dir, { user: "testuser", prs: [], issues: [] })
    expect(result.blocked).toBe(false)
    expect(result.raw).toBe("")
  })
})

// ─── Personal repo — issue blocking ──────────────────────────────────────────

describe("E2E stop-personal-repo-issues: personal repo issue blocking", () => {
  test("single actionable issue blocks stop with issue number and title", async () => {
    const dir = await createGitRepoWithGitHubRemote("-single", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(42, "Fix login redirect bug", ["bug", "priority:high"])],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("#42")
    expect(result.reason).toContain("Fix login redirect bug")
  })

  test("open-issue stop block omits memory-capture advice", async () => {
    const dir = await createGitRepoWithGitHubRemote("-nomemoryfooter", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(67, "Detect project tech stack for per-stack hook config", ["ready"])],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("ACTION REQUIRED")
    expect(result.reason).not.toContain("Cause to capture:")
    expect(result.reason).not.toContain("Use the /update-memory skill")
  })

  test("open-issue block reason contains formatted action plan", async () => {
    const dir = await createGitRepoWithGitHubRemote("-actionplan", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(42, "Fix login redirect bug", ["bug", "priority:high"])],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("Action plan:")
  })

  test("skip-only issues allow stop (no actionable issues)", async () => {
    const dir = await createGitRepoWithGitHubRemote("-skiponly", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(10, "Blocked feature", ["blocked"]),
        makeIssue(11, "Stale request", ["stale"]),
        makeIssue(12, "Invalid report", ["invalid"]),
      ],
    })
    expect(result.blocked).toBe(false)
  })

  test("skip precedence: critical+stale issue is excluded, does not trigger block alone", async () => {
    const dir = await createGitRepoWithGitHubRemote("-skipprecedence", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(99, "Critical but stale", ["critical", "stale"])],
    })
    expect(result.blocked).toBe(false)
  })

  test("skip + actionable mix: only actionable issues appear in reason", async () => {
    const dir = await createGitRepoWithGitHubRemote("-skipmix", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(1, "Blocked issue", ["blocked", "priority:high"]),
        makeIssue(2, "Real bug", ["bug"]),
      ],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("#2")
    expect(result.reason).not.toContain("#1")
  })
})

// ─── Priority ranking in block message ───────────────────────────────────────

describe("E2E stop-personal-repo-issues: priority ranking in block reason", () => {
  test("highest-scoring issue appears before lower-scoring issue", async () => {
    const dir = await createGitRepoWithGitHubRemote("-ranking", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(1, "Low priority task", ["priority:low"]),
        makeIssue(2, "Critical regression", ["critical", "regression", "bug"]),
      ],
    })
    expect(result.blocked).toBe(true)
    // Issue 2 (critical+regression+bug = 5+3+2 = 10) must appear before issue 1 (priority:low = 1)
    const r = result.reason!
    expect(r.indexOf("#2")).toBeLessThan(r.indexOf("#1"))
  })

  test("ramp3-spike backlog: priority:high+ready+bug beats plain enhancement", async () => {
    const dir = await createGitRepoWithGitHubRemote("-ramp3rank", "testuser", "ramp3")
    const result = await runHook(dir, {
      user: "testuser",
      issues: RAMP3_ISSUES,
    })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    // Issue 569 (priority:high + ready + tech-debt = 4+3+0 = 7) or
    // Issue 935 (priority:high + bug + backend = 4+2+0 = 6)
    // Both must appear before plain enhancements like #934
    const pos935 = r.indexOf("#935")
    const pos934 = r.indexOf("#934")
    // #935 has higher score — if both are in top 5, #935 must come first
    if (pos935 !== -1 && pos934 !== -1) {
      expect(pos935).toBeLessThan(pos934)
    }
    // At minimum, the high-priority issues must appear
    expect(pos935).not.toBe(-1)
  })

  test("p0 label scores highest and appears first when mixed with priority:high", async () => {
    const dir = await createGitRepoWithGitHubRemote("-p0first", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(1, "High priority issue", ["priority:high", "bug"]),
        makeIssue(2, "P0 incident", ["p0", "regression"]),
        makeIssue(3, "Medium issue", ["priority:medium"]),
      ],
    })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    // Issue 2 (p0=5 + regression=3 = 8) beats issue 1 (priority:high=4 + bug=2 = 6)
    expect(r.indexOf("#2")).toBeLessThan(r.indexOf("#1"))
  })
})

// ─── Top-5 truncation ────────────────────────────────────────────────────────

describe("E2E stop-personal-repo-issues: top-5 truncation", () => {
  test("6 issues: 5 shown plus '…and 1 more' line", async () => {
    const dir = await createGitRepoWithGitHubRemote("-trunc6", "testuser", "myrepo")
    const issues = Array.from({ length: 6 }, (_, i) => makeIssue(i + 1, `Issue ${i + 1}`, ["bug"]))
    const result = await runHook(dir, { user: "testuser", issues })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    expect(r).toContain("and 1 more")
  })

  test("ramp3-spike 8-issue backlog: refinement and actionable sections shown separately", async () => {
    const dir = await createGitRepoWithGitHubRemote("-trunc8", "testuser", "ramp3")
    const result = await runHook(dir, { user: "testuser", issues: RAMP3_ISSUES })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    // 5 issues are missing one or more required refinement categories
    expect(r).toContain("need refinement")
    expect(r).toContain("[missing labels:")
    // 3 issues have `ready` → actionable section
    expect(r).toContain("3 open issue(s)")
    // No truncation — 5 refinement + 3 actionable both fit within MAX_SHOWN_ISSUES
    expect(r).not.toContain("and 3 more")
  })

  test("5 issues exactly: no 'more' line present", async () => {
    const dir = await createGitRepoWithGitHubRemote("-exact5", "testuser", "myrepo")
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1, `Issue ${i + 1}`, ["bug"]))
    const result = await runHook(dir, { user: "testuser", issues })
    expect(result.blocked).toBe(true)
    expect(result.reason).not.toContain("more lower-priority")
  })

  test("skip labels reduce effective count before truncation — no false 'more' line", async () => {
    const dir = await createGitRepoWithGitHubRemote("-skiptrunc", "testuser", "myrepo")
    // 5 real + 3 skipped = 8 total, but only 5 actionable → no truncation
    const issues = [
      ...Array.from({ length: 5 }, (_, i) => makeIssue(i + 1, `Issue ${i + 1}`, ["bug"])),
      makeIssue(10, "Stale one", ["stale"]),
      makeIssue(11, "Blocked one", ["blocked"]),
      makeIssue(12, "Invalid one", ["invalid"]),
    ]
    const result = await runHook(dir, { user: "testuser", issues })
    expect(result.blocked).toBe(true)
    expect(result.reason).not.toContain("more lower-priority")
  })
})

// ─── PR blocking and issue suppression ───────────────────────────────────────

describe("E2E stop-personal-repo-issues: PR blocking suppresses issue list", () => {
  test("CHANGES_REQUESTED PR blocks stop with PR details in reason", async () => {
    const dir = await createGitRepoWithGitHubRemote("-prblock", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      prs: [makePR(7, "feat: add new dashboard", "CHANGES_REQUESTED")],
      issues: [makeIssue(1, "Bug fix", ["bug"])],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("#7")
    expect(result.reason).toContain("feat: add new dashboard")
    expect(result.reason).toContain("changes requested")
  })

  test("CHANGES_REQUESTED PR suppresses issue list (issues not shown in reason)", async () => {
    const dir = await createGitRepoWithGitHubRemote("-prsuppresses", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      prs: [makePR(7, "feat: add new dashboard", "CHANGES_REQUESTED")],
      issues: [makeIssue(42, "Critical bug", ["critical"])],
    })
    expect(result.blocked).toBe(true)
    // Issue list is suppressed when CHANGES_REQUESTED PR exists
    expect(result.reason).not.toContain("#42")
  })

  test("REVIEW_REQUIRED PR blocks stop and issues are still shown", async () => {
    const dir = await createGitRepoWithGitHubRemote("-reviewreq", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      prs: [makePR(3, "docs: update readme", "REVIEW_REQUIRED")],
      issues: [makeIssue(10, "Bug report", ["bug"])],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("#3")
    // Issues should still be shown (only CHANGES_REQUESTED suppresses them)
    expect(result.reason).toContain("#10")
  })

  test("no PRs and no issues allows stop", async () => {
    const dir = await createGitRepoWithGitHubRemote("-empty", "testuser", "myrepo")
    const result = await runHook(dir, { user: "testuser" })
    expect(result.blocked).toBe(false)
  })

  test("conflicting PR suggestions show only the two newest and two oldest", async () => {
    const dir = await createGitRepoWithGitHubRemote("-conflictbookends", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      prs: [
        makePR(101, "Conflict 101", "APPROVED", {
          mergeable: "CONFLICTING",
          createdAt: "2026-01-01T00:00:00Z",
        }),
        makePR(102, "Conflict 102", "APPROVED", {
          mergeable: "CONFLICTING",
          createdAt: "2026-01-02T00:00:00Z",
        }),
        makePR(103, "Conflict 103", "APPROVED", {
          mergeable: "CONFLICTING",
          createdAt: "2026-01-03T00:00:00Z",
        }),
        makePR(104, "Conflict 104", "APPROVED", {
          mergeable: "CONFLICTING",
          createdAt: "2026-01-04T00:00:00Z",
        }),
        makePR(105, "Conflict 105", "APPROVED", {
          mergeable: "CONFLICTING",
          createdAt: "2026-01-05T00:00:00Z",
        }),
        makePR(106, "Conflict 106", "APPROVED", {
          mergeable: "CONFLICTING",
          createdAt: "2026-01-06T00:00:00Z",
        }),
      ],
    })

    expect(result.blocked).toBe(true)
    const r = result.reason!
    expect(r).toContain("#106")
    expect(r).toContain("#105")
    expect(r).toContain("#101")
    expect(r).toContain("#102")
    expect(r).not.toContain("#103")
    expect(r).not.toContain("#104")
    expect(r).toContain("and 2 more conflicting PR(s) between those extremes")
  })
})

// ─── Org repo: user-scoped filtering ─────────────────────────────────────────

describe("E2E stop-personal-repo-issues: org repo filters to current user", () => {
  test("org repo: only issues authored by or assigned to current user are shown", async () => {
    // owner !== user → org repo
    const dir = await createGitRepoWithGitHubRemote("-org", "RaptorMarketing", "ramp3-spike")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(1, "User's own bug", ["bug"], { authorLogin: "testuser" }),
        makeIssue(2, "Someone else's bug", ["bug"], { authorLogin: "otherdev" }),
        makeIssue(3, "Assigned to user", ["bug"], {
          authorLogin: "boss",
          assigneeLogins: ["testuser"],
        }),
      ],
    })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    expect(r).toContain("#1")
    expect(r).toContain("#3")
    expect(r).not.toContain("#2")
  })

  test("org repo with no user-relevant issues allows stop", async () => {
    const dir = await createGitRepoWithGitHubRemote("-orgclean", "RaptorMarketing", "ramp3-spike")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(5, "Someone else's issue", ["bug"], { authorLogin: "otherdev" })],
    })
    expect(result.blocked).toBe(false)
  })

  test("personal repo includes all actionable issues regardless of author", async () => {
    // owner === user → personal repo, no user filter
    const dir = await createGitRepoWithGitHubRemote("-personal", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(1, "Filed by user", ["bug"], { authorLogin: "testuser" }),
        makeIssue(2, "Filed by contributor", ["bug"], { authorLogin: "contributor" }),
      ],
    })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    expect(r).toContain("#1")
    expect(r).toContain("#2")
  })
})

// ─── Normalisation variants in real-world label names ────────────────────────

describe("E2E stop-personal-repo-issues: normalisation survives real-world label variants", () => {
  test("high-priority label (reversed, dash) scores correctly and issue appears in reason", async () => {
    const dir = await createGitRepoWithGitHubRemote("-normhigh", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [
        makeIssue(1, "Low issue", []),
        makeIssue(2, "High issue (reversed label)", ["high-priority", "bug"]),
      ],
    })
    expect(result.blocked).toBe(true)
    const r = result.reason!
    // high-priority normalises to same as priority:high (score 4)
    // → #2 must appear before #1
    expect(r.indexOf("#2")).toBeLessThan(r.indexOf("#1"))
  })

  test("WONTFIX (caps) is treated as a skip label", async () => {
    const dir = await createGitRepoWithGitHubRemote("-capskip", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(1, "Wont fix this", ["WONTFIX"])],
    })
    expect(result.blocked).toBe(false)
  })

  test("on/hold (slash variant) is treated as a skip label", async () => {
    const dir = await createGitRepoWithGitHubRemote("-slashskip", "testuser", "myrepo")
    const result = await runHook(dir, {
      user: "testuser",
      issues: [makeIssue(1, "On hold issue", ["on/hold"])],
    })
    expect(result.blocked).toBe(false)
  })
})
