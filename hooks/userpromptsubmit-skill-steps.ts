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
