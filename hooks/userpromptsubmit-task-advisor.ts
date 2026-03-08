#!/usr/bin/env bun
// UserPromptSubmit hook: Inject task-creation context on every prompt.
// When no pending tasks exist: also surfaces incomplete prior-session tasks.

import { getHomeDirOrNull } from "../src/home.ts"
import {
  emitContext,
  findPriorSessionTasks,
  formatTaskCompleteCommand,
  formatTaskList,
  readSessionTasks,
  type SessionHookInput,
  toolNameForCurrentAgent,
} from "./hook-utils.ts"

const TASK_PREVIEW_LIMIT = 3

async function main(): Promise<void> {
  const input: SessionHookInput = await Bun.stdin.json()
  const sessionId = input.session_id
  if (!sessionId) return

  const home = getHomeDirOrNull()
  if (!home) return

  const tasks = await readSessionTasks(sessionId, home)
  const pendingCount = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  ).length

  const cwd = input.cwd ?? process.cwd()
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  let additionalContext: string

  if (pendingCount === 0) {
    // Check if the prior session had incomplete tasks the agent should resume
    const priorResult = await findPriorSessionTasks(cwd, sessionId, home)

    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const completeHint = formatTaskCompleteCommand("<id>", priorSessionId, "note:done")
      additionalContext =
        `Prior session (${priorSessionId}) has ${priorTasks.length} incomplete task(s). ` +
        `If already done, run: ${completeHint}\n` +
        `Resume using ${taskCreateName} before starting new work:\n` +
        formatTaskList(priorTasks, {
          limit: TASK_PREVIEW_LIMIT,
          overflowLabel: "incomplete task(s)",
        })
    } else {
      additionalContext = `No pending tasks in this session. Use ${taskCreateName} to create a task for this prompt before starting work.`
    }
  } else {
    // Tasks exist — still remind the agent to create one for the new message.
    additionalContext = `Use ${taskCreateName} to create a task for this prompt before starting work on it.`
  }

  emitContext("UserPromptSubmit", additionalContext, cwd)
}

main()
