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

/**
 * Labels that satisfy the "readiness/status" category for refined issues.
 */
const READINESS_LABELS = new Set([
  "ready",
  "ready-for-dev",
  "ready-for-development",
  "triaged",
  "confirmed",
  "accepted",
  "spec-approved",
  "backlog",
])

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
const READINESS_NORM = new Set([...READINESS_LABELS].map(normaliseLabel))
const PRIORITY_NORM = new Set([...PRIORITY_LABELS].map(normaliseLabel))
export const NEEDS_REFINEMENT_NORM = normaliseLabel(NEEDS_REFINEMENT_LABEL)

/**
 * Return missing label categories required for issue refinement.
 * Every refined issue must include at least one label for:
 *   - type (bug/feature/etc.)
 *   - readiness/status (ready/triaged/etc.)
 *   - priority (priority-high, p0, etc.)
 */
export function missingRefinementCategories(issue: RefinableIssue): string[] {
  const normLabels = issue.labels.map((l) => normaliseLabel(l.name))
  const missing: string[] = []
  if (!normLabels.some((nl) => TYPE_NORM.has(nl))) missing.push("type")
  if (!normLabels.some((nl) => READINESS_NORM.has(nl))) missing.push("readiness")
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
  const normLabels = issue.labels.map((l) => normaliseLabel(l.name))
  if (normLabels.some((nl) => nl === NEEDS_REFINEMENT_NORM)) return true
  return missingRefinementCategories(issue).length > 0
}
