#!/usr/bin/env bun

// PreToolUse hook: block disallowed tool categories based on current project state
//
// Dual-mode: SwizToolHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { readProjectState } from "../src/settings.ts"
import { STATE_METADATA } from "../src/state-machine.ts"
import { isShellTool, isSwizCommand, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"

/** Tool categories blocked in each state — extended as new blocking states are added */
const STATE_BLOCKED_CATEGORIES: Partial<Record<string, ((name: string) => boolean)[]>> = {}

export async function evaluatePretooluseStateGate(input: ToolHookInput): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()
  const toolName = parsed.tool_name ?? ""

  if (isShellTool(toolName) && isSwizCommand(parsed)) return {}

  const state = await readProjectState(cwd)
  if (!state) return {}

  const blockedChecks = STATE_BLOCKED_CATEGORIES[state]
  if (!blockedChecks) return {}

  const isBlocked = blockedChecks.some((check) => check(toolName))
  if (!isBlocked) return {}

  const metadata = STATE_METADATA[state]
  if (!metadata) {
    return preToolUseDeny(
      `Project state is "${state}" but no metadata is registered for it — blocking ${toolName} until state metadata is repaired.`
    )
  }
  const reason =
    `Project state is "${state}" (${metadata.intent}) — ${toolName} is not allowed.\n\n` +
    `${metadata.description}\n\n` +
    `Use "swiz state set <state>" to transition to a different state.`

  return preToolUseDeny(reason)
}

const pretooluseStateGate: SwizToolHook = {
  name: "pretooluse-state-gate",
  event: "preToolUse",
  timeout: 5,

  run(input) {
    return evaluatePretooluseStateGate(input)
  },
}

export default pretooluseStateGate

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseStateGate)
}
