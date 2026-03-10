import { describe, expect, it } from "bun:test"
import {
  detectProjectCollaborationPolicy,
  detectRepoOwnership,
  evaluateCollaborationPolicy,
  filterHumanContributorLogins,
  filterHumanOpenPullRequests,
  getCollaborationModePolicy,
  isAutomationLogin,
  isOrgRepo,
  isPersonalRepo,
} from "./collaboration-policy.ts"

describe("isAutomationLogin", () => {
  it("matches bot and automation accounts", () => {
    expect(isAutomationLogin("dependabot[bot]")).toBe(true)
    expect(isAutomationLogin("github-actions[bot]")).toBe(true)
    expect(isAutomationLogin("cursoragent")).toBe(true)
    expect(isAutomationLogin("claude")).toBe(true)
  })

  it("does not match regular users", () => {
    expect(isAutomationLogin("mherod")).toBe(false)
    expect(isAutomationLogin("teammate")).toBe(false)
  })
})

describe("isOrgRepo", () => {
  it("detects owner mismatch as organization/collaborative ownership", () => {
    expect(isOrgRepo("my-org", "mherod")).toBe(true)
  })

  it("treats same owner (case-insensitive) as personal", () => {
    expect(isOrgRepo("MHeRod", "mherod")).toBe(false)
  })
})

describe("isPersonalRepo", () => {
  it("returns true for same owner and user (case-insensitive)", () => {
    expect(isPersonalRepo("MHeRod", "mherod")).toBe(true)
  })

  it("returns false for organization or unresolved ownership", () => {
    expect(isPersonalRepo("swiz-org", "mherod")).toBe(false)
    expect(isPersonalRepo(null, "mherod")).toBe(false)
  })
})

describe("filterHumanContributorLogins", () => {
  it("filters bots, null-like values, current user, and duplicates", () => {
    const filtered = filterHumanContributorLogins(
      ["mherod", "teammate", "dependabot[bot]", "null", "TEAMMATE", "cursoragent"],
      "mherod"
    )
    expect(filtered).toEqual(["teammate"])
  })
})

describe("filterHumanOpenPullRequests", () => {
  it("keeps only non-bot PRs from users other than current user", () => {
    const filtered = filterHumanOpenPullRequests(
      [
        { author: { login: "mherod" } },
        { author: { login: "teammate" } },
        { author: { login: "dependabot[bot]" } },
        { author: { login: null } },
      ],
      "mherod"
    )
    expect(filtered).toEqual([{ author: { login: "teammate" } }])
  })
})

describe("evaluateCollaborationPolicy", () => {
  it("classifies solo repositories with no human signals as non-collaborative", () => {
    const result = evaluateCollaborationPolicy({
      currentUser: "mherod",
      openPullRequests: [{ author: { login: "dependabot[bot]" } }],
      recentContributorLogins: ["mherod", "github-actions[bot]"],
      repoOwner: "mherod",
    })

    expect(result.isCollaborative).toBe(false)
    expect(result.signals).toEqual([])
  })

  it("classifies organization-owned repos as collaborative", () => {
    const result = evaluateCollaborationPolicy({
      currentUser: "mherod",
      openPullRequests: [],
      recentContributorLogins: [],
      repoOwner: "swiz-org",
    })

    expect(result.isCollaborative).toBe(true)
    expect(result.signals).toContain("Organization repository (not a personal repo)")
  })

  it("classifies recent human contributor activity as collaborative", () => {
    const result = evaluateCollaborationPolicy({
      currentUser: "mherod",
      openPullRequests: [],
      recentContributorLogins: ["teammate", "mherod"],
      repoOwner: "mherod",
    })

    expect(result.isCollaborative).toBe(true)
    expect(result.otherContributors).toEqual(["teammate"])
  })

  it("classifies open PRs from other humans as collaborative", () => {
    const result = evaluateCollaborationPolicy({
      currentUser: "mherod",
      openPullRequests: [{ author: { login: "teammate" } }],
      recentContributorLogins: [],
      repoOwner: "mherod",
    })

    expect(result.isCollaborative).toBe(true)
    expect(result.openPullRequestCount).toBe(1)
  })
})

