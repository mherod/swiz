import { describe, expect, test } from "bun:test"

// Mirror the pure functions from stop-personal-repo-issues.ts.
// These are not exported so we duplicate the logic here and test it directly,
// following the same pattern as stop-todo-tracker.test.ts.

function extractOwnerFromUrl(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\//)
  if (sshMatch?.[1]) return sshMatch[1]

  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\//)
  if (httpsMatch?.[1]) return httpsMatch[1]

  return null
}

const SKIP_LABELS = new Set([
  "blocked",
  "upstream",
  "wontfix",
  "wont-fix",
  "duplicate",
  "on-hold",
  "waiting",
  "backlog",
  "stale",
  "icebox",
  "invalid",
  "needs-info",
])

const LABEL_SCORE: Record<string, number> = {
  critical: 5,
  urgent: 4,
  security: 4,
  hotfix: 3,
  regression: 3,
  crash: 3,
  p0: 5,
  p1: 4,
  p2: 2,
  p3: 0,
  "priority:high": 4,
  "priority:medium": 2,
  "priority:low": -1,
  ready: 3,
  confirmed: 1,
  accepted: 1,
  triaged: 1,
  "spec-approved": 1,
  "help wanted": 1,
  "good first issue": 1,
  tiny: 2,
  "size:tiny": 2,
  "size:xs": 2,
  "size:s": 2,
  "size:m": 1,
  "size:l": -1,
  "size:xl": -2,
  "size:xxl": -3,
  bug: 2,
  maintenance: 1,
  "needs-breakdown": -2,
}

const MAX_SHOWN_ISSUES = 5

function normaliseLabel(name: string): string {
  return name.toLowerCase().replace(/[/-]/g, ":").split(":").sort().join(":")
}

const SKIP_NORM = new Set([...SKIP_LABELS].map(normaliseLabel))
const SCORE_NORM: Record<string, number> = Object.fromEntries(
  Object.entries(LABEL_SCORE).map(([k, v]) => [normaliseLabel(k), v])
)

interface Issue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
}

function filterByUser(issues: Issue[], filterUser: string): Issue[] {
  return issues.filter(
    (i) => i.author?.login === filterUser || i.assignees?.some((a) => a.login === filterUser)
  )
}

function filterByActionable(issues: Issue[]): Issue[] {
  return issues.filter((i) => !i.labels.some((l) => SKIP_NORM.has(normaliseLabel(l.name))))
}

function scoreIssue(issue: Issue): number {
  return issue.labels.reduce((sum, l) => sum + (SCORE_NORM[normaliseLabel(l.name)] ?? 0), 0)
}

function sortAndCapIssues(issues: Issue[]): { shown: Issue[]; hidden: number } {
  const sorted = [...issues].sort((a, b) => scoreIssue(b) - scoreIssue(a))
  return {
    shown: sorted.slice(0, MAX_SHOWN_ISSUES),
    hidden: Math.max(0, sorted.length - MAX_SHOWN_ISSUES),
  }
}

interface PR {
  number: number
  title: string
  url: string
  reviewDecision: string
}

/** Mirrors the hook's hasChangesRequested logic */
function hasChangesRequested(prs: PR[]): boolean {
  return prs.some((p) => p.reviewDecision === "CHANGES_REQUESTED")
}

// ─── extractOwnerFromUrl ──────────────────────────────────────────────────────

