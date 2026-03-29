#!/usr/bin/env bun

// PostToolUse hook: After a Skill tool call, extract numbered steps from the
// skill's SKILL.md and create pending tasks for each quality step that
// doesn't already exist as a pending/in_progress task in the session.

import { emitContext } from "../src/utils/hook-utils.ts"
import { createTasksFromSkillSteps, formatSkillStepsSummary } from "../src/utils/skill-steps.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
if (toolName !== "Skill") process.exit(0)

const skillName: string = input.tool_input?.skill ?? ""
const skillArgs: string = input.tool_input?.args ?? ""
const sessionId: string = input.session_id ?? ""
const cwd: string = input.cwd ?? process.cwd()

if (!skillName || !sessionId) process.exit(0)

const result = await createTasksFromSkillSteps({ skillName, args: skillArgs, sessionId, cwd })
if (result) {
  await emitContext("PostToolUse", formatSkillStepsSummary(result), cwd)
}

process.exit(0)
