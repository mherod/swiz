#!/usr/bin/env bun

// PreToolUse hook: Block Read/Grep/Glob when the model has been reading
// without producing any file output (Edit/Write) for too long.
//
// Scans the transcript for a streak of Read/Search tool calls unbroken by
// any Edit/Write/NotebookEdit call. When the streak exceeds STALL_THRESHOLD
// (default 15, ~20 minutes at typical tool-call cadence), the current
// Read/Grep/Glob is denied.
//
// Non-read/non-write tools (TaskUpdate, Skill, Bash, etc.) are invisible
// to the streak — they neither count toward it nor reset it.
//
// Dual-mode: exports a SwizToolHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { isCodeChangeTool, READ_TOOLS, SEARCH_TOOLS } from "../src/tool-matchers.ts"
import { getToolsUsedForCurrentSession } from "../src/transcript-summary.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"
import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"

/** Consecutive Read/Search calls before blocking. ~30 calls ≈ 40 min. */
const STALL_THRESHOLD = 30

function isReadOrSearchTool(name: string): boolean {
  return READ_TOOLS.has(name) || SEARCH_TOOLS.has(name)
}

async function getToolNamesAndValidate(
  raw: unknown
): Promise<{ toolNames: string[]; toolName: string } | null> {
  let parsed: ToolHookInput
  try {
    parsed = toolHookInputSchema.parse(raw)
  } catch {
    return null
  }

  const { tool_name: toolName } = parsed
  if (!toolName || !isReadOrSearchTool(toolName)) return null

  const toolNames = await getToolsUsedForCurrentSession(parsed as Record<string, any>)

  if (toolNames.length === 0) return null

  return { toolNames, toolName }
}

function countReadStreak(toolNames: string[]): number {
  // Walk backward from the most recent tool call. Count Read/Search calls;
  // stop at the first Edit/Write (code-change) tool. Other tools are ignored.
  let readStreak = 0
  for (let i = toolNames.length - 1; i >= 0; i--) {
    const name = toolNames[i]!
    if (isCodeChangeTool(name)) break
    if (isReadOrSearchTool(name)) readStreak++
  }
  return readStreak
}

const pretooluseReadGrepStallGuard: SwizToolHook = {
  name: "pretooluse-read-grep-stall-guard",
  event: "preToolUse",
  matcher: "Read|Grep|Glob",
  timeout: 5,
  cooldownSeconds: 300,

  async run(input): Promise<SwizHookOutput> {
    try {
      const validated = await getToolNamesAndValidate(input)
      if (!validated) return {}

      const { toolNames, toolName } = validated
      const readStreak = countReadStreak(toolNames)

      if (readStreak < STALL_THRESHOLD) return {}

      return await preToolUseDeny(
        `STOP. ${toolName} is BLOCKED — ${readStreak} consecutive Read/Search tool calls ` +
          `have occurred without any Edit or Write output.\n\n` +
          `Your information gathering has gone on for too long without producing changes. ` +
          `This pattern indicates a stall — reading the same files or searching endlessly without acting on findings.\n\n` +
          formatActionPlan(
            [
              "Use Edit or Write to make the changes you've been researching.",
              "If you're blocked, explain what's preventing progress and ask the user for guidance.",
              "If the task is complete, update your tasks accordingly.",
            ],
            { header: "Action plan:" }
          ) +
          `\nAfter making an Edit or Write, Read/Grep/Glob will be unblocked automatically.`
      )
    } catch {
      return {}
    }
  },
}

export default pretooluseReadGrepStallGuard

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseReadGrepStallGuard)
}
