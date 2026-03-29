#!/usr/bin/env bun

// UserPromptSubmit hook: When the user's message starts with a skill
// invocation (e.g. `/commit`, `/ci-status`), extract numbered steps from
// the skill's SKILL.md and create pending tasks for each quality step
// that doesn't already exist in the session.

import { emitContext, type SessionHookInput } from "../src/utils/hook-utils.ts"
import { createTasksFromSkillSteps, formatSkillStepsSummary } from "../src/utils/skill-steps.ts"

/** Match `/skill-name` at the start of the user's message (with optional leading whitespace). */
const SKILL_INVOCATION_RE = /^\s*\/([a-z][a-z0-9-]*)/i

const input: SessionHookInput & { transcript_path?: string } = await Bun.stdin
  .json()
  .catch(() => null as never)
if (!input) process.exit(0)

const sessionId = input.session_id ?? ""
const cwd = input.cwd ?? process.cwd()
const transcriptPath = input.transcript_path

if (!sessionId || !transcriptPath) process.exit(0)

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

// Read the last user message from the transcript
let userMessage = ""
try {
  const text = await Bun.file(transcriptPath).text()
  userMessage = extractLastUserMessage(text.split("\n").filter(Boolean))
} catch {
  process.exit(0)
}

if (!userMessage) process.exit(0)

const match = userMessage.match(SKILL_INVOCATION_RE)
if (!match?.[1]) process.exit(0)

const skillName = match[1]
const argsText = userMessage.slice(match[0].length).trim()

const result = await createTasksFromSkillSteps({ skillName, args: argsText, sessionId, cwd })
if (result) {
  await emitContext("UserPromptSubmit", formatSkillStepsSummary(result), cwd)
}

process.exit(0)
