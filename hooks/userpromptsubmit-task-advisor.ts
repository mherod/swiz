#!/usr/bin/env bun
// UserPromptSubmit hook: Inject task-creation context on every prompt.

import { agentHasTaskToolsForHookPayload, toolNameForCurrentAgent } from "../src/agent-paths.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type UserPromptSubmitHookInput, userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { buildUserPromptTaskContext } from "../src/tasks/task-governance-messages.ts"
import { isIncompleteTaskStatus, readSessionTasks } from "../src/tasks/task-recovery.ts"

export async function evaluateUserpromptsubmitTaskAdvisor(input: unknown): Promise<SwizHookOutput> {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, any>) : {}
  if (!agentHasTaskToolsForHookPayload(raw)) return {}
  const hookInput: UserPromptSubmitHookInput = userPromptSubmitHookInputSchema.parse(input)
  const sessionId = hookInput.session_id
  if (!sessionId) return {}

  const home = getHomeDirOrNull()
  if (!home) return {}

  const tasks = await readSessionTasks(sessionId, home)
  const pendingCount = tasks.filter((t) => isIncompleteTaskStatus(t.status)).length

  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  const additionalContext = buildUserPromptTaskContext(pendingCount, taskCreateName)

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
