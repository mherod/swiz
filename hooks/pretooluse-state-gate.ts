#!/usr/bin/env bun

// PreToolUse hook: block disallowed tool categories based on current project state

import { readProjectState } from "../src/settings.ts"
import { STATE_METADATA } from "../src/state-machine.ts"
import {
  denyPreToolUse,
  isCodeChangeTool,
  isShellTool,
  isSwizCommand,
  type ToolHookInput,
} from "./hook-utils.ts"

/** Tool categories blocked in each state */
const STATE_BLOCKED_CATEGORIES: Record<string, ((name: string) => boolean)[]> = {
  released: [isCodeChangeTool, isShellTool],
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  const cwd = input.cwd ?? process.cwd()
  const toolName = input.tool_name ?? ""

  // Swiz commands are always allowed — they have their own validation
  if (isShellTool(toolName) && isSwizCommand(input)) return

  const state = await readProjectState(cwd)
  if (!state) return

  const blockedChecks = STATE_BLOCKED_CATEGORIES[state]
  if (!blockedChecks) return

  const isBlocked = blockedChecks.some((check) => check(toolName))
  if (!isBlocked) return

  const metadata = STATE_METADATA[state]
  const reason =
    `Project state is "${state}" (${metadata.intent}) — ${toolName} is not allowed.\n\n` +
    `${metadata.description}\n\n` +
    `Use "swiz state set <state>" to transition to a different state.`

  denyPreToolUse(reason)
}

await main()
