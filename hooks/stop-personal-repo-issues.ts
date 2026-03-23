#!/usr/bin/env bun

/**
 * Stop hook: Check for open issues and PRs needing attention
 * Blocks stop if a personal GitHub repo has open issues, or if
 * the current user has self-authored or self-assigned issues in an org repo.
 */

import { orderBy, uniqBy } from "lodash-es"
import { detectRepoOwnership } from "../src/collaboration-policy.ts"
import {
  missingRefinementCategories,
  NEEDS_REFINEMENT_NORM,
  needsRefinement,
  normaliseLabel,
} from "../src/issue-refinement.ts"
import { getDaemonBackedStore, getIssueStore, replayPendingMutations } from "../src/issue-store.ts"
import { stopPersonalRepoIssuesCooldownPath } from "../src/temp-paths.ts"
import { stopHookInputSchema } from "./schemas.ts"
import {
  blockStop,
  formatActionPlan,
  getCanonicalPathHash,
  getRepoSlug,
  ghJson,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  sanitizeSessionId,
  skillAdvice,
} from "./utils/hook-utils.ts"

export { missingRefinementCategories, needsRefinement }

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

const MAX_SHOWN_ISSUES = 5
const REBASE_SUGGESTIONS_PER_SIDE = 2
const COOLDOWN_SECONDS = 30

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
  return stopPersonalRepoIssuesCooldownPath(key)
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

// Pre-compute normalised lookups so source tables stay human-readable.
const SKIP_NORM = new Set([...SKIP_LABELS].map(normaliseLabel))
const SCORE_NORM: Record<string, number> = Object.fromEntries(
  Object.entries(LABEL_SCORE).map(([k, v]) => [normaliseLabel(k), v])
)

function scoreIssue(issue: Issue): number {
  return (issue.labels ?? []).reduce((sum, l) => sum + (SCORE_NORM[normaliseLabel(l.name)] ?? 0), 0)
}

export interface Issue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
}

