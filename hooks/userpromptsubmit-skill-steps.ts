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

const SKILL_INVOCATION_RE = /^\s*\/([a-z][a-z0-9-]*)/i

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textBlock = content.find((b: { type?: string }) => b.type === "text") as
      | { text?: string }
      | undefined
    return textBlock?.text ?? ""
  }
  return ""
}

function extractLastUserMessage(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!)
      if (entry?.type !== "user") continue
      const text = extractTextFromContent(entry?.message?.content)
      if (text) return text
    } catch {}
  }
  return ""
}

export async function evaluateUserpromptsubmitSkillSteps(input: unknown): Promise<SwizHookOutput> {
  const hookInput: UserPromptSubmitHookInput = userPromptSubmitHookInputSchema.parse(input)
  const sessionId = hookInput.session_id ?? ""
  const cwd = hookInput.cwd ?? process.cwd()
  const transcriptPath = hookInput.transcript_path

  if (!sessionId || !transcriptPath) return {}

  let userMessage = ""
  try {
    const text = await Bun.file(transcriptPath).text()
    userMessage = extractLastUserMessage(text.split("\n").filter(Boolean))
  } catch {
    return {}
  }

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
