#!/usr/bin/env bun
// PostToolUse hook: Remind agents to create/update tasks regularly
// Provides countdown hints showing remaining calls until mandatory enforcement
// Uses transcript scan (no external state) to determine position

import {
  extractToolNamesFromTranscript,
  getTranscriptSummary,
  isTaskTool,
  type ToolHookInput,
  toolNameForCurrentAgent,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput & Record<string, unknown>
  const transcript = input.transcript_path
  if (!transcript) return

  const summary = getTranscriptSummary(input)
  const toolNames = summary?.toolNames ?? (await extractToolNamesFromTranscript(transcript))
  const total = toolNames.length
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  const lastTaskIdx = toolNames.reduce((acc, name, i) => (isTaskTool(name) ? i : acc), -1)
  const callsSinceTask = total - 1 - lastTaskIdx

  const CREATION_THRESHOLD = 5
  const STALENESS_THRESHOLD = 10

  // --- No tasks ever created: countdown to mandatory creation ---
  if (callsSinceTask >= total) {
    const remaining = CREATION_THRESHOLD - total
    if (remaining <= 0) return // PreToolUse will block
    if (remaining <= 1) {
      emit(
        `${taskCreateName} required in ${remaining} tool call(s) — tools will be blocked until tasks are defined.`
      )
    } else if (remaining <= 3) {
      emit(
        `${taskCreateName} required in ${remaining} tool calls. Plan your tasks now to avoid interruption.`
      )
    } else if (total >= 2) {
      emit(`${total}/${CREATION_THRESHOLD} tool calls before ${taskCreateName} is required.`)
    }
    return
  }

  // --- Tasks exist: countdown to staleness enforcement ---
  const staleRemaining = STALENESS_THRESHOLD - callsSinceTask
  if (staleRemaining <= 0) return // PreToolUse will block
  if (staleRemaining <= 2) {
    emit(
      `Task update required in ${staleRemaining} tool call(s) — tools will be blocked until tasks are reviewed.`
    )
  } else if (staleRemaining <= 4) {
    emit(
      `Task update due in ${staleRemaining} tool calls. Review progress — mark completed tasks done or create new ones.`
    )
  }
}

function emit(context: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    })
  )
}

main()
