#!/usr/bin/env bun

/**
 * Stop hook: Check for open issues and PRs needing attention
 * Blocks stop if a personal GitHub repo has open issues, or if
 * the current user has self-authored or self-assigned issues in an org repo.
 */

import { getIssueStore, replayPendingMutations } from "../src/issue-store.ts"
import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import {
  blockStop,
  extractOwnerFromUrl,
  getCanonicalPathHash,
  getCurrentGitHubUser,
  getRepoSlug,
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
  // Type signals — fixes before features, enhancements still actionable
  bug: 2,
  enhancement: 0,
  maintenance: 1,
  // Not ready to start
  "needs-breakdown": -2,
}

/**
 * Labels that signal an issue is refined and ready for implementation.
 * An issue lacking ALL of these (and not in SKIP_LABELS) needs refinement.
 * Keys are normalised at startup via normaliseLabel().
 */
const READINESS_LABELS = new Set([
  "ready",
  "ready-for-dev",
  "ready-for-development",
  "triaged",
  "confirmed",
  "accepted",
  "spec-approved",
])

/** Label that explicitly marks an issue as needing refinement. */
const NEEDS_REFINEMENT_LABEL = "needs-refinement"

const MAX_SHOWN_ISSUES = 5
const COOLDOWN_SECONDS = 30

/**
 * Sanitize session ID for use in /tmp sentinel filename.
 * Only allows alphanumeric, hyphens, underscores to prevent path traversal.
 */
function sanitizeSessionId(sessionId: string | undefined): string | null {
  if (!sessionId || typeof sessionId !== "string") return null
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
  return sessionId
}

/**
 * Generate a canonical cooldown key for a session + cwd.
 * Uses the shared getCanonicalPathHash utility for consistent key generation
 * across all hooks and commands.
 */
function getCooldownKey(sessionId: string, cwd: string): string {
  const pathHash = getCanonicalPathHash(cwd)
  return `${sessionId}-${pathHash}`
}

/**
 * Get cooldown file path using session_id and repo for stable persistence.
 * Production: same session + same repo = same cooldown file (persists across invocations)
 * Tests: different test repos = different cooldown files (no collisions)
 * Uses getCooldownKey() with full untruncated hash and path canonicalization.
 */
function getCooldownFilePath(sessionId: string, cwd: string): string {
  const key = getCooldownKey(sessionId, cwd)
  return `/tmp/stop-personal-repo-issues-${key}.cooldown`
}

/**
 * Check if the hook blocked within the last COOLDOWN_SECONDS.
 * Returns true if still in cooldown (allow stop), false if cooldown expired or no session.
 * Cooldown is per-repo-per-session to prevent production persistence while keeping tests isolated.
 * Defensive: treats any errors as "no cooldown" to ensure hook continues working.
 */
async function isInCooldown(sessionId: string | null, cwd: string): Promise<boolean> {
  // No session ID means no cooldown tracking
  if (!sessionId || typeof sessionId !== "string") return false

  const cooldownFile = getCooldownFilePath(sessionId, cwd)
  const now = Date.now()

  try {
    const stat = await Bun.file(cooldownFile).stat()
    // If stat succeeds and has mtime, check if within cooldown window
    if (stat?.mtimeMs) {
      const ageMs = now - stat.mtimeMs
      if (ageMs < COOLDOWN_SECONDS * 1000) {
        // Still in cooldown window
        return true
      }
      // Stale file — delete it to clean up
      try {
        await Bun.file(cooldownFile).unlink()
      } catch {
        // Best-effort cleanup, ignore errors
      }
    }
    return false
  } catch {
    // File doesn't exist, is unreadable, or check failed — treat as "no cooldown"
    // This ensures the hook continues to check for issues even if cooldown check breaks
    return false
  }
}

/**
 * Record that the hook is blocking now, starting a new cooldown.
 */
async function updateCooldown(sessionId: string | null, cwd: string): Promise<void> {
  if (!sessionId || typeof sessionId !== "string") return

  const cooldownFile = getCooldownFilePath(sessionId, cwd)
  try {
    await Bun.write(cooldownFile, "")
  } catch {
    // Best-effort; don't fail the hook if we can't write
  }
}

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
const READINESS_NORM = new Set([...READINESS_LABELS].map(normaliseLabel))
const NEEDS_REFINEMENT_NORM = normaliseLabel(NEEDS_REFINEMENT_LABEL)

function scoreIssue(issue: Issue): number {
  return issue.labels.reduce((sum, l) => sum + (SCORE_NORM[normaliseLabel(l.name)] ?? 0), 0)
}

/**
 * Check if an issue needs refinement before it's ready for implementation.
 * An issue needs refinement if:
 *   1. It has a `needs-refinement` label, OR
 *   2. It lacks ALL readiness labels (ready, triaged, confirmed, etc.)
 */
