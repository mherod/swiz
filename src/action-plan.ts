/**
 * Action plan formatting for hook and command output.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { translateMatcher } from "./agents.ts"
import { detectCurrentAgent } from "./detect.ts"

/**
 * Format a numbered action plan string from a list of steps.
 * Optionally translates canonical tool names to the current agent's equivalents.
 */
export function formatActionPlan(
  steps: string[],
  options?: { translateToolNames?: boolean; header?: string }
): string {
  if (steps.length === 0) return ""
  const agent = options?.translateToolNames ? detectCurrentAgent() : null
  const renderedSteps = agent ? steps.map((step) => translateMatcher(step, agent) ?? step) : steps
  const numbered = renderedSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
  const header = options?.header ?? "Action plan:"
  return `${header}\n${numbered}\n`
}
