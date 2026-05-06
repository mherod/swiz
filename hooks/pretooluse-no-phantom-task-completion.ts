#!/usr/bin/env bun

// PreToolUse hook: Block TaskUpdate with status=completed when the transcript
// shows zero substantive tool calls between the task's last in_progress
// transition and this completion attempt.
//
// Phantom task completion: creating a task solely to satisfy enforcement gates
// and immediately marking it done without doing the stated work. The definitive
// mechanical signal is zero non-task tool calls after the in_progress anchor —
// real work of any kind (Read, Bash, Edit, Skill, Glob…) leaves a trace.
//
// Exemptions:
//   1. Completion description contains traceable evidence prefixes
//      (commit:, pr:, file:, test:, ci_green:)
//   2. No in_progress transition for this task found in the current session
//      transcript — task may have been set in_progress in a prior session.
//      Fail-open; we can only verify what the transcript contains.

import { agentHasTaskToolsForHookPayload } from "../src/agent-paths.ts"
import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { createDefaultTaskStore } from "../src/task-roots.ts"
import { readTasks } from "../src/tasks/task-repository.ts"
import {
  extractToolBlocksFromEntry,
  formatActionPlan,
  isGitRepo,
  isTaskTool,
  preToolUseAllow,
  preToolUseDeny,
  readSessionLines,
  resolveSafeSessionId,
} from "../src/utils/hook-utils.ts"

/** Evidence prefixes that indicate traceable real work was done. */
const EVIDENCE_RE = /\b(?:commit|pr|file|test|ci_green|run):[^\s]/

function hasTrackedEvidence(text: string): boolean {
  return EVIDENCE_RE.test(text)
}

interface ScanResult {
  /** Non-task tool calls found after the last in_progress anchor for this task. */
  workCallCount: number
  /** Whether an in_progress transition for this task was found in the transcript. */
  anchorFound: boolean
}

interface RawInputFields {
  toolName: string
  toolInput: Record<string, any>
  cwd: string
  transcriptPath: string
  sessionId: string | undefined
  safeSessionId: string | undefined
}

/** True when block is a TaskUpdate/update_plan setting this task to in_progress. */
function isInProgressTransition(block: Record<string, any>, taskId: string): boolean {
  const name = String(block.name ?? "")
  const inp = (block.input ?? {}) as Record<string, any>
  const isTaskUpdateName = name === "TaskUpdate" || name === "update_plan"
  if (!isTaskUpdateName) return false
  const matchesTask = String(inp.taskId ?? "") === taskId
  return matchesTask && String(inp.status ?? "") === "in_progress"
}

/** True when this call targets completing a task (TaskUpdate/update_plan, status=completed). */
function isCompletionCall(toolName: string, toolInput: Record<string, any>): boolean {
  const isTaskUpdateName = toolName === "TaskUpdate" || toolName === "update_plan"
  if (!isTaskUpdateName) return false
  return String(toolInput.status ?? "") === "completed"
}

/** Extract and normalise the string fields from a raw hook input. */
function extractRawFields(raw: {
  tool_name?: string
  tool_input?: unknown
  cwd?: string
  transcript_path?: string
  transcriptPath?: string
  session_id?: string
}): RawInputFields {
  return {
    toolName: raw.tool_name ?? "",
    toolInput: (raw.tool_input ?? {}) as Record<string, any>,
    cwd: raw.cwd ?? process.cwd(),
    transcriptPath: raw.transcript_path ?? raw.transcriptPath ?? "",
    sessionId: raw.session_id,
    safeSessionId: resolveSafeSessionId(raw.session_id) ?? undefined,
  }
}

/** Extract task-specific fields from a tool_input record. */
function extractTaskFields(toolInput: Record<string, any>): {
  taskId: string
  description: string
} {
  return {
    taskId: String(toolInput.taskId ?? ""),
    description: String(toolInput.description ?? ""),
  }
}

/**
 * Return the line index of the last in_progress transition for taskId.
 * Returns -1 when no such transition is found in the transcript.
 */
function findAnchorIndex(lines: string[], taskId: string): number {
  let anchorIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    try {
      for (const block of extractToolBlocksFromEntry(line)) {
        if (isInProgressTransition(block, taskId)) anchorIndex = i
      }
    } catch {
      // skip malformed transcript lines
    }
  }
  return anchorIndex
}

