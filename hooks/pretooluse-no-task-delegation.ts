#!/usr/bin/env bun
// PreToolUse hook: Deny Task tool calls whose prompt delegates task creation.
// Tasks created inside a subagent land in a different session and are invisible
// to pretooluse-require-tasks.ts — the parent session stays blocked as if no
// tasks exist. TaskCreate must always be called directly in the parent session.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { preToolUseDeny, toolNameForCurrentAgent } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const delegationPatterns = [
  /\bTaskCreate\b/,
  /\bTaskUpdate\b/,
  /\bTaskList\b/,
  /\bTaskGet\b/,
  /\bTodoWrite\b/,
  /\bwrite_todos\b/,
  /\bupdate_plan\b/,
]

export function evaluatePretooluseNoTaskDelegation(input: unknown): SwizHookOutput {
  const parsed = toolHookInputSchema.parse(input)
  const prompt: string = (parsed.tool_input as Record<string, unknown> | undefined)
    ?.prompt as string

  if (!delegationPatterns.some((p) => p.test(String(prompt ?? "")))) {
    return {}
  }

  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  return preToolUseDeny(
    "NEVER delegate task creation to a subagent.\n\n" +
      "Tasks created inside a subagent land in a different session and are invisible to the " +
      "pretooluse-require-tasks.ts hook. The parent session will remain blocked as if no tasks exist.\n\n" +
      "WRONG — do not do this:\n" +
      `  Ask another agent to use ${taskCreateName} to create the upcoming tasks for you.\n\n` +
      "CORRECT — call the task tool directly in this session:\n" +
      `  Use ${taskCreateName} yourself to create separate tasks for "Implement X", "Run quality checks", and "Commit and push".\n\n` +
      `${taskCreateName} is a tool available directly to you — use it now, in this session, without launching any agent.`
  )
}

const pretooluseNoTaskDelegation: SwizToolHook = {
  name: "pretooluse-no-task-delegation",
  event: "preToolUse",
  matcher: "Task",
  timeout: 5,

  run(input) {
    return evaluatePretooluseNoTaskDelegation(input)
  },
}

export default pretooluseNoTaskDelegation

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseNoTaskDelegation)
}
