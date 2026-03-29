#!/usr/bin/env bun
// Reviewing-state checks module for stop-auto-continue hook
// Validates PR state (reviews, CI status, merge conflicts) before allowing session stop

import { uniq } from "lodash-es"
import {
  getOpenPrForBranch,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  skillAdvice,
} from "../../src/utils/hook-utils.ts"

export interface ReviewingPr {
  number: number
  reviews: Array<{ state: string; author: { login: string } }>
  reviewThreads: Array<{ isResolved: boolean }>
  statusCheckRollup: Array<{ state?: string; conclusion?: string; name?: string }>
}

const FAILING_STATES = new Set(["FAILURE", "ERROR"])
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"])
const PENDING_STATES = new Set(["PENDING", "EXPECTED"])

function checkPrReviewState(pr: ReviewingPr): string | null {
  const changesRequested = (pr.reviews ?? []).filter((r) => r.state === "CHANGES_REQUESTED")
  if (changesRequested.length > 0) {
    const reviewers = uniq(changesRequested.map((r) => r.author?.login).filter(Boolean))
    const who = reviewers.length > 0 ? ` from ${reviewers.join(", ")}` : ""
    return `Address CHANGES_REQUESTED review feedback${who} on PR #${pr.number} before merging.`
  }

  const unresolvedThreads = (pr.reviewThreads ?? []).filter((t) => !t.isResolved)
  if (unresolvedThreads.length > 0) {
    const count = unresolvedThreads.length
    return `Resolve ${count} unresolved review thread${count > 1 ? "s" : ""} on PR #${pr.number} before merging.`
  }

  return null
}

function checkPrCiState(pr: ReviewingPr): string | null {
  const checks = pr.statusCheckRollup ?? []
  const failingChecks = checks.filter(
    (c) => FAILING_STATES.has(c.state ?? "") || FAILING_CONCLUSIONS.has(c.conclusion ?? "")
  )
  if (failingChecks.length > 0) {
    const names = failingChecks
      .map((c) => c.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")
    const label = names ? ` (${names})` : ""
    return `Fix failing CI checks${label} on PR #${pr.number} before merging.`
  }

  const pendingChecks = checks.filter((c) => {
    const state = c.state ?? ""
    const conclusion = c.conclusion ?? ""
    return PENDING_STATES.has(state) || (conclusion === "" && state !== "SUCCESS")
  })
  if (pendingChecks.length > 0) {
    return `Wait for ${pendingChecks.length} pending CI check${pendingChecks.length > 1 ? "s" : ""} on PR #${pr.number} before merging.`
  }

  return null
}

/**
 * When the project is in `reviewing` or `addressing-feedback` state, run a
 * deterministic checklist before calling the AI backend. Returns a non-null
 * directive string (the next step to suggest) when a blocking issue is found,
 * or null when all checks pass (AI takes over).
 *
 * Priority order: conflicts → CHANGES_REQUESTED → unresolved threads → failing CI.
 */
async function checkMergeConflicts(cwd: string): Promise<string | null> {
  try {
    const conflictFiles = (await git(["diff", "--name-only", "--diff-filter=U"], cwd)).trim()
    if (!conflictFiles) return null
    const files = conflictFiles.split("\n").filter(Boolean).slice(0, 5)
    const fileList = files.map((f) => `\`${f}\``).join(", ")
    return skillAdvice(
      "resolve-conflicts",
      `Resolve merge conflicts in ${fileList} before continuing PR review: use the /resolve-conflicts skill.`,
      `Resolve merge conflicts in ${fileList} before continuing PR review: run \`git rebase --continue\` after fixing conflicts.`
    )
  } catch {
    return null
  }
}

async function validateReviewingStateInputs(
  state: string | null,
  cwd: string
): Promise<{ valid: boolean; directive?: string }> {
  if (state !== "reviewing" && state !== "addressing-feedback") {
    return { valid: false }
  }
  if (!(await isGitRepo(cwd))) {
    return { valid: false }
  }

  const conflictDirective = await checkMergeConflicts(cwd)
  if (conflictDirective) {
    return { valid: false, directive: conflictDirective }
  }

  if (!hasGhCli() || !(await isGitHubRemote(cwd))) {
    return { valid: false }
  }

  return { valid: true }
}

async function resolvePrForBranch(cwd: string): Promise<ReviewingPr | null> {
  try {
    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return null
    return await getOpenPrForBranch<ReviewingPr>(
      branch,
      cwd,
      "number,reviews,reviewThreads,statusCheckRollup"
    )
  } catch {
    return null
  }
}

export async function checkReviewingState(
  cwd: string,
  state: string | null
): Promise<string | null> {
  const validation = await validateReviewingStateInputs(state, cwd)
  if (!validation.valid) return validation.directive ?? null

  const pr = await resolvePrForBranch(cwd)
  if (!pr) return null

  const reviewDirective = checkPrReviewState(pr)
  if (reviewDirective) return reviewDirective

  const ciDirective = checkPrCiState(pr)
  if (ciDirective) return ciDirective

  // All checks pass — PR is ready to merge
  return skillAdvice(
    "pr-qa-and-merge",
    `PR #${pr.number} is ready to merge — no conflicts, no pending reviews, CI is green. Use the /pr-qa-and-merge skill to merge.`,
    `PR #${pr.number} is ready to merge — no conflicts, no pending reviews, CI is green. Run: gh pr merge ${pr.number} --squash`
  )
}
