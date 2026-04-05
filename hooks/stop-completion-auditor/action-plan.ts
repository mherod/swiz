/**
 * Action Plan Generation Module
 *
 * Builds unified action plan from all validation failures.
 * Orders steps by priority: task-creation → audit-log → ci-evidence
 * Creates task suggestions for agents.
 */

import { formatActionPlan } from "../../src/utils/hook-utils.ts"
import type { ActionPlanItem, ValidationResult } from "./types.ts"

/**
 * Merge multiple validation results into a single prioritized action plan.
 * Returns null if all validators passed (kind: "ok").
 */
export function buildActionPlan(results: ValidationResult[]): {
  reason: string
  planSteps: ActionPlanItem[]
} | null {
  // Filter out "ok" results
  const failures = results.filter((r) => r.kind !== "ok")

  if (failures.length === 0) return null

  // Merge all plan steps and order by priority
  const allSteps: ActionPlanItem[] = []
  for (const failure of failures) {
    if (failure.planSteps) {
      allSteps.push(...failure.planSteps)
    }
  }

  // Sort by priority (lower = higher)
  allSteps.sort((a, b) => a.priority - b.priority)

  // Build reason from first failure (highest priority)
  const reason = (failures[0]?.reason ?? null) || "Validation failed"

  return { reason, planSteps: allSteps }
}

/**
 * Format action plan results with tool name translation and context.
 */
export function formatBlockReason(
  plan: { reason: string; planSteps: ActionPlanItem[] },
  observedToolNames: string[]
): string {
  const descriptions = plan.planSteps.map((s) => s.description)
  const formatted = formatActionPlan(descriptions, {
    translateToolNames: true,
    observedToolNames,
  })
  return plan.reason + "\n\n" + formatted
}