describe("extractOwnerFromUrl", () => {
  test("extracts owner from SSH personal repo URL", () => {
    expect(extractOwnerFromUrl("git@github.com:mherod/repo.git")).toBe("mherod")
  })

  test("extracts org from SSH org repo URL", () => {
    expect(extractOwnerFromUrl("git@github.com:myorg/repo.git")).toBe("myorg")
  })

  test("extracts owner from HTTPS personal repo URL", () => {
    expect(extractOwnerFromUrl("https://github.com/mherod/repo.git")).toBe("mherod")
  })

  test("extracts org from HTTPS org repo URL", () => {
    expect(extractOwnerFromUrl("https://github.com/myorg/repo.git")).toBe("myorg")
  })

  test("returns null for GitLab URL", () => {
    expect(extractOwnerFromUrl("https://gitlab.com/owner/repo.git")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(extractOwnerFromUrl("")).toBeNull()
  })

  test("returns null for bare domain with no owner segment", () => {
    expect(extractOwnerFromUrl("https://github.com")).toBeNull()
  })
})

// ─── filterByUser (org repo: self-authored / self-assigned) ──────────────────

describe("filterByUser — org repo issue scoping", () => {
  const currentUser = "mherod"

  const authoredByUser: Issue = {
    number: 1,
    title: "Self-reported bug",
    labels: [],
    author: { login: "mherod" },
    assignees: [],
  }

  const assignedToUser: Issue = {
    number: 2,
    title: "Assigned task",
    labels: [],
    author: { login: "someoneelse" },
    assignees: [{ login: "mherod" }],
  }

  const neitherAuthorNorAssignee: Issue = {
    number: 3,
    title: "Unrelated issue",
    labels: [],
    author: { login: "someoneelse" },
    assignees: [{ login: "anotherone" }],
  }

  const bothAuthorAndAssignee: Issue = {
    number: 4,
    title: "Own bug, self-assigned",
    labels: [],
    author: { login: "mherod" },
    assignees: [{ login: "mherod" }],
  }

  const noAuthorNoAssignees: Issue = {
    number: 5,
    title: "No attribution",
    labels: [],
    author: undefined,
    assignees: undefined,
  }

  const multiAssigneeIncludesUser: Issue = {
    number: 6,
    title: "Team task",
    labels: [],
    author: { login: "boss" },
    assignees: [{ login: "colleague" }, { login: "mherod" }],
  }

  test("includes issue authored by current user", () => {
    expect(filterByUser([authoredByUser], currentUser)).toHaveLength(1)
  })

  test("includes issue assigned to current user", () => {
    expect(filterByUser([assignedToUser], currentUser)).toHaveLength(1)
  })

  test("excludes issue where user is neither author nor assignee", () => {
    expect(filterByUser([neitherAuthorNorAssignee], currentUser)).toHaveLength(0)
  })

  test("includes issue where user is both author and assignee (no duplicate)", () => {
    expect(filterByUser([bothAuthorAndAssignee], currentUser)).toHaveLength(1)
  })

  test("excludes issue with no author or assignees", () => {
    expect(filterByUser([noAuthorNoAssignees], currentUser)).toHaveLength(0)
  })

  test("includes issue when user is one of several assignees", () => {
    expect(filterByUser([multiAssigneeIncludesUser], currentUser)).toHaveLength(1)
  })

  test("mixed list: returns only user's issues", () => {
    const all = [authoredByUser, assignedToUser, neitherAuthorNorAssignee, bothAuthorAndAssignee]
    expect(filterByUser(all, currentUser)).toHaveLength(3)
  })

  test("returns empty list when no issues match", () => {
    expect(filterByUser([neitherAuthorNorAssignee], currentUser)).toHaveLength(0)
  })

  test("returns empty list for empty input", () => {
    expect(filterByUser([], currentUser)).toHaveLength(0)
  })
})

// ─── filterByActionable (SKIP_LABELS) ────────────────────────────────────────

describe("filterByActionable — SKIP_LABELS filtering", () => {
  function makeIssue(labels: string[]): Issue {
    return {
      number: 1,
      title: "Issue",
      labels: labels.map((name) => ({ name })),
      author: { login: "mherod" },
      assignees: [],
    }
  }

  test("passes through issue with no labels", () => {
    expect(filterByActionable([makeIssue([])])).toHaveLength(1)
  })

  test("passes through issue with unrelated label", () => {
    expect(filterByActionable([makeIssue(["bug"])])).toHaveLength(1)
  })

  for (const label of [
    "blocked",
    "upstream",
    "wontfix",
    "wont-fix",
    "duplicate",
    "on-hold",
    "waiting",
    "backlog",
    "stale",
    "icebox",
    "invalid",
    "needs-info",
  ]) {
    test(`excludes issue labelled '${label}'`, () => {
      expect(filterByActionable([makeIssue([label])])).toHaveLength(0)
    })
  }

  test("case-insensitive: 'Blocked' is excluded", () => {
    expect(filterByActionable([makeIssue(["Blocked"])])).toHaveLength(0)
  })

  test("case-insensitive: 'WONTFIX' is excluded", () => {
    expect(filterByActionable([makeIssue(["WONTFIX"])])).toHaveLength(0)
  })

  test("excludes if any label is a skip label, even with non-skip labels present", () => {
    expect(filterByActionable([makeIssue(["bug", "blocked"])])).toHaveLength(0)
  })

  test("returns empty list for empty input", () => {
    expect(filterByActionable([])).toHaveLength(0)
  })
})

// ─── PR priority: CHANGES_REQUESTED suppresses issue display ─────────────────

describe("hasChangesRequested — PR-over-issues priority", () => {
  const changesRequestedPR: PR = {
    number: 10,
    title: "Fix auth flow",
    url: "https://github.com/mherod/repo/pull/10",
    reviewDecision: "CHANGES_REQUESTED",
  }

  const reviewRequiredPR: PR = {
    number: 11,
    title: "Add dark mode",
    url: "https://github.com/mherod/repo/pull/11",
    reviewDecision: "REVIEW_REQUIRED",
  }

  test("true when any PR has CHANGES_REQUESTED", () => {
    expect(hasChangesRequested([changesRequestedPR])).toBe(true)
  })

  test("false when only REVIEW_REQUIRED PRs exist", () => {
    expect(hasChangesRequested([reviewRequiredPR])).toBe(false)
  })

  test("true when mixed CHANGES_REQUESTED and REVIEW_REQUIRED", () => {
    expect(hasChangesRequested([reviewRequiredPR, changesRequestedPR])).toBe(true)
  })

  test("false for empty PR list", () => {
    expect(hasChangesRequested([])).toBe(false)
  })

  test("false when PR has no relevant review decision", () => {
    const approvedPR: PR = { ...changesRequestedPR, reviewDecision: "APPROVED" }
    expect(hasChangesRequested([approvedPR])).toBe(false)
  })
})

// ─── Combined pipeline: org repo vs personal repo ────────────────────────────

describe("org vs personal repo combined filter pipeline", () => {
  const currentUser = "mherod"

  test("org repo: user-authored issue with skip label is excluded after both filters", () => {
    const issues: Issue[] = [
      {
        number: 1,
        title: "Blocked own issue",
        labels: [{ name: "blocked" }],
        author: { login: "mherod" },
        assignees: [],
      },
    ]
    const userIssues = filterByUser(issues, currentUser)
    expect(filterByActionable(userIssues)).toHaveLength(0)
  })

  test("org repo: externally authored issue (no skip label) is excluded by user filter", () => {
    const issues: Issue[] = [
      {
        number: 2,
        title: "External bug report",
        labels: [],
        author: { login: "external-contributor" },
        assignees: [],
      },
    ]
    expect(filterByUser(issues, currentUser)).toHaveLength(0)
  })

  test("personal repo: externally authored issue IS included (no user filter applied)", () => {
    // For personal repos filterUser is undefined — skip filterByUser entirely
    const issues: Issue[] = [
      {
        number: 2,
        title: "External bug report",
        labels: [],
        author: { login: "external-contributor" },
        assignees: [],
      },
    ]
    expect(filterByActionable(issues)).toHaveLength(1)
  })

  test("personal repo: externally authored issue with skip label is still excluded", () => {
    const issues: Issue[] = [
      {
        number: 3,
        title: "Wont fix external",
        labels: [{ name: "wontfix" }],
        author: { login: "external-contributor" },
        assignees: [],
      },
    ]
    expect(filterByActionable(issues)).toHaveLength(0)
  })

  test("org repo: user assigned to actionable issue is blocked", () => {
    const issues: Issue[] = [
      {
        number: 4,
        title: "Assigned to me",
        labels: [{ name: "bug" }],
        author: { login: "boss" },
        assignees: [{ login: "mherod" }],
      },
    ]
    const userIssues = filterByUser(issues, currentUser)
    expect(filterByActionable(userIssues)).toHaveLength(1)
  })
})

// ─── normaliseLabel ───────────────────────────────────────────────────────────

describe("normaliseLabel — separator and word-order canonicalization", () => {
  test("colon-separated label is canonical baseline", () => {
    expect(normaliseLabel("priority:high")).toBe(normaliseLabel("priority:high"))
  })

  test("slash separator matches colon: priority/high === priority:high", () => {
    expect(normaliseLabel("priority/high")).toBe(normaliseLabel("priority:high"))
  })

  test("dash separator matches colon: priority-high === priority:high", () => {
    expect(normaliseLabel("priority-high")).toBe(normaliseLabel("priority:high"))
  })

  test("reversed word order matches: high-priority === priority:high", () => {
    expect(normaliseLabel("high-priority")).toBe(normaliseLabel("priority:high"))
  })

  test("case insensitive: HIGH-PRIORITY matches priority:high", () => {
    expect(normaliseLabel("HIGH-PRIORITY")).toBe(normaliseLabel("priority:high"))
  })

  test("all four variants of priority:high normalise identically", () => {
    const canon = normaliseLabel("priority:high")
    expect(normaliseLabel("priority/high")).toBe(canon)
    expect(normaliseLabel("priority-high")).toBe(canon)
    expect(normaliseLabel("high-priority")).toBe(canon)
    expect(normaliseLabel("high/priority")).toBe(canon)
  })

  test("single-word label is unchanged (lowercase)", () => {
    expect(normaliseLabel("bug")).toBe("bug")
    expect(normaliseLabel("ready")).toBe("ready")
  })

  test("single-word label case-folded", () => {
    expect(normaliseLabel("BUG")).toBe("bug")
    expect(normaliseLabel("Ready")).toBe("ready")
  })

  test("size:m and m:size normalise identically", () => {
    expect(normaliseLabel("m:size")).toBe(normaliseLabel("size:m"))
  })

  test("on-hold and hold-on normalise identically", () => {
    expect(normaliseLabel("on-hold")).toBe(normaliseLabel("hold-on"))
  })

  test("spec-approved and approved-spec normalise identically", () => {
    expect(normaliseLabel("spec-approved")).toBe(normaliseLabel("approved-spec"))
  })
})

// ─── SKIP_NORM — separator and word-order variants ───────────────────────────

describe("SKIP_NORM — matches across separator and word-order variants", () => {
  test("blocked is matched", () => {
    expect(SKIP_NORM.has(normaliseLabel("blocked"))).toBe(true)
  })

  test("on-hold is matched (canonical form)", () => {
    expect(SKIP_NORM.has(normaliseLabel("on-hold"))).toBe(true)
  })

  test("hold-on is matched (reversed word order)", () => {
    expect(SKIP_NORM.has(normaliseLabel("hold-on"))).toBe(true)
  })

  test("on/hold is matched (slash separator)", () => {
    expect(SKIP_NORM.has(normaliseLabel("on/hold"))).toBe(true)
  })

  test("wontfix is matched", () => {
    expect(SKIP_NORM.has(normaliseLabel("wontfix"))).toBe(true)
  })

  test("bug is NOT a skip label", () => {
    expect(SKIP_NORM.has(normaliseLabel("bug"))).toBe(false)
  })

  test("filterByActionable excludes on/hold (slash) variant", () => {
    const issue: Issue = {
      number: 1,
      title: "On hold",
      labels: [{ name: "on/hold" }],
      author: { login: "u" },
      assignees: [],
    }
    expect(filterByActionable([issue])).toHaveLength(0)
  })

  test("filterByActionable excludes hold-on (reversed) variant", () => {
    const issue: Issue = {
      number: 2,
      title: "Hold on",
      labels: [{ name: "hold-on" }],
      author: { login: "u" },
      assignees: [],
    }
    expect(filterByActionable([issue])).toHaveLength(0)
  })
})

// ─── SCORE_NORM — label scoring via normalised keys ──────────────────────────

describe("SCORE_NORM — canonical keys cover all source table entries", () => {
  test("priority:high key exists in SCORE_NORM", () => {
    expect(SCORE_NORM[normaliseLabel("priority:high")]).toBe(4)
  })

  test("priority:medium key exists in SCORE_NORM", () => {
    expect(SCORE_NORM[normaliseLabel("priority:medium")]).toBe(2)
  })

  test("priority:low key exists in SCORE_NORM", () => {
    expect(SCORE_NORM[normaliseLabel("priority:low")]).toBe(-1)
  })

  test("ready key exists in SCORE_NORM", () => {
    expect(SCORE_NORM[normaliseLabel("ready")]).toBe(3)
  })

  test("bug key exists in SCORE_NORM", () => {
    expect(SCORE_NORM[normaliseLabel("bug")]).toBe(2)
  })

  test("needs-breakdown key exists in SCORE_NORM", () => {
    expect(SCORE_NORM[normaliseLabel("needs-breakdown")]).toBe(-2)
  })
})

// ─── scoreIssue — heuristic scoring across label variants ────────────────────

describe("scoreIssue — label heuristic scoring", () => {
  function makeIssue(labels: string[]): Issue {
    return {
      number: 1,
      title: "Issue",
      labels: labels.map((name) => ({ name })),
      author: { login: "u" },
      assignees: [],
    }
  }

  test("priority:high scores 4", () => {
    expect(scoreIssue(makeIssue(["priority:high"]))).toBe(4)
  })

  test("priority-high (dash) scores same as priority:high", () => {
    expect(scoreIssue(makeIssue(["priority-high"]))).toBe(scoreIssue(makeIssue(["priority:high"])))
  })

  test("high-priority (reversed) scores same as priority:high", () => {
    expect(scoreIssue(makeIssue(["high-priority"]))).toBe(scoreIssue(makeIssue(["priority:high"])))
  })

  test("priority/high (slash) scores same as priority:high", () => {
    expect(scoreIssue(makeIssue(["priority/high"]))).toBe(scoreIssue(makeIssue(["priority:high"])))
  })

  test("size:m scores 1", () => {
    expect(scoreIssue(makeIssue(["size:m"]))).toBe(1)
  })

  test("m-size (reversed) scores same as size:m", () => {
    expect(scoreIssue(makeIssue(["m-size"]))).toBe(scoreIssue(makeIssue(["size:m"])))
  })

  test("bug scores 2", () => {
    expect(scoreIssue(makeIssue(["bug"]))).toBe(2)
  })

  test("unknown label scores 0", () => {
    expect(scoreIssue(makeIssue(["some-unknown-label"]))).toBe(0)
  })

  test("no labels scores 0", () => {
    expect(scoreIssue(makeIssue([]))).toBe(0)
  })

  test("multiple labels sum: priority:high + ready + bug = 4+3+2 = 9", () => {
    expect(scoreIssue(makeIssue(["priority:high", "ready", "bug"]))).toBe(9)
  })

  test("priority:medium + size:m = 2+1 = 3", () => {
    expect(scoreIssue(makeIssue(["priority:medium", "size:m"]))).toBe(3)
  })

  test("needs-breakdown reduces score by 2", () => {
    const base = scoreIssue(makeIssue(["priority:medium"]))
    const withBreakdown = scoreIssue(makeIssue(["priority:medium", "needs-breakdown"]))
    expect(withBreakdown).toBe(base - 2)
  })

  test("high priority + ready + small scores higher than medium + no readiness", () => {
    const highReadySmall = scoreIssue(makeIssue(["priority:high", "ready", "size:s"]))
    const mediumOnly = scoreIssue(makeIssue(["priority:medium"]))
    expect(highReadySmall).toBeGreaterThan(mediumOnly)
  })
})

// ─── sortAndCapIssues — ordering and display cap ─────────────────────────────

describe("sortAndCapIssues — ordering and display cap", () => {
  function makeIssue(n: number, labels: string[]): Issue {
    return {
      number: n,
      title: `Issue ${n}`,
      labels: labels.map((name) => ({ name })),
      author: { login: "u" },
      assignees: [],
    }
  }

  test("single issue: shown, none hidden", () => {
    const { shown, hidden } = sortAndCapIssues([makeIssue(1, ["bug"])])
    expect(shown).toHaveLength(1)
    expect(hidden).toBe(0)
  })

  test("five issues: all shown, none hidden", () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1, []))
    const { shown, hidden } = sortAndCapIssues(issues)
    expect(shown).toHaveLength(5)
    expect(hidden).toBe(0)
  })

  test("six issues: five shown, one hidden", () => {
    const issues = Array.from({ length: 6 }, (_, i) => makeIssue(i + 1, []))
    const { shown, hidden } = sortAndCapIssues(issues)
    expect(shown).toHaveLength(5)
    expect(hidden).toBe(1)
  })

  test("ten issues: five shown, five hidden", () => {
    const issues = Array.from({ length: 10 }, (_, i) => makeIssue(i + 1, []))
    const { shown, hidden } = sortAndCapIssues(issues)
    expect(shown).toHaveLength(5)
    expect(hidden).toBe(5)
  })

  test("highest scoring issue appears first", () => {
    const low = makeIssue(1, ["priority:low"])
    const high = makeIssue(2, ["priority:high", "ready"])
    const { shown } = sortAndCapIssues([low, high])
    expect(shown[0]!.number).toBe(2)
  })

  test("cap preserves the highest-scoring items (not just first five)", () => {
    // 6 issues: one high-priority, five no-label — high-priority must survive the cap
    const lowIssues = Array.from({ length: 5 }, (_, i) => makeIssue(i + 1, []))
    const highIssue = makeIssue(99, ["priority:high", "ready", "bug"])
    const { shown } = sortAndCapIssues([...lowIssues, highIssue])
    expect(shown.map((i) => i.number)).toContain(99)
  })
})

