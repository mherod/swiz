#!/usr/bin/env bun
// PreToolUse hook: Deny Edit/Write/Bash/Shell tools unless the session has at
// least one incomplete task (pending or in_progress).

import { denyPreToolUse as deny, isEditTool, isShellTool, isWriteTool } from "./hook-utils.ts";

const input = await Bun.stdin.json();
const toolName: string = input?.tool_name ?? "";
const sessionId: string = input?.session_id ?? "";

if (!sessionId) process.exit(0);

const isBlockedTool = isShellTool(toolName) || isEditTool(toolName) || isWriteTool(toolName);
if (!isBlockedTool) process.exit(0);

const tasksDir = `${process.env.HOME}/.claude/tasks/${sessionId}`;
const activeTasks: string[] = [];

try {
  const glob = new Bun.Glob("*.json");
  for await (const file of glob.scan(tasksDir)) {
    try {
      const task = await Bun.file(`${tasksDir}/${file}`).json();
      const status = task?.status;
      if (status === "pending" || status === "in_progress") {
        activeTasks.push(`#${task.id} (${status}): ${task.subject}`);
      }
    } catch {
      // skip unreadable task files
    }
  }
} catch {
  // tasksDir may not exist yet
}

if (activeTasks.length === 0) {
  deny(
    `STOP. ${toolName} is BLOCKED because this session has no incomplete tasks.\n\n` +
      `You must keep at least one task in pending or in_progress status before using bash/shell/edit tools.\n\n` +
      `Required now:\n` +
      `1. Create or update a task so its status is pending or in_progress.\n` +
      `2. Include a concrete description of the current work and next step.\n\n` +
      `After at least one task is incomplete, ${toolName} will be unblocked automatically.`
  );
}
