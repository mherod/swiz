#!/usr/bin/env bun
// PreToolUse hook: block disallowed tool categories based on current project state

import { readProjectState } from "../src/settings.ts"
import { denyPreToolUse, isCodeChangeTool, isShellTool, type ToolHookInput } from "./hook-utils.ts"

/** Tool categories blocked in each state */
const STATE_BLOCKED_CATEGORIES: Record<string, ((name: string) => boolean)[]> = {
  released: [isCodeChangeTool, isShellTool],
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  const cwd = input.cwd ?? process.cwd()
  const toolName = input.tool_name ?? ""

  const state = await readProjectState(cwd)
  if (!state) return

  const blockedChecks = STATE_BLOCKED_CATEGORIES[state]
  if (!blockedChecks) return

  const isBlocked = blockedChecks.some((check) => check(toolName))
  if (!isBlocked) return

  denyPreToolUse(
    `Project state is "${state}" — ${toolName} is not allowed in this state.\n\n` +
      `Use "swiz state set <state>" to transition to a state that allows this tool.`
  )
}

await main()