// ─── Survey-derived label patterns ───────────────────────────────────────────

describe("scoreIssue — severity / urgency labels from real-world repos", () => {
  function makeIssue(labels: string[]): Issue {
    return {
      number: 1,
      title: "Issue",
      labels: labels.map((name) => ({ name })),
      author: { login: "u" },
      assignees: [],
    }
  }

  // Severity labels (electron, go, TypeScript pattern)
  test("critical scores 5", () => expect(scoreIssue(makeIssue(["critical"]))).toBe(5))
  test("Critical (capitalised) scores 5", () => expect(scoreIssue(makeIssue(["Critical"]))).toBe(5))
  test("urgent scores 4", () => expect(scoreIssue(makeIssue(["urgent"]))).toBe(4))
  test("security scores 4", () => expect(scoreIssue(makeIssue(["security"]))).toBe(4))
  test("hotfix scores 3", () => expect(scoreIssue(makeIssue(["hotfix"]))).toBe(3))
  test("regression scores 3", () => expect(scoreIssue(makeIssue(["regression"]))).toBe(3))
  test("crash scores 3 (TypeScript pattern)", () =>
    expect(scoreIssue(makeIssue(["crash"]))).toBe(3))

  // Numeric priority tiers (p0–p3)
  test("p0 scores 5", () => expect(scoreIssue(makeIssue(["p0"]))).toBe(5))
  test("p1 scores 4", () => expect(scoreIssue(makeIssue(["p1"]))).toBe(4))
  test("p2 scores 2", () => expect(scoreIssue(makeIssue(["p2"]))).toBe(2))
  test("p3 scores 0", () => expect(scoreIssue(makeIssue(["p3"]))).toBe(0))

  // p:N / P-N forms normalise the same as pN for two-segment labels
  test("p:1 and p-1 normalise to the same canonical as 1:p (not the same as p1)", () => {
    // p:1 → segments ["p","1"] → sorted ["1","p"] → "1:p"
    // p1  → single token → "p1"
    // These are genuinely different canonical forms; both are tested independently
    expect(normaliseLabel("p:1")).not.toBe(normaliseLabel("p1"))
    expect(normaliseLabel("p-1")).toBe(normaliseLabel("p:1"))
  })

  // Readiness signals from survey
  test("confirmed scores 1 (rails 'accepted' pattern)", () =>
    expect(scoreIssue(makeIssue(["confirmed"]))).toBe(1))
  test("accepted scores 1", () => expect(scoreIssue(makeIssue(["accepted"]))).toBe(1))
  test("triaged scores 1", () => expect(scoreIssue(makeIssue(["triaged"]))).toBe(1))
  test("help wanted scores 1", () => expect(scoreIssue(makeIssue(["help wanted"]))).toBe(1))
  test("good first issue scores 1", () =>
    expect(scoreIssue(makeIssue(["good first issue"]))).toBe(1))

  // Size extremes
  test("tiny scores 2 (same tier as xs)", () => expect(scoreIssue(makeIssue(["tiny"]))).toBe(2))
  test("size:tiny scores 2", () => expect(scoreIssue(makeIssue(["size:tiny"]))).toBe(2))
  test("size:xxl scores -3", () => expect(scoreIssue(makeIssue(["size:xxl"]))).toBe(-3))

  // Ordering: critical > priority:high > regression > confirmed
  test("critical beats priority:high in ranking", () => {
    expect(scoreIssue(makeIssue(["critical"]))).toBeGreaterThan(
      scoreIssue(makeIssue(["priority:high"]))
    )
  })

  test("regression beats confirmed in ranking", () => {
    expect(scoreIssue(makeIssue(["regression"]))).toBeGreaterThan(
      scoreIssue(makeIssue(["confirmed"]))
    )
  })
})

