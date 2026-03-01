#!/usr/bin/env bun
/**
 * Stop hook: Check for open issues and PRs needing attention
 * Blocks stop if a personal GitHub repo has open issues, or if
 * the current user has self-authored or self-assigned issues in an org repo.
 */

import {
  blockStop,
  extractOwnerFromUrl,
  getCurrentGitHubUser,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

/** Labels that indicate an issue is not actionable right now. */
const SKIP_LABELS = new Set([
  "blocked",
  "upstream",
  "wontfix",
  "wont-fix", // normalises to fix:wont — handled separately from wontfix
  "duplicate",
  "on-hold",
  "waiting",
  "backlog",
  "stale", // common GitHub bot label
  "icebox", // explicit indefinite deferral
  "invalid", // not a valid issue
  "needs-info", // can't act without more information
])

/**
 * Heuristic scores for common label patterns.
 * Unknown labels score 0 — the table degrades gracefully across any repo.
 * Positive = more actionable now; negative = deprioritise.
 *
 * All keys are normalised at startup — separators (: / -) are collapsed and
 * segments sorted, so "priority:high", "high-priority", and "priority/high"
 * all resolve to the same entry.
 */
const LABEL_SCORE: Record<string, number> = {
  // Severity / urgency — highest signals
  critical: 5,
  urgent: 4,
  security: 4,
  hotfix: 3,
  regression: 3,
  crash: 3,
  // Numeric priority tiers (p0–p3 bare tokens; p:0 / P-0 handled by normalisation)
  p0: 5,
  p1: 4,
  p2: 2,
  p3: 0,
  // Priority namespace (priority:high / priority:medium / priority:low)
  "priority:high": 4,
  "priority:medium": 2,
  "priority:low": -1,
  // Readiness signals
  ready: 3,
  confirmed: 1,
  accepted: 1,
  triaged: 1,
  "spec-approved": 1,
  "help wanted": 1,
  "good first issue": 1,
  // Size signals — prefer smaller, well-scoped work
  tiny: 2,
  "size:tiny": 2,
  "size:xs": 2,
  "size:s": 2,
  "size:m": 1,
  "size:l": -1,
  "size:xl": -2,
  "size:xxl": -3,
  // Type signals — fixes before features
  bug: 2,
  maintenance: 1,
  // Not ready to start
  "needs-breakdown": -2,
}

const MAX_SHOWN_ISSUES = 5

/**
 * Normalise a label name for agnostic matching:
 *  1. Lowercase
 *  2. Collapse any separator (: / -) to :
 *  3. Sort segments alphabetically
 * Result: "priority:high", "priority/high", "priority-high", and
 * "high-priority" all normalise to the same canonical key.
 */
function normaliseLabel(name: string): string {
  return name.toLowerCase().replace(/[/-]/g, ":").split(":").sort().join(":")
}

// Pre-compute normalised lookups so source tables stay human-readable.
const SKIP_NORM = new Set([...SKIP_LABELS].map(normaliseLabel))
const SCORE_NORM: Record<string, number> = Object.fromEntries(
  Object.entries(LABEL_SCORE).map(([k, v]) => [normaliseLabel(k), v])
)

function scoreIssue(issue: Issue): number {
  return issue.labels.reduce((sum, l) => sum + (SCORE_NORM[normaliseLabel(l.name)] ?? 0), 0)
}

interface Issue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
}

interface PR {
  number: number
  title: string
  url: string
  reviewDecision: string
}

async function getActionableIssues(cwd: string, filterUser?: string): Promise<Issue[]> {
  const jsonFields = "number,title,labels,author,assignees"
  let issues =
    (await ghJson<Issue[]>(["issue", "list", "--state", "open", "--json", jsonFields], cwd)) ?? []
  if (filterUser) {
    issues = issues.filter(
      (i) => i.author?.login === filterUser || i.assignees?.some((a) => a.login === filterUser)
    )
  }
  return issues.filter((i) => !i.labels.some((l) => SKIP_NORM.has(normaliseLabel(l.name))))
}

