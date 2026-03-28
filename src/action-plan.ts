/**
 * Action plan formatting for hook and command output.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { translateMatcher } from "./agents.ts"
import { detectCurrentAgent } from "./detect.ts"
import { filterQualitySteps, type SkillStep } from "./skill-utils.ts"
import { type MergeStep, mergeIntoTasks } from "./tasks/task-service.ts"

/** A step can be a plain string or an array of sub-steps (recursively nested). */
export type ActionPlanItem = string | ActionPlanItem[]

/**
 * Format a numbered action plan string from a list of steps.
 * Steps can be plain strings or nested arrays for sub-step hierarchies.
 * Optionally translates canonical tool names to the current agent's equivalents.
 */
export function formatActionPlan(
  steps: ActionPlanItem[],
  options?: { translateToolNames?: boolean; header?: string }
): string {
  if (steps.length === 0) return ""
  const agent = options?.translateToolNames ? detectCurrentAgent() : null
  const lines = renderItems(steps, agent, 1, "  ")
  const header = options?.header ?? "Action plan:"
  return `${header}\n${lines}\n`
}

function renderItems(
  items: ActionPlanItem[],
  agent: ReturnType<typeof detectCurrentAgent>,
  startIndex: number,
  indent: string
): string {
  const lines: string[] = []
  let index = startIndex
  for (const item of items) {
    if (typeof item === "string") {
      const text = agent ? (translateMatcher(item, agent) ?? item) : item
      lines.push(`${indent}${index}. ${text}`)
      index++
    } else {
      // Nested array: render as sub-items with deeper indent, using letters
      const subLines = renderSubItems(item, agent, `${indent}   `)
      lines.push(...subLines)
    }
  }
  return lines.join("\n")
}

function renderSubItems(
  items: ActionPlanItem[],
  agent: ReturnType<typeof detectCurrentAgent>,
  indent: string
): string[] {
  const lines: string[] = []
  for (const [i, item] of items.entries()) {
    if (typeof item === "string") {
      const text = agent ? (translateMatcher(item, agent) ?? item) : item
      const letter = String.fromCharCode(97 + (i % 26))
      lines.push(`${indent}${letter}. ${text}`)
    } else {
      // Deeper nesting: recurse with more indent
      lines.push(...renderSubItems(item, agent, `${indent}   `))
    }
  }
  return lines
}

// ─── Auto-merge action plan steps into tasks ────────────────────────────────

/**
 * Flatten an ActionPlanItem[] into MergeStep[] for task creation.
 * Top-level strings become task subjects. When a string is immediately followed
 * by a nested array, the sub-items are joined as the description.
 */
function flattenToSteps(items: ActionPlanItem[]): SkillStep[] {
  const steps: SkillStep[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (typeof item !== "string") continue
    // Check if next item is a nested sub-step array (description)
    const next = items[i + 1]
    const description = Array.isArray(next)
      ? flattenStrings(next).join("\n") || undefined
      : undefined
    steps.push({ subject: item, description })
    if (description !== undefined) i++ // skip the consumed sub-array
  }
  return steps
}

function flattenStrings(items: ActionPlanItem[]): string[] {
  const result: string[] = []
  for (const item of items) {
    if (typeof item === "string") result.push(item)
    else result.push(...flattenStrings(item))
  }
  return result
}

/**
 * Merge action plan steps into the session's task list, skipping steps that
 * already exist as pending/in_progress tasks. Applies the same quality filter
 * used for skill step extraction.
 *
 * Returns the number of tasks created.
 */
export async function mergeActionPlanIntoTasks(
  steps: ActionPlanItem[],
  sessionId: string,
  cwd?: string
): Promise<number> {
  const mergeSteps: MergeStep[] = filterQualitySteps(flattenToSteps(steps))
  if (mergeSteps.length === 0) return 0
  const created = await mergeIntoTasks(sessionId, mergeSteps, cwd)
  return created.length
}