describe("filterByActionable — new skip labels from survey", () => {
  function makeIssue(labels: string[]): Issue {
    return {
      number: 1,
      title: "Issue",
      labels: labels.map((name) => ({ name })),
      author: { login: "u" },
      assignees: [],
    }
  }

  test("stale issues are excluded", () =>
    expect(filterByActionable([makeIssue(["stale"])])).toHaveLength(0))
  test("icebox issues are excluded", () =>
    expect(filterByActionable([makeIssue(["icebox"])])).toHaveLength(0))
  test("invalid issues are excluded", () =>
    expect(filterByActionable([makeIssue(["invalid"])])).toHaveLength(0))
  test("needs-info issues are excluded", () =>
    expect(filterByActionable([makeIssue(["needs-info"])])).toHaveLength(0))
  test("wont-fix issues are excluded", () =>
    expect(filterByActionable([makeIssue(["wont-fix"])])).toHaveLength(0))
  test("fix-wont (reversed) issues are excluded", () =>
    expect(filterByActionable([makeIssue(["fix-wont"])])).toHaveLength(0))
  test("Stale (capitalised) is excluded", () =>
    expect(filterByActionable([makeIssue(["Stale"])])).toHaveLength(0))
  test("info-needs (reversed) is excluded", () =>
    expect(filterByActionable([makeIssue(["info-needs"])])).toHaveLength(0))
})