async function getOpenPRsWithFeedback(cwd: string, currentUser: string): Promise<PR[]> {
  const prs = await ghJson<PR[]>(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--author",
      currentUser,
      "--json",
      "number,title,url,reviewDecision",
      "--jq",
      'map(select(.reviewDecision == "CHANGES_REQUESTED" or .reviewDecision == "REVIEW_REQUIRED"))',
    ],
    cwd
  )
  return prs ?? []
}

async function main(): Promise<void> {
  try {
    const input = (await Bun.stdin.json()) as StopHookInput
    const cwd = input.cwd

    if (!(await isGitRepo(cwd))) return
    if (!hasGhCli()) return
    if (!(await isGitHubRemote(cwd))) return

    // Extract owner from remote URL
    const remoteUrl = await git(["remote", "get-url", "origin"], cwd)
    const owner = extractOwnerFromUrl(remoteUrl)
    if (!owner) return

    const currentUser = await getCurrentGitHubUser(cwd)
    if (!currentUser) return

    const isPersonalRepo = owner === currentUser
    const prs = await getOpenPRsWithFeedback(cwd, currentUser)
    const changesRequestedPRs = prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED")
    const hasChangesRequested = changesRequestedPRs.length > 0

    // When there are PRs with CHANGES_REQUESTED, skip issues — the PR block is more urgent
    const actionableIssues = hasChangesRequested
      ? []
      : await getActionableIssues(cwd, isPersonalRepo ? undefined : currentUser)
    const issueCount = actionableIssues.length
    const prCount = prs.length

    if (issueCount === 0 && prCount === 0) return

    const reasonLines: string[] = []

    if (prCount > 0) {
      const allChangesRequested = prs.every((p) => p.reviewDecision === "CHANGES_REQUESTED")
      const label = allChangesRequested
        ? "changes requested"
        : "pending feedback (CHANGES_REQUESTED or REVIEW_REQUIRED)"
      reasonLines.push(`You have ${prCount} open PR(s) with ${label}:`)
      for (const pr of prs) {
        const decisionTag =
          pr.reviewDecision === "CHANGES_REQUESTED" ? "[changes requested]" : "[review required]"
        reasonLines.push(`  #${pr.number} ${pr.title} ${decisionTag}`)
        reasonLines.push(`    ${pr.url}`)
      }
      reasonLines.push(
        skillAdvice(
          "work-on-prs",
          "Use the /work-on-prs skill to address all feedback and resolve reviews:\n  /work-on-prs — Start working on the next PR",
          "Address all PR feedback before stopping:\n  gh pr list --state open\n  gh pr view <number> --comments"
        )
      )
    }

    if (issueCount > 0) {
      if (reasonLines.length > 0) reasonLines.push("")
      const issueContext = isPersonalRepo
        ? "in this personal repository"
        : "assigned to or created by you in this repository"
      reasonLines.push(`You have ${issueCount} open issue(s) ${issueContext}:`)
      const sortedIssues = [...actionableIssues].sort((a, b) => scoreIssue(b) - scoreIssue(a))
      const shownIssues = sortedIssues.slice(0, MAX_SHOWN_ISSUES)
      const hiddenCount = sortedIssues.length - shownIssues.length
      for (const issue of shownIssues) {
        reasonLines.push(`  #${issue.number} ${issue.title}`)
      }
      if (hiddenCount > 0) {
        reasonLines.push(`  …and ${hiddenCount} more lower-priority issue(s)`)
      }
      reasonLines.push(
        skillAdvice(
          "work-on-issue",
          "Use the /work-on-issue skill to pick up and resolve issues:\n  /work-on-issue — Start working on the next issue",
          "Pick up and resolve open issues before stopping:\n  gh issue list --state open\n  gh issue view <number>"
        )
      )
    }

    reasonLines.push("")
    reasonLines.push(
      "Work items assigned to or created by you represent code that needs finishing."
    )

    blockStop(reasonLines.join("\n"))
  } catch {
    // On error, allow stop (fail open)
  }
}

main()
