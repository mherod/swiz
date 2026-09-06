#!/usr/bin/env bun

// UserPromptSubmit hook: When the user's message starts with a skill
// invocation, extract numbered steps from SKILL.md and create pending tasks.

import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type UserPromptSubmitHookInput, userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { createTasksFromSkillSteps, formatSkillStepsSummary } from "../src/utils/skill-steps.ts"
import { readLastTranscriptUserMessage } from "../src/utils/transcript-user-message.ts"

const SKILL_INVOCATION_RE = /^\s*\/([a-z][a-z0-9-]*)/i

export async function readSubmittedUserMessage(input: UserPromptSubmitHookInput): Promise<string> {
  if (typeof input.prompt === "string") return input.prompt
  if (!input.transcript_path) return ""
  return (await readLastTranscriptUserMessage(input.transcript_path))?.text ?? ""
}

export async function evaluateUserpromptsubmitSkillSteps(input: unknown): Promise<SwizHookOutput> {
  const hookInput: UserPromptSubmitHookInput = userPromptSubmitHookInputSchema.parse(input)

  // `actionPlanMerge` is opt-in and gates every automatic task-creation path. The sibling
  // `posttooluse-skill-steps` honoured it while this hook did not, so typing `/some-skill`
  // scraped that SKILL.md's step bullets into tasks even with the setting off — 16 of them
  // in one case, each with the subject byte-identical to the description, blocking the stop
  // gate with entries no action could complete (#872).
  const settings = (input as Record<string, unknown>)._effectiveSettings as
    | Record<string, unknown>
    | undefined
  if (!settings?.actionPlanMerge) return {}

  const sessionId = hookInput.session_id ?? ""
  const cwd = hookInput.cwd ?? process.cwd()
  if (!sessionId) return {}
  const userMessage = await readSubmittedUserMessage(hookInput)

  if (!userMessage) return {}

  const match = userMessage.match(SKILL_INVOCATION_RE)
  if (!match?.[1]) return {}

  const skillName = match[1]
  const argsText = userMessage.slice(match[0].length).trim()

  const result = await createTasksFromSkillSteps({ skillName, args: argsText, sessionId, cwd })
  if (result) {
    return buildContextHookOutput("UserPromptSubmit", formatSkillStepsSummary(result))
  }
  return {}
}

const userpromptsubmitSkillSteps: SwizHook<Record<string, any>> = {
  name: "userpromptsubmit-skill-steps",
  event: "userPromptSubmit",
  timeout: 10,
  run(input) {
    return evaluateUserpromptsubmitSkillSteps(input)
  },
}

export default userpromptsubmitSkillSteps

if (import.meta.main) {
  await runSwizHookAsMain(userpromptsubmitSkillSteps)
}
