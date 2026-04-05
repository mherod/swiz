/**
 * Domain types for the unified ship checklist workflow.
 *
 * The ship checklist combines three concerns: git workflow (commit/pull/push),
 * GitHub CI polling/waiting, and actionable issues/PRs. Each concern is
 * independently optional (gated by settings), but when present, they're unified
 * into a single numbered action plan.
 */

import type { ActionPlanItem } from "../../src/utils/hook-utils.ts"

/**
 * Workflow gates that can be independently enabled/disabled.
 */
export interface WorkflowGates {
  git: boolean
  ci: boolean
  issues: boolean
}

/**
 * Result from a single workflow concern (git, CI, or issues).
 */
export interface WorkflowStep {
  kind: "git" | "ci" | "issues"
  summary: string
  planSteps: ActionPlanItem[]
}

/**
 * Resolved context for all three workflows. Loaded once from settings
 * and passed to each workflow concern for evaluation.
 */
export interface ShipChecklistContext {
  cwd: string
  sessionId: string | undefined
  gates: WorkflowGates
  // Additional state may be added here as needed (branch, repo slug, etc.)
}

/**
 * Final result of the unified ship checklist evaluation.
 * If any workflows are blocking, blocked=true and steps contain all relevant concerns.
 */
export interface ShipChecklistResult {
  blocked: boolean
  steps: WorkflowStep[]
}
