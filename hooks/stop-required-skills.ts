#!/usr/bin/env bun

// Stop hook: block session stop until required skills have been invoked in the
// current session.
//
// Rules are evaluated in priority order. The first applicable installed skill
// that has not been invoked blocks stop. Add new skills to the ordered list
// below instead of creating more one-off stop hooks.

import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import { getUnpushedCommitCount } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizStopHook } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import {
  type CurrentSessionUsageRecencyOptions,
  formatCurrentSessionUsageWindow,
  formatSkillFileReadFallback,
  formatSkillReferenceForHookPayload,
  getRecentlyInvokedSkillsForCurrentSession,
  type ResolvedSkillFile,
  resolveSkillFilePathForHookPayload,
  resolveSkillRecencyOptions,
} from "../src/skill-utils.ts"
import { isIncompleteTaskStatus, readTasks } from "../src/tasks/task-repository.ts"
import {
  type CurrentSessionUsageEvent,
  collectCurrentSessionUsageEvents,
  extractSessionLines,
  getCurrentSessionToolUsage,
} from "../src/transcript-summary.ts"
import { blockStopObj } from "../src/utils/hook-response.ts"
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

function debugRequiredSkills(message: string): void {
  if (process.env.DEBUG_REQUIRED_SKILLS) console.error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseTranscriptLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function findLastSystemBoundary(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = parseTranscriptLine(lines[index] ?? "")
    if (isRecord(entry) && entry.type === "system") return index
  }
  return -1
}

function isSkillInvocation(block: unknown, skillName: string): boolean {
  if (!isRecord(block) || block.type !== "tool_use" || block.name !== "Skill") return false
  return isRecord(block.input) && block.input.skill === skillName
}

function entryInvokesSkill(entry: unknown, skillName: string): boolean {
  if (!isRecord(entry) || entry.type !== "assistant" || !isRecord(entry.message)) return false
  const content = entry.message.content
  return Array.isArray(content) && content.some((block) => isSkillInvocation(block, skillName))
}

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
  details: {
    skillReference: string
    invokedSkills: string[]
    ctx: RequiredStopSkillContext
    skillFile: ResolvedSkillFile
    options?: CurrentSessionUsageRecencyOptions
    compactionReset?: boolean
  }
): string {
  const { skillReference, invokedSkills, ctx, skillFile, options, compactionReset } = details
  const parts = [
    rule.blockedLine(skillReference),
    "",
    formatSessionSkillsForReason(invokedSkills, options),
    "",
    formatActionPlan(rule.actionPlan(skillReference, ctx), {
      header: rule.actionHeader(skillReference),
    }).trimEnd(),
    formatSkillFileReadFallback([skillFile]),
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
    const boundaryIdx = findLastSystemBoundary(lines)
    if (boundaryIdx <= 0) return false
    return lines
      .slice(0, boundaryIdx)
      .some((line) => entryInvokesSkill(parseTranscriptLine(line), skillName))
  } catch {
    return false
  }
}

async function countIncompleteSessionTasks(input: StopHookInput): Promise<number> {
  if (!input.session_id) return 0
  const tasks = await readTasks(input.session_id)
  return tasks.filter((task) => isIncompleteTaskStatus(task.status)).length
}

async function isEndOfDayApplicable(ctx: RequiredStopSkillContext): Promise<boolean> {
  const effectiveSettings = (ctx.input as Record<string, unknown>)._effectiveSettings
  if (isRecord(effectiveSettings) && effectiveSettings.enforceEndOfDay === false) {
    debugRequiredSkills("end-of-day: enforceEndOfDay is false")
    return false
  }
  if (!(await isGitRepoForHookPayload(ctx.input, ctx.cwd))) {
    debugRequiredSkills(`end-of-day: ${ctx.cwd} is not a git repo`)
    return false
  }

  const ahead = await getUnpushedCommitCount(ctx.cwd)
  if (ahead > 0) {
    debugRequiredSkills(`end-of-day: ${ahead} commits ahead`)
    ctx.ahead = ahead
    return true
  }

  const incompleteCount = await countIncompleteSessionTasks(ctx.input)
  if (incompleteCount > 0) {
    debugRequiredSkills(`end-of-day: ${incompleteCount} incomplete tasks`)
    ctx.incompleteCount = incompleteCount
    return true
  }

  debugRequiredSkills("end-of-day: no signals fired")
  return false
}

// Add future stop-gated skills here in the exact order they should block.
const REQUIRED_STOP_SKILLS: readonly RequiredStopSkillRule[] = [
  {
    skill: GATE_REQUIRED_SKILLS.endOfDay.name,
    applies: isEndOfDayApplicable,
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
    skill: GATE_REQUIRED_SKILLS.farmOutIssues.name,
    applies: ({ cwd, input }) => isGitRepoForHookPayload(input, cwd),
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
    skill: GATE_REQUIRED_SKILLS.continueWithTasks.name,
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
    skill: GATE_REQUIRED_SKILLS.reflectOnSessionMistakes.name,
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

async function getAllCurrentSessionUsageEvents(
  input: StopHookInput
): Promise<CurrentSessionUsageEvent[] | undefined> {
  const summarizedEvents = getCurrentSessionToolUsage(input as Record<string, any>)?.events
  if (summarizedEvents || !input.transcript_path) return summarizedEvents

  try {
    const text = await Bun.file(input.transcript_path).text()
    return collectCurrentSessionUsageEvents(extractSessionLines(text))
  } catch {
    return undefined
  }
}

async function canBypassMissingSkill(
  rule: RequiredStopSkillRule,
  input: StopHookInput
): Promise<boolean> {
  if (!rule.bypassIfNoNewCommits) return false
  const events = await getAllCurrentSessionUsageEvents(input)
  return Boolean(events && noNewCommitsSinceSkillInvocation(rule.skill, events))
}

export async function evaluateStopRequiredSkills(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()
  const ctx: RequiredStopSkillContext = { cwd, input: parsed }

  const { recencyOptions } = await resolveSkillRecencyOptions(cwd)

  let invokedSkills: string[] | null = null

  for (const rule of REQUIRED_STOP_SKILLS) {
    if (rule.applies && !(await rule.applies(ctx))) {
      debugRequiredSkills(`Rule ${rule.skill} does not apply`)
      continue
    }
    const skillPath = resolveSkillFilePathForHookPayload(
      rule.skill,
      parsed as Record<string, unknown>,
      cwd
    )
    if (!skillPath) {
      debugRequiredSkills(`Skill ${rule.skill} does not exist`)
      continue
    }

    invokedSkills ??= await getRecentlyInvokedSkillsForCurrentSession(parsed, recencyOptions)
    debugRequiredSkills(`Invoked skills: ${invokedSkills.join(", ")}`)
    if (invokedSkills.includes(rule.skill)) {
      debugRequiredSkills(`Skill ${rule.skill} already invoked`)
      continue
    }

    if (await canBypassMissingSkill(rule, parsed)) {
      debugRequiredSkills(`Skill ${rule.skill} bypassed — no new commits since last invocation`)
      continue
    }

    const skillReference = formatSkillReferenceForHookPayload(
      rule.skill,
      parsed as Record<string, unknown>
    )
    debugRequiredSkills(`Blocking on missing skill: ${rule.skill}`)
    const compactionReset = await hasPreCompactionSkill(parsed.transcript_path, rule.skill)
    return blockStopObj(
      buildMissingSkillReason(rule, {
        skillReference,
        invokedSkills,
        ctx,
        skillFile: { name: rule.skill, path: skillPath },
        options: recencyOptions,
        compactionReset,
      })
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
