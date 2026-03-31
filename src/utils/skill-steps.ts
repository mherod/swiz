/**
 * Shared logic for creating tasks from skill steps.
 * Used by both posttooluse-skill-steps.ts and userpromptsubmit-skill-steps.ts.
 */

import { join } from "node:path"
import { z } from "zod"
import { hasAiProvider, promptObject } from "../ai-providers.ts"
import { extractStepsFromSkill, filterQualitySteps, SKILL_DIRS } from "../skill-utils.ts"
import type { Task } from "../tasks/task-repository.ts"
import { type MergeStep, mergeIntoTasks } from "../tasks/task-service.ts"
import { expandInlineCommands, substituteArgs } from "./skill-content.ts"

export interface SkillStepsResult {
  skillName: string
  created: Task[]
}

const RefinedStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        subject: z.string().describe("Imperative task title, e.g. 'Run integration tests'"),
        description: z.string().describe("What needs to be done in 1-2 sentences"),
      })
    )
    .min(3)
    .describe("Refined, actionable tasks derived from the skill steps"),
})

/**
 * Use AI to refine raw skill steps into ≥3 well-structured tasks.
 * Returns null if no provider is available or the call fails.
 */
async function refineStepsWithAi(
  skillName: string,
  rawSteps: MergeStep[],
  skillContent: string
): Promise<MergeStep[] | null> {
  if (!hasAiProvider()) return null

  const stepList = rawSteps.map((s, i) => `${i + 1}. ${s.subject}`).join("\n")
  const prompt = [
    `You are refining the steps of the "/${skillName}" skill into actionable tasks.`,
    "",
    "## Raw steps extracted from the skill:",
    stepList,
    "",
    "## Full skill content (for context):",
    skillContent,
    "",
    "## Instructions:",
    "- Produce at least 3 clear, actionable tasks that cover the skill's workflow.",
    "- Each task subject must be imperative (start with a verb).",
    "- Each task subject must be a single action (no compound subjects with 'and').",
    "- Descriptions should be 1-2 sentences explaining what to do.",
    "- Preserve the intent of the original steps but improve clarity and granularity.",
    "- Order tasks in execution sequence.",
  ].join("\n")

  try {
    const result = await promptObject(prompt, RefinedStepsSchema, { timeout: 15_000 })
    return result.steps
  } catch {
    return null
  }
}

/**
 * Resolve a skill's SKILL.md, render it, extract quality-filtered steps,
 * and merge them into the session's task list.
 *
 * When an AI provider is available, refines the raw steps into ≥3 well-structured
 * tasks. Falls back to the raw extracted steps if AI is unavailable or fails.
 *
 * Returns null if the skill doesn't exist, has no steps, or no new tasks were created.
 */
export async function createTasksFromSkillSteps(opts: {
  skillName: string
  args?: string
  sessionId: string
  cwd?: string
}): Promise<SkillStepsResult | null> {
  const { skillName, args = "", sessionId, cwd = process.cwd() } = opts

  // Resolve skill content from SKILL.md on disk
  let content: string | null = null
  for (const dir of SKILL_DIRS) {
    const skillPath = join(dir, skillName, "SKILL.md")
    const file = Bun.file(skillPath)
    if (await file.exists()) {
      content = await file.text()
      break
    }
  }

  if (!content) return null

  // Render content: substitute args then expand inline commands
  const positionalArgs = args ? args.split(/\s+/) : []
  content = substituteArgs(content, positionalArgs)
  content = await expandInlineCommands(content)

  const rawSteps: MergeStep[] = filterQualitySteps(extractStepsFromSkill(content))
  if (rawSteps.length === 0) return null

  // Try AI refinement, fall back to raw steps
  const steps = (await refineStepsWithAi(skillName, rawSteps, content)) ?? rawSteps

  const created = await mergeIntoTasks(sessionId, steps, cwd)
  if (created.length === 0) return null

  return { skillName, created }
}

/** Format a summary of created tasks for context injection. */
export function formatSkillStepsSummary(result: SkillStepsResult): string {
  const summary = result.created.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  return `Created ${result.created.length} task(s) from /${result.skillName} steps:\n${summary}`
}