describe("detectProjectCollaborationPolicy", () => {
  it("resolves collaboration details from GitHub data", async () => {
    const result = await detectProjectCollaborationPolicy("/tmp/repo", {
      nowMs: Date.parse("2026-03-05T12:00:00Z"),
      gh: async (args) => (args.join(" ") === "api user --jq .login" ? "mherod" : ""),
      getRepoSlug: async () => "swiz-org/swiz",
      ghJson: async <T>(args: string[]) => {
        if (args[0] === "pr") {
          return [{ author: { login: "teammate" } }] as T
        }
        return [
          {
            author: { login: "teammate" },
            commit: { author: { date: "2026-03-05T11:00:00Z" } },
          },
        ] as T
      },
    })

    expect(result.resolved).toBe(true)
    expect(result.repoOwner).toBe("swiz-org")
    expect(result.repoName).toBe("swiz")
    expect(result.isCollaborative).toBe(true)
    expect(result.openPullRequestCount).toBe(1)
  })

  it("marks detection unresolved when GitHub responses are missing", async () => {
    const result = await detectProjectCollaborationPolicy("/tmp/repo", {
      gh: async () => "",
      getRepoSlug: async () => "mherod/swiz",
      ghJson: async () => null,
    })

    expect(result.resolved).toBe(false)
    expect(result.isCollaborative).toBe(false)
  })
})

describe("detectRepoOwnership", () => {
  it("resolves personal ownership from repo slug and current user", async () => {
    const result = await detectRepoOwnership("/tmp/repo", {
      gh: async (args) => (args.join(" ") === "api user --jq .login" ? "mherod" : ""),
      getRepoSlug: async () => "mherod/swiz",
    })

    expect(result.resolved).toBe(true)
    expect(result.repoOwner).toBe("mherod")
    expect(result.repoName).toBe("swiz")
    expect(result.isPersonalRepo).toBe(true)
  })

  it("marks unresolved ownership when owner or user cannot be determined", async () => {
    const result = await detectRepoOwnership("/tmp/repo", {
      gh: async () => "",
      getRepoSlug: async () => "mherod/swiz",
    })

    expect(result.resolved).toBe(false)
    expect(result.isPersonalRepo).toBe(false)
  })
})

describe("getCollaborationModePolicy", () => {
  it("solo: no branch, PR, or review requirements", () => {
    const policy = getCollaborationModePolicy("solo")
    expect(policy.requireFeatureBranch).toBe(false)
    expect(policy.requirePullRequest).toBe(false)
    expect(policy.requirePeerReview).toBe(false)
    expect(policy.prHooksActive).toBe(false)
  })

  it("relaxed-collab: feature branch + PR required, peer review not required", () => {
    const policy = getCollaborationModePolicy("relaxed-collab")
    expect(policy.requireFeatureBranch).toBe(true)
    expect(policy.requirePullRequest).toBe(true)
    expect(policy.requirePeerReview).toBe(false)
    expect(policy.prHooksActive).toBe(true)
  })

  it("team: feature branch + PR + peer review all required", () => {
    const policy = getCollaborationModePolicy("team")
    expect(policy.requireFeatureBranch).toBe(true)
    expect(policy.requirePullRequest).toBe(true)
    expect(policy.requirePeerReview).toBe(true)
    expect(policy.prHooksActive).toBe(true)
  })

  it("auto: permissive defaults (defers to signal detection at runtime)", () => {
    const policy = getCollaborationModePolicy("auto")
    expect(policy.requireFeatureBranch).toBe(false)
    expect(policy.requirePullRequest).toBe(false)
    expect(policy.requirePeerReview).toBe(false)
    expect(policy.prHooksActive).toBe(false)
  })

  it("relaxed-collab differs from team only in requirePeerReview", () => {
    const relaxed = getCollaborationModePolicy("relaxed-collab")
    const team = getCollaborationModePolicy("team")
    expect(relaxed.requireFeatureBranch).toBe(team.requireFeatureBranch)
    expect(relaxed.requirePullRequest).toBe(team.requirePullRequest)
    expect(relaxed.prHooksActive).toBe(team.prHooksActive)
    expect(relaxed.requirePeerReview).toBe(false)
    expect(team.requirePeerReview).toBe(true)
  })
})
