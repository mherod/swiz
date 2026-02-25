#!/usr/bin/env bun
// PreToolUse hook: Deny Task tool calls whose prompt delegates task creation.
// Tasks created inside a subagent land in a different session and are invisible
// to pretooluse-require-tasks.ts — the parent session stays blocked as if no
// tasks exist. TaskCreate must always be called directly in the parent session.

import { denyPreToolUse as deny } from "./hook-utils.ts";

const input = await Bun.stdin.json();
const prompt: string = input?.tool_input?.prompt ?? "";

// Match only explicit Claude task tool names — tight to avoid false positives on
// prompts that use "task" as a domain noun (e.g. "create a task queue").
const delegationPatterns = [
  /\bTaskCreate\b/,
  /\bTaskUpdate\b/,
  /\bTaskList\b/,
  /\bTaskGet\b/,
];

if (delegationPatterns.some((p) => p.test(prompt))) {
  deny(
    "NEVER delegate task creation to a subagent.\n\n" +
      "Tasks created inside a subagent land in a different session and are invisible to the " +
      "pretooluse-require-tasks.ts hook. The parent session will remain blocked as if no tasks exist.\n\n" +
      "WRONG — do not do this:\n" +
      "  Task(prompt: \"Create tasks for the upcoming work. Use TaskCreate for each step.\")\n\n" +
      "CORRECT — call the tool directly in this session:\n" +
      "  TaskCreate(subject: \"Implement X\", description: \"...\", activeForm: \"Implementing X\")\n" +
      "  TaskCreate(subject: \"Run quality checks\", description: \"...\", activeForm: \"Running checks\")\n" +
      "  TaskCreate(subject: \"Commit and push\", description: \"...\", activeForm: \"Committing\")\n\n" +
      "TaskCreate is a tool available directly to you — use it now, in this session, without launching any agent."
  );
}
