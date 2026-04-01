#!/usr/bin/env bun
// UserPromptSubmit hook: Inject task-creation context on every prompt.

import { toolNameForCurrentAgent } from "../src/agent-paths.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import { buildContextHookOutput, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import {
  findPriorSessionTasks,
  formatNativeTaskCompleteCommand,
  formatTaskList,
  isIncompleteTaskStatus,
  readSessionTasks,
} from "../src/tasks/task-recovery.ts"
import { type UserPromptSubmitHookInput, userPromptSubmitHookInputSchema } from "./schemas.ts"

const TASK_PREVIEW_LIMIT = 3

export async function evaluateUserpromptsubmitTaskAdvisor(input: unknown): Promise<SwizHookOutput> {
  const hookInput: UserPromptSubmitHookInput = userPromptSubmitHookInputSchema.parse(input)
  const sessionId = hookInput.session_id
  if (!sessionId) return {}

  const home = getHomeDirOrNull()
  if (!home) return {}

  const tasks = await readSessionTasks(sessionId, home)
  const pendingCount = tasks.filter((t) => isIncompleteTaskStatus(t.status)).length

  const cwd = hookInput.cwd ?? process.cwd()
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  let additionalContext: string

  if (pendingCount === 0) {
    const priorResult = await findPriorSessionTasks(cwd, sessionId, home)

    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const completeHint = formatNativeTaskCompleteCommand("<id>", priorSessionId, "note:done")
      additionalContext =
        `Prior session (${priorSessionId}) has ${priorTasks.length} incomplete task(s). ` +
        `If already done: ${completeHint}\n` +
        `Resume using ${taskCreateName} before starting new work:\n` +
        formatTaskList(priorTasks, {
          limit: TASK_PREVIEW_LIMIT,
          overflowLabel: "incomplete task(s)",
        })
    } else {
      additionalContext = `No pending tasks in this session. Use ${taskCreateName} to create a task for this prompt before starting work.`
    }
  } else {
    additionalContext = `Use ${taskCreateName} to create a task for this prompt before starting work on it.`
  }

  return buildContextHookOutput("UserPromptSubmit", additionalContext)
}

const userpromptsubmitTaskAdvisor: SwizHook<Record<string, any>> = {
  name: "userpromptsubmit-task-advisor",
  event: "userPromptSubmit",
  timeout: 5,
  run(input) {
    return evaluateUserpromptsubmitTaskAdvisor(input)
  },
}

export default userpromptsubmitTaskAdvisor

if (import.meta.main) {
  await runSwizHookAsMain(userpromptsubmitTaskAdvisor)
}
