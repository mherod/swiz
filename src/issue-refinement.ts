/**
 * Issue refinement heuristics — shared by stop hooks and commands.
 * Determines whether an issue needs refinement (type/readiness/priority labels)
 * before it is ready for implementation.
 */

import { orderBy } from "lodash-es"

export interface RefinableIssue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
  /** Verified native child count; absent means decomposition has not been checked. */
  nativeChildCount?: number
}

/**
 * Normalise a label name for agnostic matching:
 *  1. Lowercase
 *  2. Collapse any separator (: / -) to :
 *  3. Sort segments alphabetically
 * Result: "priority:high", "priority/high", "priority-high", and
 * "high-priority" all normalise to the same canonical key.
 */
export function normaliseLabel(name: string): string {
  const segments = name.toLowerCase().replace(/[/-]/g, ":").split(":")
  return orderBy(segments, [(segment) => segment], ["asc"]).join(":")
}

/**
 * Labels that satisfy the "type" category for refined issues.
 */
const TYPE_LABELS = new Set([
  "bug",
  "enhancement",
  "documentation",
  "chore",
  "feature",
  "question",
  "maintenance",
  "tech-debt",
  "help wanted",
  "good first issue",
])

/** Exactly one canonical state is required; only ready permits implementation. */
export const CANONICAL_READINESS = [
  "ready",
  "backlog",
  "blocked",
  "waiting",
  "needs-breakdown",
] as const
export type IssueReadiness = (typeof CANONICAL_READINESS)[number]

export const READINESS_GUIDANCE =
  `Keep exactly one readiness label (${CANONICAL_READINESS.join(", ")}). ` +
  "Only ready permits pickup. Backlog defers work; blocked needs an open same-repository dependency; " +
  "waiting needs external evidence and an owner; needs-breakdown keeps a coordination parent out of pickup while its native children own implementation. " +
  "Resolve conflicting states by replacing the obsolete state, never adding a second state."

export function canonicalReadiness(issue: RefinableIssue): IssueReadiness[] {
  const labels = (issue.labels ?? []).map((label) => normaliseLabel(label.name))
  return CANONICAL_READINESS.filter((state) => labels.includes(normaliseLabel(state)))
}

export function breakdownReviewReason(issue: RefinableIssue): string | null {
  const states = canonicalReadiness(issue)
  if (states.length !== 1 || states[0] !== "needs-breakdown") return null
  if (issue.nativeChildCount === undefined) return "native child decomposition unverified"
  return issue.nativeChildCount === 0 ? "missing native child decomposition" : null
}

export function refinementReasons(issue: RefinableIssue): string[] {
  const reasons = missingRefinementCategories(issue).map((category) => `missing ${category}`)
  const states = canonicalReadiness(issue)
  if (states.length > 1) reasons.push(`conflicting readiness: ${states.join(", ")}`)
  const breakdown = breakdownReviewReason(issue)
  if (breakdown) reasons.push(breakdown)
  return reasons
}

export function isReadyForImplementation(issue: RefinableIssue): boolean {
  const states = canonicalReadiness(issue)
  return states.length === 1 && states[0] === "ready" && !needsRefinement(issue)
}

/**
 * Labels that satisfy the "priority" category for refined issues.
 */
const PRIORITY_LABELS = new Set([
  "priority:critical",
  "priority:high",
  "priority:medium",
  "priority:low",
  "p0",
  "p1",
  "p2",
  "p3",
])

/** Label that explicitly marks an issue as needing refinement. */
const NEEDS_REFINEMENT_LABEL = "needs-refinement"

// Pre-compute normalised lookups.
const TYPE_NORM = new Set([...TYPE_LABELS].map(normaliseLabel))
const PRIORITY_NORM = new Set([...PRIORITY_LABELS].map(normaliseLabel))
export const NEEDS_REFINEMENT_NORM = normaliseLabel(NEEDS_REFINEMENT_LABEL)

/**
 * Return missing label categories required for issue refinement.
 * Every refined issue must include at least one label for:
 *   - type (bug/feature/etc.)
 *   - canonical readiness/status
 *   - priority (priority-high, p0, etc.)
 */
export function missingRefinementCategories(issue: RefinableIssue): string[] {
  const normLabels = (issue.labels ?? []).map((l) => normaliseLabel(l.name))
  const missing: string[] = []
  if (!normLabels.some((nl) => TYPE_NORM.has(nl))) missing.push("type")
  if (canonicalReadiness(issue).length === 0) missing.push("readiness")
  if (!normLabels.some((nl) => PRIORITY_NORM.has(nl))) missing.push("priority")
  return missing
}

/**
 * Check if an issue needs refinement before it's ready for implementation.
 * An issue needs refinement if:
 *   1. It has a `needs-refinement` label, OR
 *   2. It is missing one or more required label categories
 *      (type + readiness/status + priority)
 */
export function needsRefinement(issue: RefinableIssue): boolean {
  const normLabels = (issue.labels ?? []).map((l) => normaliseLabel(l.name))
  if (normLabels.some((nl) => nl === NEEDS_REFINEMENT_NORM)) return true
  return missingRefinementCategories(issue).length > 0 || canonicalReadiness(issue).length > 1
}