export interface PR {
  number: number
  title: string
  url: string
  reviewDecision: string
  mergeable: string
  createdAt?: string
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logHookEvent(event: string, details: string): void {
  console.error(`[swiz][stop-personal-repo-issues] ${event} ${details}`)
}

function getPrCreatedAtMs(pr: PR): number {
  if (!pr.createdAt) return Number.NaN
  return new Date(pr.createdAt).getTime()
}

/**
 * Deterministically order PR candidates by recency.
 * Primary: createdAt (newest first)
 * Fallback: PR number (newest first by monotonic numbering)
 */
export function orderRebaseSuggestionPRs(prs: PR[]): PR[] {
  return orderBy(
    prs,
    [
      (pr) => (Number.isNaN(getPrCreatedAtMs(pr)) ? 0 : 1),
      (pr) => (Number.isNaN(getPrCreatedAtMs(pr)) ? Number.MIN_SAFE_INTEGER : getPrCreatedAtMs(pr)),
      (pr) => pr.number,
    ],
    ["desc", "desc", "desc"]
  )
}

/**
 * Suggest only the oldest and newest conflicting PRs for rebase.
 * GitHub PR numbers are monotonic, so they act as a stable fallback when
 * createdAt is unavailable or invalid in mocks / degraded CLI responses.
 */
export function selectRebaseSuggestionPRs(
  prs: PR[],
  perSide = REBASE_SUGGESTIONS_PER_SIDE
): { shown: PR[]; hiddenCount: number } {
  const ordered = orderRebaseSuggestionPRs(prs)
  if (ordered.length <= perSide * 2) return { shown: ordered, hiddenCount: 0 }

  const newest = ordered.slice(0, perSide)
  const oldest = ordered.slice(-perSide).reverse()
  const shown = uniqBy([...newest, ...oldest], "number")

  return {
    shown,
    hiddenCount: Math.max(0, prs.length - shown.length),
  }
}

async function cacheIssuesAndReplayMutations(
  repoSlug: string,
  issues: Issue[],
  cwd: string
): Promise<void> {
  try {
    const store = getIssueStore()
    store.upsertIssues(repoSlug, issues)
    const pending = store.pendingCount(repoSlug)
    if (pending <= 0) return

    const result = await replayPendingMutations(repoSlug, cwd, store)
    const parts: string[] = []
    if (result.replayed > 0) parts.push(`${result.replayed} replayed`)
    if (result.failed > 0) parts.push(`${result.failed} failed`)
    if (result.discarded > 0) parts.push(`${result.discarded} discarded`)
    if (parts.length > 0) {
      logHookEvent("REPLAY_SUMMARY", `repo=${repoSlug} pending=${pending} ${parts.join(", ")}`)
    }
  } catch (err) {
    logHookEvent("REPLAY_INFRA_ERROR", getErrorMessage(err))
  }
}

function readCachedIssues(repoSlug: string): Issue[] {
  try {
    const store = getIssueStore()
    // Pass ttlMs=0 so the stop hook always gets fresh data from the store.
    // Without this, issues closed between retries remain cached for up to 5
    // minutes, blocking session termination indefinitely. (#325)
    return store.listIssues<Issue>(repoSlug, 0)
  } catch {
    return []
  }
}

function filterVisibleIssues(issues: Issue[], filterUser?: string): Issue[] {
  const userFiltered = filterUser
    ? issues.filter(
        (i) => i.author?.login === filterUser || i.assignees?.some((a) => a.login === filterUser)
      )
    : issues
  return userFiltered.filter(
    (i) => !(i.labels ?? []).some((l) => SKIP_NORM.has(normaliseLabel(l.name)))
  )
}

export async function getActionableIssues(cwd: string, filterUser?: string): Promise<Issue[]> {
  const repoSlug = await getRepoSlug(cwd)
  if (!repoSlug) return []

  // Store-first: use cached data if fresh
  const cached = readCachedIssues(repoSlug)
  if (cached.length > 0) {
    return filterVisibleIssues(cached, filterUser)
  }

  // Daemon-backed store: try daemon HTTP API directly when SQLite is empty
  const daemonIssues = await getDaemonBackedStore().listIssues<Issue>(repoSlug)
  if (daemonIssues.length > 0) {
    // Populate the local SQLite store so subsequent reads (within TTL) are fast
    try {
      getIssueStore().upsertIssues(repoSlug, daemonIssues)
    } catch {
      // Non-fatal: local cache write failure shouldn't block the hook
    }
    return filterVisibleIssues(daemonIssues, filterUser)
  }

  // Final fallback: direct gh CLI
  const jsonFields = "number,title,labels,author,assignees"
  const liveIssues = await ghJson<Issue[]>(
    ["issue", "list", "--state", "open", "--json", jsonFields],
    cwd
  )

  if (liveIssues) {
    await cacheIssuesAndReplayMutations(repoSlug, liveIssues, cwd)
  }

  return filterVisibleIssues(liveIssues ?? [], filterUser)
}

async function getOpenPRsWithFeedback(cwd: string, currentUser: string): Promise<PR[]> {
  const repoSlug = await getRepoSlug(cwd)

  // Store-first: try to read PRs from the IssueStore
  if (repoSlug) {
    const store = getIssueStore()
    const cachedPrs = store.listPullRequests<PR & { author?: { login: string } }>(repoSlug)
    if (cachedPrs.length > 0) {
      // Filter locally: authored by or assigned to current user
      const relevant = cachedPrs.filter((pr) => pr.author?.login === currentUser)
      return relevant.filter(
        (p) =>
          p.reviewDecision === "CHANGES_REQUESTED" ||
          p.reviewDecision === "REVIEW_REQUIRED" ||
          p.mergeable === "CONFLICTING"
      )
    }
  }

  // Fallback: direct gh CLI calls
  const jsonFields = "number,title,url,reviewDecision,mergeable,createdAt"
  const [authoredPrs, reviewerPrs] = await Promise.all([
    ghJson<PR[]>(
      ["pr", "list", "--state", "open", "--author", currentUser, "--json", jsonFields],
      cwd
    ),
    ghJson<PR[]>(
      ["pr", "list", "--state", "open", "--reviewer", currentUser, "--json", jsonFields],
      cwd
    ),
  ])

  // Merge both lists, deduplicating by PR number
  const byNumber = new Map<number, PR>()
  for (const pr of [...(authoredPrs ?? []), ...(reviewerPrs ?? [])]) {
    byNumber.set(pr.number, pr)
  }

  // Cache fetched PRs in the store
  if (repoSlug) {
    const allPrs = [...byNumber.values()]
    if (allPrs.length > 0) {
      getIssueStore().upsertPullRequests(repoSlug, allPrs)
    }
  }

  return [...byNumber.values()].filter(
    (p) =>
      p.reviewDecision === "CHANGES_REQUESTED" ||
      p.reviewDecision === "REVIEW_REQUIRED" ||
      p.mergeable === "CONFLICTING"
  )
}

interface StopContext {
  cwd: string
  sessionId: string | null
  isPersonalRepo: boolean
  changesRequestedPRs: PR[]
  reviewRequiredPRs: PR[]
  conflictingPRs: PR[]
  sortedRefinement: Issue[]
  sortedIssues: Issue[]
  firstRefinementNum?: number
  firstIssueNum?: number
}

function buildFeedbackPRSection(ctx: StopContext): string[] {
  const lines: string[] = []
  const feedbackPRs = [...ctx.changesRequestedPRs, ...ctx.reviewRequiredPRs]
  const allChangesRequested = feedbackPRs.every((p) => p.reviewDecision === "CHANGES_REQUESTED")
  const label = allChangesRequested
    ? "changes requested"
    : "pending feedback (CHANGES_REQUESTED or REVIEW_REQUIRED)"
  lines.push(`You have ${feedbackPRs.length} open PR(s) with ${label}:`)
  for (const pr of feedbackPRs) {
    const decisionTag =
      pr.reviewDecision === "CHANGES_REQUESTED" ? "[changes requested]" : "[review required]"
    lines.push(`  #${pr.number} ${pr.title} ${decisionTag}`)
    lines.push(`    ${pr.url}`)
  }
  return lines
}

function buildConflictSection(ctx: StopContext): string[] {
  const lines: string[] = []
  lines.push(`You have ${ctx.conflictingPRs.length} open PR(s) with merge conflicts:`)
  const { shown: shownConflictingPRs, hiddenCount: hiddenConflictingPRs } =
    selectRebaseSuggestionPRs(ctx.conflictingPRs)
  for (const pr of shownConflictingPRs) {
    lines.push(`  #${pr.number} ${pr.title} [merge conflicts]`)
    lines.push(`    ${pr.url}`)
  }
  if (hiddenConflictingPRs > 0) {
    lines.push(`  …and ${hiddenConflictingPRs} more conflicting PR(s) between those extremes`)
  }
  const rebaseAdvice = skillAdvice(
    "rebase-onto-main",
    [
      "Use the /rebase-onto-main skill to rebase and resolve conflicts:",
      "  /rebase-onto-main --push",
    ].join("\n"),
    [
      "Rebase manually:",
      "  git fetch origin",
      "  git checkout <branch>",
      "  git rebase origin/<base-branch>",
      "  # resolve conflicts, then:",
      "  git rebase --continue",
      "  git push --force-with-lease",
    ].join("\n")
  )
  const resolveAdvice = skillAdvice(
    "resolve-conflicts",
    "Use the /resolve-conflicts skill if the rebase encounters conflicts.",
    "Resolve conflicts: edit files, remove markers, git add <file>, git rebase --continue"
  )
  lines.push(
    formatActionPlan([rebaseAdvice, resolveAdvice], {
      header: "Rebase conflicting PRs before stopping:",
      translateToolNames: true,
    })
  )
  return lines
}

function buildRefinementSection(ctx: StopContext): string[] {
  const lines: string[] = []
  lines.push(
    `${ctx.sortedRefinement.length} issue(s) need refinement before they are ready for implementation:`
  )
  const shownRefinement = ctx.sortedRefinement.slice(0, MAX_SHOWN_ISSUES)
  const hiddenRefinement = ctx.sortedRefinement.length - shownRefinement.length
  for (const issue of shownRefinement) {
    const hasExplicitLabel = issue.labels.some(
      (l) => normaliseLabel(l.name) === NEEDS_REFINEMENT_NORM
    )
    const missing = missingRefinementCategories(issue)
    const tag = hasExplicitLabel ? "[needs-refinement]" : `[missing labels: ${missing.join(", ")}]`
    lines.push(`  #${issue.number} ${issue.title} ${tag}`)
  }
  if (hiddenRefinement > 0) {
    lines.push(`  …and ${hiddenRefinement} more issue(s) needing refinement`)
  }
  return lines
}

function buildIssueSection(ctx: StopContext): string[] {
  const lines: string[] = []
  const issueContext = ctx.isPersonalRepo
    ? "in this personal repository"
    : "assigned to or created by you in this repository"
  lines.push(`You have ${ctx.sortedIssues.length} open issue(s) ${issueContext}:`)
  const shownIssues = ctx.sortedIssues.slice(0, MAX_SHOWN_ISSUES)
  const hiddenCount = ctx.sortedIssues.length - shownIssues.length
  for (const issue of shownIssues) {
    lines.push(`  #${issue.number} ${issue.title}`)
  }
  if (hiddenCount > 0) {
    lines.push(`  …and ${hiddenCount} more lower-priority issue(s)`)
  }
  return lines
}

function appendSection(lines: string[], section: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("")
  lines.push(...section)
}

function buildStopReasonLines(ctx: StopContext): string[] {
  const reasonLines: string[] = [
    "STOP: We have detected open issues and PRs that need your attention.",
    "",
  ]

  if (ctx.changesRequestedPRs.length + ctx.reviewRequiredPRs.length > 0) {
    appendSection(reasonLines, buildFeedbackPRSection(ctx))
  }
  if (ctx.conflictingPRs.length > 0) {
    appendSection(reasonLines, buildConflictSection(ctx))
  }
  if (ctx.sortedRefinement.length > 0) {
    appendSection(reasonLines, buildRefinementSection(ctx))
  }
  if (ctx.sortedIssues.length > 0) {
    appendSection(reasonLines, buildIssueSection(ctx))
  }

  return reasonLines
}

function buildStopPlanSteps(ctx: StopContext): string[] {
  const planSteps: string[] = []
  const feedbackPRCount = ctx.changesRequestedPRs.length + ctx.reviewRequiredPRs.length
  const refinementCount = ctx.sortedRefinement.length
  const issueCount = ctx.sortedIssues.length
  if (feedbackPRCount > 0) {
    const firstPrNum =
      ctx.changesRequestedPRs[0]?.number ?? ctx.reviewRequiredPRs[0]?.number ?? "<number>"
    const workOnPrsSkill = [
      "Use the /work-on-prs skill to address all feedback and resolve reviews:",
      "  /work-on-prs — Start working on the next PR",
    ].join("\n")
    const workOnPrsFallback = formatActionPlan(
      [
        `Read ALL feedback for PR #${firstPrNum}: top-level comments, inline review comments, and review summaries`,
        "Implement a fix for each unresolved item; commit each fix separately",
        "Run quality checks: bun run typecheck && bun run lint && bun test",
        `Push and verify CI: git push && gh pr checks ${firstPrNum}`,
        `Dismiss stale CHANGES_REQUESTED reviews and request re-review: gh pr edit ${firstPrNum} --add-reviewer <reviewer>`,
      ],
      { header: "Address all PR feedback before stopping:" }
    )
    planSteps.push(skillAdvice("work-on-prs", workOnPrsSkill, workOnPrsFallback))
  }
  if (refinementCount > 0) {
    const refineArg = ctx.firstRefinementNum !== undefined ? ` ${ctx.firstRefinementNum}` : ""
    const refineSkill = [
      "Use the /refine-issue skill to refine and label issues:",
      `  /refine-issue${refineArg} — Refine the next issue needing attention`,
    ].join("\n")
    const refineFallback = [
      "Refine issues before implementation. Every issue MUST have at least one label from each category:",
      "  1. Type (bug, enhancement, documentation)",
      "  2. Readiness (ready, triaged, backlog)",
      "  3. Priority (priority-high, priority-medium, priority-low)",
      "",
      "Commands:",
      "  gh label list",
      '  gh issue edit <number> --add-label "bug,ready,priority-high" --remove-label "needs-triage"',
      "",
      "Rule: If you created the issue, NEVER add new comments. Always edit the original issue body instead to add proposals/context.",
    ].join("\n")
    planSteps.push(skillAdvice("refine-issue", refineSkill, refineFallback))
  }
  if (issueCount > 0) {
    const issueArg = ctx.firstIssueNum !== undefined ? ` ${ctx.firstIssueNum}` : ""
    const issueNum = ctx.firstIssueNum ?? "<number>"
    const workOnIssueSkill = [
      "Use the /work-on-issue skill (follow its full guide — the steps below are a quick reference):",
      `  /work-on-issue${issueArg} — Start working on the next issue`,
    ].join("\n")
    const workOnIssueFallback = [
      `Pick up and resolve issue #${issueNum} before stopping:`,
      "",
      "Step 0 — Check for existing work first:",
      `  LINKED_PR=$(gh pr list --search "linked:${issueNum} OR ${issueNum} in:title" --state open --json number,url --limit 1)`,
      '  echo "Linked PRs: $LINKED_PR"',
      "  git fetch origin --prune",
      "",
      `  If an open PR for #${issueNum} exists with passing checks → merge it (gh pr merge <PR_NUMBER> --squash).`,
      "  If checks are failing → switch to the PR branch and fix them.",
      "  If no PR exists → proceed to claim and implement.",
      "",
      "Step 0.5 — Claim ownership:",
      `  gh issue edit ${issueNum} --add-assignee @me`,
      "",
      "Step 0.7 — Verify branch starting point:",
      "  git branch --show-current  # must be main for a solo repo",
      "  git pull --rebase --autostash",
      "",
      `Step 1 — Plan with TaskCreate before touching any code (issue #${issueNum}):`,
      "  1. Analyze issue requirements",
      "  2. Implement solution",
      "  3. Run quality checks (bun run typecheck && bun run lint && bun test)",
      "  4. Commit, push, and verify CI",
      `  5. swiz issue resolve ${issueNum} --body "<evidence>"`,
      "",
      `Step 2a — Check for blockers on #${issueNum}:`,
      `  gh issue view ${issueNum} --json labels -q '.labels[].name' | rg -i blocked`,
      `  gh issue view ${issueNum} --json body -q '.body' | rg -i 'blocked by|depends on'`,
      `  If #${issueNum} is blocked → resolve the blocking issue first.`,
      "",
      "Step 4 — Quality checks (MANDATORY before commit):",
      "  bun run typecheck",
      "  bun run lint",
      "  bun test --concurrent",
    ].join("\n")
    planSteps.push(skillAdvice("work-on-issue", workOnIssueSkill, workOnIssueFallback))
  }
  return planSteps
}

async function gatherStopContext(
  cwd: string,
  sessionId: string | null,
  isPersonalRepo: boolean,
  currentUser: string,
  hasChangesRequested: boolean
): Promise<{
  sortedRefinement: Issue[]
  sortedIssues: Issue[]
  firstRefinementNum?: number
  firstIssueNum?: number
}> {
  const allIssues = hasChangesRequested
    ? []
    : await getActionableIssues(cwd, isPersonalRepo ? undefined : currentUser)

  const refinementIssues = allIssues.filter((i) => needsRefinement(i))
  const actionableIssues = allIssues.filter((i) => !needsRefinement(i))

  const sortedRefinement = orderBy(
    refinementIssues,
    [(issue) => scoreIssue(issue), (issue) => issue.number],
    ["desc", "desc"]
  )
  const sortedIssues = orderBy(
    actionableIssues,
    [(issue) => scoreIssue(issue), (issue) => issue.number],
    ["desc", "desc"]
  )

  void sessionId // parameter kept for interface consistency
  return {
    sortedRefinement,
    sortedIssues,
    firstRefinementNum: sortedRefinement[0]?.number,
    firstIssueNum: sortedIssues[0]?.number,
  }
}

interface RepoContext {
  cwd: string
  sessionId: string | null
  rawSessionId: string | undefined
  currentUser: string
  isPersonalRepo: boolean
}

async function resolveRepoContext(input: {
  cwd?: string
  session_id?: string
}): Promise<RepoContext | null> {
  const cwd = input.cwd ?? process.cwd()
  const sessionId = sanitizeSessionId(input.session_id)

  if (!(await isGitRepo(cwd))) return null
  if (!hasGhCli()) return null

  const [hasRemote, inCooldown] = await Promise.all([
    isGitHubRemote(cwd),
    isInCooldown(sessionId, cwd),
  ])
  if (!hasRemote) return null
  if (inCooldown) return null

  const ownership = await detectRepoOwnership(cwd)
  if (!ownership.repoOwner || !ownership.currentUser) return null

  return {
    cwd,
    sessionId,
    rawSessionId: input.session_id,
    currentUser: ownership.currentUser,
    isPersonalRepo: ownership.isPersonalRepo,
  }
}

function buildStopContext(
  ctx: RepoContext,
  prs: PR[],
  gathered: Awaited<ReturnType<typeof gatherStopContext>>
): StopContext | null {
  const changesRequestedPRs = prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED")
  const conflictingPRs = prs.filter((p) => p.mergeable === "CONFLICTING")
  const reviewRequiredPRs = prs.filter((p) => p.reviewDecision === "REVIEW_REQUIRED")

  const total =
    gathered.sortedIssues.length +
    gathered.sortedRefinement.length +
    changesRequestedPRs.length +
    reviewRequiredPRs.length +
    conflictingPRs.length
  if (total === 0) return null

  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    isPersonalRepo: ctx.isPersonalRepo,
    changesRequestedPRs,
    reviewRequiredPRs,
    conflictingPRs,
    sortedRefinement: gathered.sortedRefinement,
    sortedIssues: gathered.sortedIssues,
    firstRefinementNum: gathered.sortedRefinement[0]?.number,
    firstIssueNum: gathered.sortedIssues[0]?.number,
  }
}

