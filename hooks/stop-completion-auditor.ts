#!/usr/bin/env bun
// Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
// Current session tasks must be complete before stopping, regardless of stop_hook_active

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  blockStop,
  extractToolNamesFromTranscript,
  formatActionPlan,
  isTaskCreateTool,
  readSessionTasks,
  type SessionTask,
  type StopHookInput,
} from "./hook-utils.ts"

const TOOL_CALL_THRESHOLD = 10

type TaskFile = SessionTask

interface AuditEntry {
  action: string
  taskId: string
  newStatus?: string
  timestamp?: string
}

async function countToolCalls(
  transcriptPath: string
): Promise<{ total: number; taskToolUsed: boolean }> {
  const toolNames = await extractToolNamesFromTranscript(transcriptPath)
  return {
    total: toolNames.length,
    taskToolUsed: toolNames.some((n) => n === "TaskUpdate" || isTaskCreateTool(n)),
  }
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const sessionId = input.session_id ?? ""
  const transcript = input.transcript_path ?? ""
  const home = process.env.HOME
  if (!home) return
  const tasksDir = join(home, ".claude", "tasks", sessionId)

  const { total: toolCallCount, taskToolUsed } = transcript
    ? await countToolCalls(transcript)
    : { total: 0, taskToolUsed: false }

  const allTasks = await readSessionTasks(sessionId, home)
  const tasksDirExists =
    allTasks.length > 0 ||
    (await (async () => {
      try {
        await readdir(tasksDir)
        return true
      } catch {
        return false
      }
    })())

  if (!tasksDirExists) {
    // If task tools were used, tasks existed and were completed
    if (taskToolUsed) return

    // No tasks ever created — mandate if session has been substantial
    if (toolCallCount >= TOOL_CALL_THRESHOLD) {
      blockStop(
        `No tasks were created this session (${toolCallCount} tool calls made).\n\n` +
          "Create tasks to record the work done:\n" +
          formatActionPlan(
            [
              "Use TaskCreate to create one task for each significant piece of work",
              "Use TaskUpdate to mark each task completed after recording the work",
            ],
            { translateToolNames: true }
          )
      )
    }
    return
  }

  // Read task files
  const anyTaskFound = allTasks.length > 0
  const incompleteDetails = allTasks
    .filter((t) => t.id && t.id !== "null")
    .filter((t): t is TaskFile => t.status === "pending" || t.status === "in_progress")
    .map((t) => `#${t.id} [${t.status}]: ${t.subject}`)

  // If no live task files found, check audit log
  if (!anyTaskFound) {
    const auditLog = join(tasksDir, ".audit-log.jsonl")
    try {
      const auditText = await Bun.file(auditLog).text()
      const entries: AuditEntry[] = auditText
        .trim()
        .split("\n")
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean) as AuditEntry[]

      const created = entries.filter((e) => e.action === "create").length

      // Group status changes by taskId, take latest
      const latestStatus = new Map<string, string>()
      for (const e of entries) {
        if (e.action === "status_change" && e.newStatus) {
          latestStatus.set(e.taskId, e.newStatus)
        }
      }
      const incomplete = Array.from(latestStatus.values()).filter(
        (s) => s === "pending" || s === "in_progress"
      ).length

      if (created > 0 && incomplete === 0) return // All completed
    } catch {}

    if (taskToolUsed) return

    if (toolCallCount >= TOOL_CALL_THRESHOLD) {
      blockStop(
        `No completed tasks on record (${toolCallCount} tool calls made).\n\n` +
          "Create tasks to record the work done:\n" +
          formatActionPlan(
            [
              "Use TaskCreate to create one task for each significant piece of work",
              "Use TaskUpdate to mark each task completed after recording the work",
            ],
            { translateToolNames: true }
          )
      )
    }
    return
  }

  // Block if incomplete tasks exist
  if (incompleteDetails.length > 0) {
    blockStop(
      "Incomplete tasks found:\n\n" +
        incompleteDetails.join("\n") +
        "\n\nComplete the work described in each task before stopping."
    )
  }
}

main()
