/**
 * Action plan formatting for hook and command output.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { join } from "node:path"
import { resolveTranslationAgent } from "./agent-paths.ts"
import { type AgentDef, translateMatcher } from "./agents.ts"
import {
  extractStepsFromSkill,
  filterQualitySteps,
  SKILL_DIRS,
  type SkillStep,
} from "./skill-utils.ts"
import { type MergeIntoTasksOptions, type MergeStep, mergeIntoTasks } from "./tasks/task-service.ts"

/** A step can be a plain string or an array of sub-steps (recursively nested). */
export type ActionPlanItem = string | ActionPlanItem[]

/**
 * Format a numbered action plan string from a list of steps.
 * Steps can be plain strings or nested arrays for sub-step hierarchies.
 * Optionally translates canonical tool names to the current agent's equivalents.
 */
export function formatActionPlan(
  steps: ActionPlanItem[],
  options?: {
    translateToolNames?: boolean
    header?: string
    agent?: AgentDef | null
    observedToolNames?: Iterable<string>
  }
): string {
  if (steps.length === 0) return ""
  const agent = options?.translateToolNames
    ? resolveTranslationAgent({
        agent: options?.agent,
        observedToolNames: options?.observedToolNames,
      })
    : null
  const lines = renderItems(steps, agent, 1, "  ")
  const header = options?.header ?? "Action plan:"
  return `${header}\n${lines}\n`
}

function renderItems(
  items: ActionPlanItem[],
  agent: AgentDef | null,
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

function renderSubItems(items: ActionPlanItem[], agent: AgentDef | null, indent: string): string[] {
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

// ─── Skill reference expansion ─────────────────────────────────────────────

/** Match `/skill-name` references in step text. */
const SKILL_REF_RE = /\/([a-z][a-z0-9-]*)/g

/**
 * Resolve a skill name to its SKILL.md content, or null if not found.
 */
async function resolveSkillContent(skillName: string): Promise<string | null> {
  for (const dir of SKILL_DIRS) {
    const file = Bun.file(join(dir, skillName, "SKILL.md"))
    if (await file.exists()) return file.text()
  }
  return null
}

/**
 * Expand skill references in action plan steps.
 *
 * When a top-level step string contains a `/skill-name` pattern and that skill
 * exists on disk, the skill's extracted steps are appended as a nested sub-step
 * array immediately after the referencing step.
 *
 * Steps that already have a sub-step array (next item is an array) are skipped
 * to avoid overwriting explicitly provided sub-steps.
 */
export async function expandSkillReferences(steps: ActionPlanItem[]): Promise<ActionPlanItem[]> {
  const result: ActionPlanItem[] = []

  for (let i = 0; i < steps.length; i++) {
    const item = steps[i]!
    result.push(item)

    if (typeof item !== "string") continue
    // Skip if already followed by explicit sub-steps
    if (Array.isArray(steps[i + 1])) continue

    // Find all skill references in this step
    const refs = [...item.matchAll(SKILL_REF_RE)].map((m) => m[1]!)
    if (refs.length === 0) continue

    // Try each ref until one resolves to steps
    for (const ref of refs) {
      const content = await resolveSkillContent(ref)
      if (!content) continue

      const skillSteps = filterQualitySteps(extractStepsFromSkill(content))
      if (skillSteps.length === 0) continue

      // Inline as sub-step array
      result.push(skillSteps.map((s) => s.subject))
      break // only expand the first matching skill per step
    }
  }

  return result
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
  cwd?: string,
  mergeOptions?: MergeIntoTasksOptions
): Promise<number> {
  const mergeSteps: MergeStep[] = filterQualitySteps(flattenToSteps(steps))
  if (mergeSteps.length === 0) return 0
  const created = await mergeIntoTasks(sessionId, mergeSteps, cwd, mergeOptions)
  return created.length
}
