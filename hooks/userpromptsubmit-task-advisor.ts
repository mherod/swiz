#!/usr/bin/env bun
// UserPromptSubmit hook: Inject task-creation context on every prompt.

import { agentHasTaskTools, toolNameForCurrentAgent } from "../src/agent-paths.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type UserPromptSubmitHookInput, userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { isIncompleteTaskStatus, readSessionTasks } from "../src/tasks/task-recovery.ts"

export async function evaluateUserpromptsubmitTaskAdvisor(input: unknown): Promise<SwizHookOutput> {
  const hookInput: UserPromptSubmitHookInput = userPromptSubmitHookInputSchema.parse(input)
  const sessionId = hookInput.session_id
  if (!sessionId) return {}

  if (!agentHasTaskTools()) return {}

  const home = getHomeDirOrNull()
  if (!home) return {}

  const tasks = await readSessionTasks(sessionId, home)
  const pendingCount = tasks.filter((t) => isIncompleteTaskStatus(t.status)).length

  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  let additionalContext: string

  if (pendingCount === 0) {
    additionalContext = `No pending tasks in this session. Use ${taskCreateName} to create a task for this prompt before starting work.`
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
