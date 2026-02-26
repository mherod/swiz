#!/usr/bin/env bun
// Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
// Current session tasks must be complete before stopping, regardless of stop_hook_active

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { blockStop, type StopHookInput } from "./hook-utils.ts";

export {};

const TOOL_CALL_THRESHOLD = 10;

interface TranscriptEntry {
  type: string;
  message?: {
    content?: Array<{ type: string; name?: string; id?: string }>;
  };
}

interface TaskFile {
  id: string;
  status: string;
  subject: string;
}

interface AuditEntry {
  action: string;
  taskId: string;
  newStatus?: string;
  timestamp?: string;
}

async function countToolCalls(transcriptPath: string): Promise<{ total: number; taskToolUsed: boolean }> {
  try {
    const text = await Bun.file(transcriptPath).text();
    let total = 0;
    let taskToolUsed = false;
    const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

    for (const line of text.trim().split("\n")) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry.type !== "assistant") continue;
        for (const block of entry.message?.content ?? []) {
          if (block.type === "tool_use") {
            total++;
            if (block.name && TASK_TOOLS.has(block.name)) taskToolUsed = true;
          }
        }
      } catch {}
    }

    return { total, taskToolUsed };
  } catch {
    return { total: 0, taskToolUsed: false };
  }
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const sessionId = input.session_id ?? "";
  const transcript = input.transcript_path ?? "";
  const tasksDir = join(process.env.HOME!, ".claude", "tasks", sessionId);

  const { total: toolCallCount, taskToolUsed } = transcript
    ? await countToolCalls(transcript)
    : { total: 0, taskToolUsed: false };

  // Check if tasks directory exists
  let tasksDirExists = false;
  try {
    await readdir(tasksDir);
    tasksDirExists = true;
  } catch {}

  if (!tasksDirExists) {
    // If task tools were used, tasks existed and were completed
    if (taskToolUsed) return;

    // No tasks ever created — mandate if session has been substantial
    if (toolCallCount >= TOOL_CALL_THRESHOLD) {
      blockStop(
        `No tasks were created this session (${toolCallCount} tool calls made).\n\n` +
          "Create tasks to record the work done:\n" +
          "  1. TaskCreate for each significant piece of work\n" +
          "  2. TaskUpdate (status: completed) on each task"
      );
    }
    return;
  }

  // Read task files
  const incompleteDetails: string[] = [];
  let anyTaskFound = false;

  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const task = (await Bun.file(join(tasksDir, f)).json()) as TaskFile;
        if (!task.id || task.id === "null") continue;
        anyTaskFound = true;

        if (task.status === "pending" || task.status === "in_progress") {
          incompleteDetails.push(`#${task.id} [${task.status}]: ${task.subject}`);
        }
      } catch {}
    }
  } catch {}

  // If no live task files found, check audit log
  if (!anyTaskFound) {
    const auditLog = join(tasksDir, ".audit-log.jsonl");
    try {
      const auditText = await Bun.file(auditLog).text();
      const entries: AuditEntry[] = auditText
        .trim()
        .split("\n")
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean) as AuditEntry[];

      const created = entries.filter((e) => e.action === "create").length;

      // Group status changes by taskId, take latest
      const latestStatus = new Map<string, string>();
      for (const e of entries) {
        if (e.action === "status_change" && e.newStatus) {
          latestStatus.set(e.taskId, e.newStatus);
        }
      }
      const incomplete = [...latestStatus.values()].filter(
        (s) => s === "pending" || s === "in_progress"
      ).length;

      if (created > 0 && incomplete === 0) return; // All completed
    } catch {}

    if (taskToolUsed) return;

    if (toolCallCount >= TOOL_CALL_THRESHOLD) {
      blockStop(
        `No completed tasks on record (${toolCallCount} tool calls made).\n\n` +
          "Create tasks to record the work done:\n" +
          "  1. TaskCreate for each significant piece of work\n" +
          "  2. TaskUpdate (status: completed) on each task"
      );
    }
    return;
  }

  // Block if incomplete tasks exist
  if (incompleteDetails.length > 0) {
    blockStop(
      "Incomplete tasks found:\n\n" +
        incompleteDetails.join("\n") +
        "\n\nComplete the work described in each task before stopping."
    );
  }
}

main();