async function main(): Promise<void> {
  try {
    const input = stopHookInputSchema.parse(await Bun.stdin.json())
    const ctx = await resolveRepoContext(input)
    if (!ctx) return

    const prs = await getOpenPRsWithFeedback(ctx.cwd, ctx.currentUser)
    const hasChangesRequested = prs.some((p) => p.reviewDecision === "CHANGES_REQUESTED")
    const gathered = await gatherStopContext(
      ctx.cwd,
      ctx.sessionId,
      ctx.isPersonalRepo,
      ctx.currentUser,
      hasChangesRequested
    )

    const stopCtx = buildStopContext(ctx, prs, gathered)
    if (!stopCtx) return

    const reasonLines = buildStopReasonLines(stopCtx)
    const planSteps = buildStopPlanSteps(stopCtx)
    reasonLines.push(formatActionPlan(planSteps, { translateToolNames: true }))

    const hasActionable =
      stopCtx.sortedIssues.length > 0 ||
      stopCtx.changesRequestedPRs.length + stopCtx.reviewRequiredPRs.length > 0 ||
      stopCtx.conflictingPRs.length > 0
    if (hasActionable) await updateCooldown(ctx.sessionId, ctx.cwd)

    blockStop(reasonLines.join("\n"), { includeUpdateMemoryAdvice: false })
  } catch {
    // On error, allow stop (fail open)
  }
}

if (import.meta.main) {
  void main()
}
