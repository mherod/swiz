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

import {
  allowPreToolUse,
  denyPreToolUse,
  extractToolBlocksFromEntry,
  formatActionPlan,
  isGitRepo,
  isTaskTool,
  readSessionLines,
  resolveSafeSessionId,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

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

/**
 * Walk the transcript to find the last time taskId was set to in_progress.
 * Then count non-task tool calls from that anchor to the end of the transcript.
 * Returns anchorFound=false when no in_progress transition is found — this
 * signals fail-open: the task may have been worked on in a prior session.
 */
function scanTranscript(lines: string[], taskId: string): ScanResult {
  let anchorIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    try {
      for (const block of extractToolBlocksFromEntry(line)) {
        const name = String(block.name ?? "")
        const inp = (block.input ?? {}) as Record<string, unknown>
        if (
          (name === "TaskUpdate" || name === "update_plan") &&
          String(inp.taskId ?? "") === taskId &&
          String(inp.status ?? "") === "in_progress"
        ) {
          anchorIndex = i
        }
      }
    } catch {
      // skip malformed transcript lines
    }
  }

  if (anchorIndex < 0) {
    return { workCallCount: 0, anchorFound: false }
  }

  let workCallCount = 0
  for (let i = anchorIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    try {
      for (const block of extractToolBlocksFromEntry(line)) {
        const name = String(block.name ?? "")
        if (!isTaskTool(name)) {
          workCallCount++
        }
      }
    } catch {
      // skip malformed transcript lines
    }
  }

  return { workCallCount, anchorFound: true }
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const toolName = input.tool_name ?? ""
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>

  if (toolName !== "TaskUpdate" && toolName !== "update_plan") return
  if (String(toolInput.status ?? "") !== "completed") return

  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) return

  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) return

  // Evidence in the completion description bypasses the work-count gate.
  const newDescription = String(toolInput.description ?? "")
  if (hasTrackedEvidence(newDescription)) {
    allowPreToolUse(`Task #${taskId} completion includes traceable evidence.`)
  }

  const transcriptPath = input.transcript_path ?? ""
  if (!transcriptPath) return

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)

  const lines = (await readSessionLines(transcriptPath)).filter((l) => l.trim())
  if (lines.length === 0) return

  const { workCallCount, anchorFound } = scanTranscript(lines, taskId)

  // No in_progress transition in transcript → cannot verify → allow (fail-open).
  if (!anchorFound) return

  if (workCallCount >= 1) {
    allowPreToolUse(
      `Task #${taskId}: ${workCallCount} substantive tool call(s) found — completion allowed.`
    )
  }

  // Zero work calls after the in_progress anchor → phantom completion.
  const sessionNote = sessionId ? ` (session ${sessionId})` : ""
  denyPreToolUse(
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

if (import.meta.main) await main()
