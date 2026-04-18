#!/usr/bin/env bun

// Stop hook: block session stop until required skills have been invoked in the
// current session.
//
// Rules are evaluated in priority order. The first applicable installed skill
// that has not been invoked blocks stop. Add new skills to the ordered list
// below instead of creating more one-off stop hooks.

import { runSwizHookAsMain, type SwizHookOutput, type SwizStopHook } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import { formatSkillReferenceForAgent, skillExists } from "../src/skill-utils.ts"
import { getSkillsUsedForCurrentSession } from "../src/transcript-summary.ts"
import { blockStopObj, isGitRepo } from "../src/utils/hook-utils.ts"
import { type ActionPlanItem, formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

interface RequiredStopSkillContext {
  cwd: string
  input: StopHookInput
}

interface RequiredStopSkillRule {
  skill: string
  applies?(ctx: RequiredStopSkillContext): boolean | Promise<boolean>
  blockedLine(skillReference: string): string
  actionHeader(skillReference: string): string
  actionPlan(skillReference: string): ActionPlanItem[]
  why(skillReference: string): string
}

function formatSessionSkillsForReason(skills: string[]): string {
  return `Skills used this session: ${skills.length === 0 ? "(none)" : skills.map((s) => `/${s}`).join(", ")}`
}

function buildMissingSkillReason(
  rule: RequiredStopSkillRule,
  skillReference: string,
  invokedSkills: string[]
): string {
  return [
    rule.blockedLine(skillReference),
    "",
    formatSessionSkillsForReason(invokedSkills),
    "",
    formatActionPlan(rule.actionPlan(skillReference), {
      header: rule.actionHeader(skillReference),
    }).trimEnd(),
    `Why this matters: ${rule.why(skillReference)}`,
  ].join("\n")
}

// Add future stop-gated skills here in the exact order they should block.
const REQUIRED_STOP_SKILLS: readonly RequiredStopSkillRule[] = [
  {
    skill: "farm-out-issues",
    applies: ({ cwd }) => isGitRepo(cwd),
    blockedLine: (skillReference) =>
      `BLOCKED: The ${skillReference} skill has not been invoked in this session.`,
    actionHeader: (skillReference) =>
      `The ${skillReference} skill has not been invoked in this session:`,
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
    actionHeader: (skillReference) =>
      `The ${skillReference} skill has not been invoked in this session:`,
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
    actionHeader: (skillReference) =>
      `The ${skillReference} skill has not been invoked in this session:`,
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
  let invokedSkills: string[] | null = null

  for (const rule of REQUIRED_STOP_SKILLS) {
    if (rule.applies && !(await rule.applies(ctx))) continue
    if (!skillExists(rule.skill)) continue

    invokedSkills ??= await getSkillsUsedForCurrentSession(parsed)
    if (invokedSkills.includes(rule.skill)) continue

    const skillReference = formatSkillReferenceForAgent(rule.skill)
    return blockStopObj(buildMissingSkillReason(rule, skillReference, invokedSkills))
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
