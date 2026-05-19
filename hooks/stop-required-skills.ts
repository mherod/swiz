#!/usr/bin/env bun

// Stop hook: block session stop until required skills have been invoked in the
// current session.
//
// Rules are evaluated in priority order. The first applicable installed skill
// that has not been invoked blocks stop. Add new skills to the ordered list
// below instead of creating more one-off stop hooks.

import { git } from "../src/git-helpers.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizStopHook } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import {
  DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES,
  DEFAULT_SKILL_RECENCY_MAX_TURNS,
  resolveNumericSetting,
} from "../src/settings/resolution.ts"
import {
  agentHasSkillToolForHookPayload,
  type CurrentSessionUsageRecencyOptions,
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"
import { isIncompleteTaskStatus, readTasks } from "../src/tasks/task-repository.ts"
import {
  type CurrentSessionUsageEvent,
  collectCurrentSessionUsageEvents,
  extractSessionLines,
  getCurrentSessionToolUsage,
} from "../src/transcript-summary.ts"
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
  /** When true, bypass the recency gate if no git commit/push occurred since the skill last ran. */
  bypassIfNoNewCommits?: boolean
}

const GIT_COMMIT_OR_PUSH_RE = /\bgit\s+(?:commit|push)\b/

/**
 * Returns true if `skillName` was invoked this session AND no `git commit` or
 * `git push` bash command occurred after that invocation. When true the skill's
 * recency window may be expired but its last run is still valid.
 */
function noNewCommitsSinceSkillInvocation(
  skillName: string,
  events: CurrentSessionUsageEvent[]
): boolean {
  let lastSkillTurnIndex = -1
  for (const event of events) {
    if (event.kind === "skill" && event.value === skillName) {
      lastSkillTurnIndex = Math.max(lastSkillTurnIndex, event.turnIndex)
    }
  }
  if (lastSkillTurnIndex < 0) return false
  return !events.some(
    (event) =>
      event.kind === "bash-command" &&
      event.turnIndex > lastSkillTurnIndex &&
      GIT_COMMIT_OR_PUSH_RE.test(event.value)
  )
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
  options?: CurrentSessionUsageRecencyOptions,
  compactionReset?: boolean
): string {
  const parts = [
    rule.blockedLine(skillReference),
    "",
    formatSessionSkillsForReason(invokedSkills, options),
    "",
    formatActionPlan(rule.actionPlan(skillReference, ctx), {
      header: rule.actionHeader(skillReference),
    }).trimEnd(),
    `Why this matters: ${rule.why(skillReference)}`,
  ]
  if (compactionReset) {
    parts.push(
      "",
      `Note: context compaction reset the recency window — re-invoke ${skillReference} to satisfy this check.`
    )
  }
  return parts.join("\n")
}

/** Returns true when `skillName` appears in transcript entries before the last compaction boundary. */
async function hasPreCompactionSkill(
  transcriptPath: string | undefined | null,
  skillName: string
): Promise<boolean> {
  if (!transcriptPath) return false
  try {
    const text = await Bun.file(transcriptPath).text()
    const lines = text.split("\n").filter(Boolean)

    let boundaryIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i] ?? "") as { type?: string }
        if (entry?.type === "system") {
          boundaryIdx = i
          break
        }
      } catch {
        /* skip malformed line */
      }
    }
    if (boundaryIdx <= 0) return false

    for (let i = 0; i < boundaryIdx; i++) {
      try {
        const entry = JSON.parse(lines[i] ?? "") as {
          type?: string
          message?: {
            content?: Array<{ type?: string; name?: string; input?: { skill?: string } }>
          }
        }
        if (entry?.type !== "assistant") continue
        const content = entry?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (
            block?.type === "tool_use" &&
            block?.name === "Skill" &&
            block?.input?.skill === skillName
          ) {
            return true
          }
        }
      } catch {
        /* skip malformed line */
      }
    }
    return false
  } catch {
    return false
  }
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
      const ahead = parseInt(await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd), 10)
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
    bypassIfNoNewCommits: true,
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

  // Fail-open: agents that cannot invoke the Skill tool cannot satisfy these requirements.
  if (!agentHasSkillToolForHookPayload(parsed as Record<string, unknown>)) return {}

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
    if (!skillExistsForHookPayload(rule.skill, parsed as Record<string, unknown>)) {
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

    if (rule.bypassIfNoNewCommits) {
      let allEvents = getCurrentSessionToolUsage(parsed as Record<string, any>)?.events
      if (!allEvents && parsed.transcript_path) {
        try {
          const text = await Bun.file(parsed.transcript_path).text()
          allEvents = collectCurrentSessionUsageEvents(extractSessionLines(text))
        } catch {
          allEvents = undefined
        }
      }
      if (allEvents && noNewCommitsSinceSkillInvocation(rule.skill, allEvents)) {
        if (process.env.DEBUG_REQUIRED_SKILLS)
          console.error(`Skill ${rule.skill} bypassed — no new commits since last invocation`)
        continue
      }
    }

    const skillReference = formatSkillReferenceForAgent(rule.skill)
    if (process.env.DEBUG_REQUIRED_SKILLS) console.error(`Blocking on missing skill: ${rule.skill}`)
    const compactionReset = await hasPreCompactionSkill(parsed.transcript_path, rule.skill)
    return blockStopObj(
      buildMissingSkillReason(
        rule,
        skillReference,
        invokedSkills,
        ctx,
        recencyOptions,
        compactionReset
      )
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
