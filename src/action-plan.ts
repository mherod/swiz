/**
 * Action plan formatting for hook and command output.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { translateMatcher } from "./agents.ts"
import { detectCurrentAgent } from "./detect.ts"

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
