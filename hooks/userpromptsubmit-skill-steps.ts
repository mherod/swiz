#!/usr/bin/env bun

// UserPromptSubmit hook: When the user's message starts with a skill
// invocation (e.g. `/commit`, `/ci-status`), extract numbered steps from
// the skill's SKILL.md and create pending tasks for each quality step
// that doesn't already exist in the session.

import { join } from "node:path"
import { expandInlineCommands, substituteArgs } from "../src/commands/skill.ts"
import { extractStepsFromSkill, filterQualitySteps, SKILL_DIRS } from "../src/skill-utils.ts"
import { mergeIntoTasks } from "../src/tasks/task-service.ts"
import { emitContext, type SessionHookInput } from "./utils/hook-utils.ts"

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

// Read the last user message from the transcript
let userMessage = ""
try {
  const text = await Bun.file(transcriptPath).text()
  const lines = text.split("\n").filter(Boolean)
  // Walk backwards to find the most recent user message
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!)
      if (entry?.type !== "user") continue
      const content = entry?.message?.content
      if (typeof content === "string") {
        userMessage = content
        break
      }
      if (Array.isArray(content)) {
        const textBlock = content.find((b: { type?: string }) => b.type === "text") as
          | { text?: string }
          | undefined
        if (textBlock?.text) {
          userMessage = textBlock.text
          break
        }
      }
    } catch {}
  }
} catch {
  process.exit(0)
}

if (!userMessage) process.exit(0)

const match = userMessage.match(SKILL_INVOCATION_RE)
if (!match?.[1]) process.exit(0)

const skillName = match[1]

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

if (!content) process.exit(0)

// Render content: substitute args then expand inline commands
const argsText = userMessage.slice(match[0].length).trim()
const positionalArgs = argsText ? argsText.split(/\s+/) : []
content = substituteArgs(content, positionalArgs)
content = await expandInlineCommands(content)

const steps = filterQualitySteps(extractStepsFromSkill(content))
if (steps.length === 0) process.exit(0)

const created = await mergeIntoTasks(sessionId, steps, cwd)

if (created.length > 0) {
  const summary = created.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  await emitContext(
    "UserPromptSubmit",
    `Created ${created.length} task(s) from /${skillName} steps:\n${summary}`,
    cwd
  )
}

process.exit(0)
