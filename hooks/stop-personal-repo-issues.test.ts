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
  "duplicate",
  "on-hold",
  "waiting",
  "backlog",
])

interface Issue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
}

function filterByUser(issues: Issue[], filterUser: string): Issue[] {
  return issues.filter(
    (i) =>
      i.author?.login === filterUser ||
      i.assignees?.some((a) => a.login === filterUser)
  )
}

function filterByActionable(issues: Issue[]): Issue[] {
  return issues.filter(
    (i) => !i.labels.some((l) => SKIP_LABELS.has(l.name.toLowerCase()))
  )
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
    const all = [
      authoredByUser,
      assignedToUser,
      neitherAuthorNorAssignee,
      bothAuthorAndAssignee,
    ]
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

  for (const label of ["blocked", "upstream", "wontfix", "duplicate", "on-hold", "waiting", "backlog"]) {
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
