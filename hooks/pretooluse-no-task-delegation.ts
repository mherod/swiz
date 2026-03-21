#!/usr/bin/env bun
// PreToolUse hook: Deny Task tool calls whose prompt delegates task creation.
// Tasks created inside a subagent land in a different session and are invisible
// to pretooluse-require-tasks.ts — the parent session stays blocked as if no
// tasks exist. TaskCreate must always be called directly in the parent session.

import { denyPreToolUse as deny, toolNameForCurrentAgent } from "./utils/hook-utils.ts"

const input = await Bun.stdin.json()
const prompt: string = input?.tool_input?.prompt ?? ""

// Match task tool names across agents — tight to avoid false positives on
// prompts that use "task" as a domain noun (e.g. "create a task queue").
const delegationPatterns = [
  /\bTaskCreate\b/,
  /\bTaskUpdate\b/,
  /\bTaskList\b/,
  /\bTaskGet\b/,
  /\bTodoWrite\b/,
  /\bwrite_todos\b/,
  /\bupdate_plan\b/,
]

if (delegationPatterns.some((p) => p.test(prompt))) {
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  deny(
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