/** Count non-task tool calls after startIndex. */
function countWorkCallsFrom(lines: string[], startIndex: number): number {
  let count = 0
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    try {
      for (const block of extractToolBlocksFromEntry(line)) {
        if (!isTaskTool(String(block.name ?? ""))) count++
      }
    } catch {
      // skip malformed transcript lines
    }
  }
  return count
}

function scanTranscript(lines: string[], taskId: string): ScanResult {
  const anchorIndex = findAnchorIndex(lines, taskId)
  if (anchorIndex < 0) return { workCallCount: 0, anchorFound: false }
  return { workCallCount: countWorkCallsFrom(lines, anchorIndex), anchorFound: true }
}

function buildDenialMessage(taskId: string, sessionId: string | undefined): string {
  const sessionNote = sessionId ? ` (session ${sessionId})` : ""
  return (
    `PHANTOM TASK BLOCK: Task #${taskId}${sessionNote} cannot be marked completed.\n\n` +
    `No substantive tool calls (Edit, Write, Bash, Read, Skill, Glob, Grep…) were\n` +
    `recorded after this task was set to in_progress. This is the mechanical signature\n` +
    `of phantom task completion — creating tasks to satisfy enforcement gates without\n` +
    `performing the stated work.\n\n` +
    formatActionPlan(
      [
        "Use Edit, Write, Bash, or Skill to actually perform the work described in the task subject.",
        "Include traceable evidence in description: commit:<sha>, file:<path>, test:<result>, pr:<url>.",
      ],
      { header: "To resolve:" }
    )
  )
}

export async function evaluatePretooluseNoPhantomTaskCompletion(
  input: unknown
): Promise<SwizHookOutput> {
  const raw = toolHookInputSchema.parse(input)
  if (!agentHasTaskToolsForHookPayload(raw as Record<string, any>)) return {}
  const { toolName, toolInput, cwd, transcriptPath, sessionId, safeSessionId } =
    extractRawFields(raw)

  if (!isCompletionCall(toolName, toolInput)) return {}

  const { taskId, description } = extractTaskFields(toolInput)
  if (!taskId) return {}

  // ALLOWANCE: If completing this task leaves at least 2 other tasks in_progress,
  // OR the session has at least 2 pending tasks queued, we assume the session
  // has enough real work in flight or planned to allow a potentially
  // phantom/cleanup task without strict transcript evidence.
  if (sessionId) {
    const { tasksDir } = createDefaultTaskStore()
    const tasks = await readTasks(sessionId, tasksDir)
    const otherInProgress = tasks.filter((t) => t.id !== taskId && t.status === "in_progress")
    if (otherInProgress.length >= 2) {
      return preToolUseAllow(
        `Task #${taskId}: ${otherInProgress.length} other tasks are in_progress — completion allowed (busy session).`
      )
    }
    const otherPending = tasks.filter((t) => t.id !== taskId && t.status === "pending")
    if (otherPending.length >= 2) {
      return preToolUseAllow(
        `Task #${taskId}: ${otherPending.length} pending tasks queued — completion allowed (planned session).`
      )
    }
  }

  if (!(await isGitRepo(cwd))) return preToolUseAllow("Not a git repository.")

  if (hasTrackedEvidence(description)) {
    return preToolUseAllow(`Task #${taskId} completion includes traceable evidence.`)
  }

  if (!transcriptPath) return preToolUseAllow("No transcript path available.")

  const lines = (await readSessionLines(transcriptPath)).filter((l) => l.trim())
  if (lines.length === 0) return preToolUseAllow("Empty session transcript.")

  const { workCallCount, anchorFound } = scanTranscript(lines, taskId)

  if (!anchorFound)
    return preToolUseAllow(`No in_progress transition for #${taskId} in transcript.`)

  if (workCallCount >= 1) {
    return preToolUseAllow(
      `Task #${taskId}: ${workCallCount} work tool call(s) after in_progress — completion allowed.`
    )
  }

  return preToolUseDeny(buildDenialMessage(taskId, safeSessionId))
}

const pretooluseNoPhantomTaskCompletion: SwizToolHook = {
  name: "pretooluse-no-phantom-task-completion",
  event: "preToolUse",
  timeout: 5,

  run(input) {
    return evaluatePretooluseNoPhantomTaskCompletion(input)
  },
}

export default pretooluseNoPhantomTaskCompletion

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseNoPhantomTaskCompletion)
}
