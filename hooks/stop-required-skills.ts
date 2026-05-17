#!/usr/bin/env bun

// Stop hook: block session stop until required skills have been invoked in the
// current session.
//
// Rules are evaluated in priority order. The first applicable installed skill
// that has not been invoked blocks stop. Add new skills to the ordered list
// below instead of creating more one-off stop hooks.

import { runSwizHookAsMain, type SwizHookOutput, type SwizStopHook } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import {
  DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES,
  DEFAULT_SKILL_RECENCY_MAX_TURNS,
  resolveNumericSetting,
} from "../src/settings/resolution.ts"
import {
  type CurrentSessionUsageRecencyOptions,
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  skillExists,
} from "../src/skill-utils.ts"
import { isIncompleteTaskStatus, readTasks } from "../src/tasks/task-repository.ts"
import { blockStopObj, isGitRepo } from "../src/utils/hook-utils.ts"
import { type ActionPlanItem, formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

interface RequiredStopSkillContext {
  cwd: string
  input: StopHookInput
  ahead?: number
  incompleteCount?: number
}

interface RequiredStopSkillRule {
  skill: string
  applies?(ctx: RequiredStopSkillContext): boolean | Promise<boolean>
  blockedLine(skillReference: string): string
  actionHeader(skillReference: string): string
  actionPlan(skillReference: string, ctx: RequiredStopSkillContext): ActionPlanItem[]
  why(skillReference: string): string
}

function formatSessionSkillsForReason(
  skills: string[],
  options?: CurrentSessionUsageRecencyOptions
): string {
  const window = formatCurrentSessionUsageWindow(options)
  return `Skills used recently (${window}): ${skills.length === 0 ? "(none)" : skills.map((s) => `/${s}`).join(", ")}`
}

function buildMissingSkillReason(
  rule: RequiredStopSkillRule,
  skillReference: string,
  invokedSkills: string[],
  ctx: RequiredStopSkillContext,
  options?: CurrentSessionUsageRecencyOptions
): string {
  return [
    rule.blockedLine(skillReference),
    "",
    formatSessionSkillsForReason(invokedSkills, options),
    "",
    formatActionPlan(rule.actionPlan(skillReference, ctx), {
      header: rule.actionHeader(skillReference),
    }).trimEnd(),
    `Why this matters: ${rule.why(skillReference)}`,
  ].join("\n")
}

// Add future stop-gated skills here in the exact order they should block.
const REQUIRED_STOP_SKILLS: readonly RequiredStopSkillRule[] = [
  {
    skill: "end-of-day",
    applies: async (ctx) => {
      const { cwd, input } = ctx
      const es = (input as any)._effectiveSettings
      if (es?.enforceEndOfDay === false) {
        if (process.env.DEBUG_REQUIRED_SKILLS) console.error("end-of-day: enforceEndOfDay is false")
        return false
      }
      if (!(await isGitRepo(cwd))) {
        if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`end-of-day: ${cwd} is not a git repo`)
        return false
      }

      // Signal 1: Unpushed commits
      const proc = Bun.spawnSync(["git", "-C", cwd, "rev-list", "--count", "@{upstream}..HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const ahead =
        proc.exitCode === 0 ? parseInt(new TextDecoder().decode(proc.stdout).trim(), 10) : 0
      if (!Number.isNaN(ahead) && ahead > 0) {
        if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`end-of-day: ${ahead} commits ahead`)
        ctx.ahead = ahead
        return true
      }

      // Signal 2: Incomplete tasks
      const sessionId = (input as any).session_id
      if (typeof sessionId === "string") {
        const tasks = await readTasks(sessionId)
        const incomplete = tasks.filter((t: any) => isIncompleteTaskStatus(t.status))
        if (incomplete.length > 0) {
          if (process.env.DEBUG_REQUIRED_SKILLS)
            console.error(`end-of-day: ${incomplete.length} incomplete tasks`)
          ctx.incompleteCount = incomplete.length
          return true
        }
      }

      if (process.env.DEBUG_REQUIRED_SKILLS) console.error("end-of-day: no signals fired")
      return false
    },
    blockedLine: (skillReference) =>
      `BLOCKED: session handoff incomplete and ${skillReference} has not been run.`,
    actionHeader: (skillReference) => `Run ${skillReference} to complete the session handoff:`,
    actionPlan: (skillReference, ctx) => {
      const plan: string[] = []
      if (ctx.ahead && ctx.ahead > 0) {
        plan.push(`Local commits unpushed (${ctx.ahead} ahead of origin/main).`)
      }
      if (ctx.incompleteCount && ctx.incompleteCount > 0) {
        plan.push(`Session shortlist incomplete (${ctx.incompleteCount} tasks remain).`)
      }
      plan.push(
        `Invoke ${skillReference} to push commits, post resolution evidence, and file follow-up issues before stopping.`
      )
      return plan
    },
    why: (skillReference) =>
      `${skillReference} ensures commits reach the remote (so Closes #N auto-closes issues on GitHub), evidence is posted, and follow-up work is captured — preventing work from being lost when the session ends.`,
  },
  {
    skill: "farm-out-issues",
    applies: ({ cwd }) => isGitRepo(cwd),
    blockedLine: (skillReference) =>
      `BLOCKED: The ${skillReference} skill has not been invoked recently.`,
    actionHeader: (skillReference) => `The ${skillReference} skill has not been invoked recently:`,
    actionPlan: (skillReference) => [
      `Invoke the ${skillReference} skill to batch and distribute pending issues.`,
    ],
    why: (skillReference) =>
      `the ${skillReference} skill batches and distributes pending issues across sessions. Stopping without running it leaves issues untriaged and unassigned.`,
  },
  {
    skill: "continue-with-tasks",
    blockedLine: (skillReference) =>
      `BLOCKED: stop requires the ${skillReference} skill to be used first.`,
    actionHeader: (skillReference) => `The ${skillReference} skill has not been invoked recently:`,
    actionPlan: (skillReference) => [
      `Invoke the ${skillReference} skill to confirm the next task-carrying continuation path before ending the session.`,
    ],
    why: (skillReference) =>
      `the ${skillReference} skill makes the next task-carrying continuation explicit before the session ends, so work is handed off cleanly instead of being abandoned between stops.`,
  },
  {
    skill: "reflect-on-session-mistakes",
    blockedLine: (skillReference) =>
      `BLOCKED: stop requires the ${skillReference} skill to be used first.`,
    actionHeader: (skillReference) => `The ${skillReference} skill has not been invoked recently:`,
    actionPlan: (skillReference) => [
      `Invoke the ${skillReference} skill to identify patterns to avoid before ending the session.`,
    ],
    why: () =>
      "session reflection captures the mistakes before the session ends and keeps the follow-up memory/update workflow grounded in concrete evidence.",
  },
]

export async function evaluateStopRequiredSkills(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()
  const ctx: RequiredStopSkillContext = { cwd, input: parsed }

  const [maxTurns, maxAgeMinutes] = await Promise.all([
    resolveNumericSetting(cwd, "skillRecencyMaxTurns", DEFAULT_SKILL_RECENCY_MAX_TURNS),
    resolveNumericSetting(cwd, "skillRecencyMaxAgeMinutes", DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES),
  ])
  const recencyOptions: CurrentSessionUsageRecencyOptions = {
    maxTurns,
    maxAgeMs: maxAgeMinutes * 60 * 1000,
  }

  let invokedSkills: string[] | null = null

  for (const rule of REQUIRED_STOP_SKILLS) {
    if (rule.applies && !(await rule.applies(ctx))) {
      if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`Rule ${rule.skill} does not apply`)
      continue
    }
    if (!skillExists(rule.skill)) {
      if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`Skill ${rule.skill} does not exist`)
      continue
    }

    invokedSkills ??= await getRecentlyInvokedSkillsForCurrentSession(parsed, recencyOptions)
    if (process.env.DEBUG_REQUIRED_SKILLS)
      console.error(`Invoked skills: ${invokedSkills.join(", ")}`)
    if (invokedSkills.includes(rule.skill)) {
      if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`Skill ${rule.skill} already invoked`)
      continue
    }

    const skillReference = formatSkillReferenceForAgent(rule.skill)
    if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`Blocking on missing skill: ${rule.skill}`)
    return blockStopObj(
      buildMissingSkillReason(rule, skillReference, invokedSkills, ctx, recencyOptions)
    )
  }

  return {}
}

const stopRequiredSkills: SwizStopHook = {
  name: "stop-required-skills",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopRequiredSkills(input)
  },
}

export default stopRequiredSkills

if (import.meta.main) {
  await runSwizHookAsMain(stopRequiredSkills)
}
