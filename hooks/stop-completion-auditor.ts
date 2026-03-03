#!/usr/bin/env bun
// Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
// Current session tasks must be complete before stopping, regardless of stop_hook_active

import { readdir, readFile } from "node:fs/promises"
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

const GIT_PUSH_RE = /\bgit\s+push\b/

/** Scan transcript for any Bash tool call containing `git push`. */
async function transcriptContainsPush(transcriptPath: string): Promise<boolean> {
  try {
    const text = await readFile(transcriptPath, "utf-8")
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type !== "assistant") continue
        const content = entry?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type !== "tool_use") continue
          const cmd = block?.input?.command
          if (typeof cmd === "string" && GIT_PUSH_RE.test(cmd)) return true
        }
      } catch {}
    }
  } catch {}
  return false
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
          "Create tasks to record the work done.\n\n" +
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
          "Create tasks to record the work done.\n\n" +
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

  // ── CI verification enforcement ───────────────────────────────────────────
  // When all tasks are completed and the session pushed commits, at least one
  // completed task must have evidence mentioning CI verification (e.g.
  // "CI green", "conclusion: success", "CI passed"). This enforces the
  // push+CI task lifecycle rule programmatically.
  if (allTasks.length > 0 && incompleteDetails.length === 0 && transcript) {
    const sessionPushed = await transcriptContainsPush(transcript)

    if (sessionPushed) {
      const CI_EVIDENCE_RE = /\bci\b.*(?:green|pass|success)|conclusion.*success/i
      const completedTasks = allTasks.filter((t) => t.status === "completed")
      const hasCiEvidence = completedTasks.some(
        (t) =>
          (t.completionEvidence && CI_EVIDENCE_RE.test(t.completionEvidence)) ||
          (t.subject && CI_EVIDENCE_RE.test(t.subject))
      )

      if (!hasCiEvidence) {
        blockStop(
          "All tasks are completed but none have CI verification evidence.\n\n" +
            "The push+CI lifecycle rule requires a completed task with evidence " +
            "confirming CI passed (e.g. 'CI green', 'conclusion: success').\n\n" +
            formatActionPlan(
              [
                'Create a "Push and verify CI" task and mark it in_progress.',
                "Run CI verification: swiz ci-wait <SHA> or gh run view --json conclusion.",
                'Mark the task completed: swiz tasks complete <id> --evidence "note:CI green — conclusion: success, run <run-id>"',
              ],
              { translateToolNames: true }
            )
        )
      }
    }
  }
}

main()
