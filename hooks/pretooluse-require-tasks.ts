#!/usr/bin/env bun
// PreToolUse hook: Deny Edit/Write/Bash when:
//   1. No tasks created after TOOL_CALL_THRESHOLD tool calls
//   2. Tasks exist but no task tool called in last STALENESS_THRESHOLD calls
//
// Pure transcript scan — no sentinel files, no external state, no race conditions.

import { denyPreToolUse as deny, extractToolNamesFromTranscript, READ_TOOLS, TASK_TOOLS } from "./hook-utils.ts";

const TOOL_CALL_THRESHOLD = 10;
const STALENESS_THRESHOLD = 20;

const input = await Bun.stdin.json();
const transcriptPath: string = input?.transcript_path ?? "";
const toolName: string = input?.tool_name ?? "";
const sessionId: string = input?.session_id ?? "";

if (!transcriptPath || !sessionId) process.exit(0);

if (READ_TOOLS.has(toolName)) process.exit(0);

if (!(await Bun.file(transcriptPath).exists())) process.exit(0);

// Parse transcript: extract all assistant tool_use names in order
const toolNames = await extractToolNamesFromTranscript(transcriptPath);

const total = toolNames.length;
if (total < TOOL_CALL_THRESHOLD) process.exit(0);

// Find index of last task tool call
let lastTaskIndex = -1;
for (let i = toolNames.length - 1; i >= 0; i--) {
  if (TASK_TOOLS.has(toolNames[i]!)) {
    lastTaskIndex = i;
    break;
  }
}

const callsSinceTask = total - 1 - lastTaskIndex;

// CHECK 1: No tasks at all (lastTaskIndex == -1 means callsSinceTask == total)
if (callsSinceTask >= total) {
  deny(
    `STOP. ${total} tool calls made but ZERO tasks created. ${toolName} is BLOCKED.\n\n` +
      `You are working without a plan. Every idea, recommendation, and observation must be translated into concrete tracked tasks — not proposed, not suggested, done.\n\n` +
      `YOU MUST DO ALL OF THE FOLLOWING BEFORE CONTINUING:\n` +
      `1. Analyze the full state — code, git history, current objective — and create tasks that map out every step you can identify.\n` +
      `2. Set the current task to in_progress with a detailed description of what you are doing now and what approach you are taking.\n` +
      `3. Plan ahead — ensure at least two upcoming tasks exist beyond the current work (e.g., verify success criteria, run tests, commit changes). There is always more to plan.\n\n` +
      `After creating tasks, ${toolName} will be unblocked automatically.`
  );
}

// CHECK 2: Tasks stale
if (callsSinceTask >= STALENESS_THRESHOLD) {
  // Read active tasks from task files
  const tasksDir = `${process.env.HOME}/.claude/tasks/${sessionId}`;
  const activeTasks: string[] = [];

  try {
    const glob = new Bun.Glob("*.json");
    for await (const file of glob.scan(tasksDir)) {
      try {
        const task = await Bun.file(`${tasksDir}/${file}`).json();
        if (task?.status === "pending" || task?.status === "in_progress") {
          activeTasks.push(`#${task.id} (${task.status}): ${task.subject}`);
        }
      } catch {
        // skip unreadable task files
      }
    }
  } catch {
    // tasksDir may not exist yet
  }

  const taskList =
    activeTasks.length > 0
      ? `Active tasks: ${activeTasks.join(" | ")}\n\n`
      : "";
  deny(
    `STOP. Your tasks have gone stale. ${callsSinceTask} tool calls since last task update. ` +
      `${toolName} is BLOCKED.\n\n` +
      taskList +
      `Tasks are not suggestions — they are your execution plan. Every task must reflect reality. Stale tasks mean you are operating without accountability.\n\n` +
      `YOU MUST DO ALL OF THE FOLLOWING BEFORE CONTINUING:\n` +
      `1. Update every existing task with latest progress — mark completed tasks done with forensic evidence of what was accomplished. Update in-progress tasks with current status, approach, and findings.\n` +
      `2. Ensure the current work has a task — create or update it with good detail describing what you are doing now, what approach you are taking, and what specifically remains.\n` +
      `3. Plan ahead — ensure at least two upcoming tasks exist beyond the current work (e.g., verify success criteria, run tests, commit changes, push). There is always more to plan. Do not stop planning just because the immediate step is clear.\n\n` +
      `After updating tasks, ${toolName} will be unblocked automatically.`
  );
}

// CHECK 3: No active in_progress task
if (total >= TOOL_CALL_THRESHOLD) {
  const tasksDir = `${process.env.HOME}/.claude/tasks/${sessionId}`;
  let hasInProgressTask = false;

  try {
    const glob = new Bun.Glob("*.json");
    for await (const file of glob.scan(tasksDir)) {
      try {
        const task = await Bun.file(`${tasksDir}/${file}`).json();
        if (task?.status === "in_progress") {
          hasInProgressTask = true;
          break;
        }
      } catch {
        // skip unreadable task files
      }
    }
  } catch {
    // tasksDir may not exist yet
  }

  if (!hasInProgressTask) {
    deny(
      `STOP. No active in_progress task. ${toolName} is BLOCKED.\n\n` +
        `You must have an explicit in_progress task to guide current work. This ensures accountability and clarity.\n\n` +
        `YOU MUST DO THE FOLLOWING BEFORE CONTINUING:\n` +
        `1. Create a new task or update an existing task to in_progress status.\n` +
        `2. Add a detailed description: what you are doing now, what approach you are taking, and what specifically remains.\n` +
        `3. Ensure at least two upcoming tasks exist beyond the current work for planning ahead.\n\n` +
        `After setting an in_progress task, ${toolName} will be unblocked automatically.`
    );
  }
}
