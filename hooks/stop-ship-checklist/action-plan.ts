/**
 * Unified action plan generation for the ship checklist.
 *
 * Combines workflow steps from git, CI, and issues into a single ordered
 * numbered checklist. Order is always: git → CI → issues (workflow sequence).
 */

import type { ActionPlanItem } from "../../src/utils/hook-utils.ts"
import { formatActionPlan } from "../../src/utils/hook-utils.ts"
import type { WorkflowStep } from "./types.ts"

/**
 * Build a unified preamble and action plan from workflow steps.
 * Steps are ordered by kind: git → ci → issues.
 * Skipped workflows (not blocking) don't appear in the plan.
 */
export function buildUnifiedActionPlan(steps: WorkflowStep[]): {
  preamble: string
  plan: string
} {
  // Sort steps by workflow order: git → ci → issues
  const ordered = steps.sort((a, b) => {
    const order = { git: 0, ci: 1, issues: 2 }
    return order[a.kind] - order[b.kind]
  })

  const combinedPlan: ActionPlanItem[] = []

  for (const step of ordered) {
    const label =
      step.kind === "git"
        ? "Repository — commit, pull, and push"
        : step.kind === "ci"
          ? "CI on your branch"
          : "Issues and pull requests"

    combinedPlan.push([label, step.planSteps])
  }

  const plan = formatActionPlan(combinedPlan, {
    header: "Single action plan (do in this order):",
    translateToolNames: true,
  })

  return {
    preamble:
      "You cannot stop until everything below is resolved. Follow the single action plan in order.",
    plan,
  }
}

/**
 * Format the full stop message: preamble + sections + unified action plan.
 */
export function formatStopMessage(steps: WorkflowStep[]): string {
  const sections: string[] = [
    "You cannot stop until everything below is resolved. Follow the single action plan in order.",
  ]

  for (const step of steps) {
    const heading =
      step.kind === "git"
        ? "### Repository"
        : step.kind === "ci"
          ? "### GitHub CI"
          : "### Open issues and pull requests"

    sections.push(`${heading}\n${step.summary.trim()}`)
  }

  const { plan } = buildUnifiedActionPlan(steps)

  return `${sections.join("\n\n")}\n\n${plan}`
}
