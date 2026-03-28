#!/usr/bin/env bun

// PostToolUse hook: After a Skill tool call, extract numbered steps from the
// skill's `## Steps` section and create pending tasks for each step that
// doesn't already exist as a pending/in_progress task in the session.
//
// Renders the skill content (inline command expansion + arg substitution)
// before extracting steps, matching what the agent actually sees.
// Applies quality filtering to exclude single-word and command-like subjects.

import { join } from "node:path"
import { expandInlineCommands, substituteArgs } from "../src/commands/skill.ts"
import { extractStepsFromSkill, filterQualitySteps, SKILL_DIRS } from "../src/skill-utils.ts"
import { mergeIntoTasks } from "../src/tasks/task-service.ts"
import { emitContext } from "./utils/hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
if (toolName !== "Skill") process.exit(0)

const skillName: string = input.tool_input?.skill ?? ""
const skillArgs: string = input.tool_input?.args ?? ""
const sessionId: string = input.session_id ?? ""
const cwd: string = input.cwd ?? process.cwd()

if (!skillName || !sessionId) process.exit(0)

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

// Render content like the skill command does: substitute args then expand inline commands
const positionalArgs = skillArgs ? skillArgs.split(/\s+/) : []
content = substituteArgs(content, positionalArgs)
content = await expandInlineCommands(content)

const steps = filterQualitySteps(extractStepsFromSkill(content))
if (steps.length === 0) process.exit(0)

const created = await mergeIntoTasks(sessionId, steps, cwd)

if (created.length > 0) {
  const summary = created.map((t) => `  • #${t.id}: ${t.subject}`).join("\n")
  await emitContext(
    "PostToolUse",
    `Created ${created.length} task(s) from /${skillName} steps:\n${summary}`,
    cwd
  )
}

process.exit(0)