export function needsRefinement(issue: Issue): boolean {
  const normLabels = issue.labels.map((l) => normaliseLabel(l.name))
  // Explicit refinement label
  if (normLabels.some((nl) => nl === NEEDS_REFINEMENT_NORM)) return true
  // No readiness signal at all
  return !normLabels.some((nl) => READINESS_NORM.has(nl))
}

export interface Issue {
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

export async function getActionableIssues(cwd: string, filterUser?: string): Promise<Issue[]> {
  const jsonFields = "number,title,labels,author,assignees"
  const repoSlug = await getRepoSlug(cwd)

  // Try live GitHub first
  let issues = await ghJson<Issue[]>(
    ["issue", "list", "--state", "open", "--json", jsonFields],
    cwd
  )

  if (issues && repoSlug) {
    // Cache successful result and replay any queued mutations
    try {
      const store = getIssueStore()
      store.upsertIssues(repoSlug, issues)
      const pending = store.pendingCount(repoSlug)
      if (pending > 0) {
        const result = await replayPendingMutations(repoSlug, cwd, store)
        const parts: string[] = []
        if (result.replayed > 0) parts.push(`${result.replayed} replayed`)
        if (result.failed > 0) parts.push(`${result.failed} failed`)
        if (result.discarded > 0) parts.push(`${result.discarded} discarded`)
        if (parts.length > 0) {
          console.error(
            `[swiz] REPLAY_SUMMARY repo=${repoSlug} pending=${pending} ${parts.join(", ")}`
          )
        }
      }
    } catch (err) {
      console.error(`[swiz] REPLAY_INFRA_ERROR ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!issues && repoSlug) {
    // GitHub unavailable — fall back to cached data
    try {
      const store = getIssueStore()
      issues = store.listIssues<Issue>(repoSlug)
    } catch {
      issues = []
    }
  }

  issues = issues ?? []

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
    const sessionId = sanitizeSessionId(input.session_id)

    if (!(await isGitRepo(cwd))) return

    const settings = await readSwizSettings()
    const effective = getEffectiveSwizSettings(settings, input.session_id)
    if (!effective.personalRepoIssuesGate) return

    if (!hasGhCli()) return
    if (!(await isGitHubRemote(cwd))) return

    // Check if already blocked within cooldown window
    if (await isInCooldown(sessionId, cwd)) return

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
    const allIssues = hasChangesRequested
      ? []
      : await getActionableIssues(cwd, isPersonalRepo ? undefined : currentUser)

    // Partition: issues needing refinement vs ready for implementation
    const refinementIssues = allIssues.filter((i) => needsRefinement(i))
    const actionableIssues = allIssues.filter((i) => !needsRefinement(i))

    const issueCount = actionableIssues.length
    const refinementCount = refinementIssues.length
    const prCount = prs.length

    if (issueCount === 0 && prCount === 0 && refinementCount === 0) return

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

    if (refinementCount > 0) {
      if (reasonLines.length > 0) reasonLines.push("")
      reasonLines.push(
        `${refinementCount} issue(s) need refinement before they are ready for implementation:`
      )
      const sortedRefinement = [...refinementIssues].sort((a, b) => scoreIssue(b) - scoreIssue(a))
      const shownRefinement = sortedRefinement.slice(0, MAX_SHOWN_ISSUES)
      const hiddenRefinement = sortedRefinement.length - shownRefinement.length
      for (const issue of shownRefinement) {
        const hasExplicitLabel = issue.labels.some(
          (l) => normaliseLabel(l.name) === NEEDS_REFINEMENT_NORM
        )
        const tag = hasExplicitLabel ? "[needs-refinement]" : "[no readiness label]"
        reasonLines.push(`  #${issue.number} ${issue.title} ${tag}`)
      }
      if (hiddenRefinement > 0) {
        reasonLines.push(`  …and ${hiddenRefinement} more issue(s) needing refinement`)
      }
      reasonLines.push(
        skillAdvice(
          "refine-issue",
          "Use the /refine-issue skill to refine and label issues:\n  /refine-issue — Refine the next issue needing attention",
          "Refine issues before implementation:\n  gh issue view <number>\n  gh issue edit <number> --add-label ready"
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

    // Only set cooldown when actionable issues or PRs are shown (pickup phase).
    // Refinement-only blocks should NOT set cooldown — resolving the refinement
    // should allow the pickup check to run immediately on the next stop attempt.
    if (issueCount > 0 || prCount > 0) {
      await updateCooldown(sessionId, cwd)
    }
    // Open-issue reminders are actionable work triage, not workflow-memory misses.
    blockStop(reasonLines.join("\n"), { includeUpdateMemoryAdvice: false })
  } catch {
    // On error, allow stop (fail open)
  }
}

if (import.meta.main) {
  main()
}
