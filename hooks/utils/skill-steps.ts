/**
 * Shared logic for creating tasks from skill steps.
 * Used by both posttooluse-skill-steps.ts and userpromptsubmit-skill-steps.ts.
 */

import { join } from "node:path"
import { expandInlineCommands, substituteArgs } from "../../src/commands/skill.ts"
import { extractStepsFromSkill, filterQualitySteps, SKILL_DIRS } from "../../src/skill-utils.ts"
import type { Task } from "../../src/tasks/task-repository.ts"
import { type MergeStep, mergeIntoTasks } from "../../src/tasks/task-service.ts"

export interface SkillStepsResult {
  skillName: string
  created: Task[]
}

/**
 * Resolve a skill's SKILL.md, render it, extract quality-filtered steps,
 * and merge them into the session's task list.
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

  const steps: MergeStep[] = filterQualitySteps(extractStepsFromSkill(content))
  if (steps.length === 0) return null

  const created = await mergeIntoTasks(sessionId, steps, cwd)
  if (created.length === 0) return null

  return { skillName, created }
}

/** Format a summary of created tasks for context injection. */
export function formatSkillStepsSummary(result: SkillStepsResult): string {
  const summary = result.created.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  return `Created ${result.created.length} task(s) from /${result.skillName} steps:\n${summary}`
}
