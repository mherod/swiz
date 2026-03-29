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

import { isCodeChangeTool, READ_TOOLS, SEARCH_TOOLS } from "../src/tool-matchers.ts"
import {
  denyPreToolUse as deny,
  formatActionPlan,
  getToolsUsedForCurrentSession,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/** Consecutive Read/Search calls before blocking. ~30 calls ≈ 40 min. */
const STALL_THRESHOLD = 30

function isReadOrSearchTool(name: string): boolean {
  return READ_TOOLS.has(name) || SEARCH_TOOLS.has(name)
}

async function getToolNamesAndValidate(
  raw: unknown
): Promise<{ toolNames: string[]; toolName: string } | null> {
  const parsed = toolHookInputSchema.safeParse(raw)
  if (!parsed.success) return null

  const { tool_name: toolName } = parsed.data
  if (!toolName || !isReadOrSearchTool(toolName)) return null

  const toolNames = await getToolsUsedForCurrentSession(raw as Record<string, unknown>)

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

async function main(): Promise<void> {
  const raw = await Bun.stdin.json()
  const validated = await getToolNamesAndValidate(raw)
  if (!validated) return

  const { toolNames, toolName } = validated
  const readStreak = countReadStreak(toolNames)

  if (readStreak < STALL_THRESHOLD) return

  deny(
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
        { translateToolNames: true }
      ) +
      `\nAfter making an Edit or Write, Read/Grep/Glob will be unblocked automatically.`
  )
}

if (import.meta.main) {
  void main().catch(() => process.exit(0))
}
