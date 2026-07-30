#!/usr/bin/env bun

import {
  ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY,
  type ActiveLifecycleTask,
  formatLifecycleTaskAdvisory,
} from "../src/commands/daemon/lifecycle-task-registry.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import type { StopHookInput } from "../src/schemas.ts"
import { isJsonLikeRecord } from "../src/utils/hook-json-helpers.ts"

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseActiveLifecycleTask(candidate: unknown): ActiveLifecycleTask | null {
  if (!isJsonLikeRecord(candidate) || Array.isArray(candidate)) return null
  const taskId = nonBlankString(candidate.taskId)
  if (!taskId) return null
  const subject = nonBlankString(candidate.subject)
  if (!subject) return null
  const createdAt = finiteNumber(candidate.createdAt)
  if (createdAt === null) return null

  const task: ActiveLifecycleTask = {
    taskId,
    subject,
    createdAt,
  }
  if (typeof candidate.description === "string") task.description = candidate.description
  if (typeof candidate.teammateName === "string") task.teammateName = candidate.teammateName
  if (typeof candidate.teamName === "string") task.teamName = candidate.teamName
  return task
}

function parseActiveLifecycleTasks(input: StopHookInput): ActiveLifecycleTask[] {
  const raw = input[ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY]
  if (!Array.isArray(raw)) return []

  const tasks: ActiveLifecycleTask[] = []
  for (const candidate of raw) {
    const task = parseActiveLifecycleTask(candidate)
    if (task) tasks.push(task)
  }
  return tasks
}

export function evaluateStopLifecycleTasks(input: StopHookInput): SwizHookOutput {
  const tasks = parseActiveLifecycleTasks(input)
  const message = formatLifecycleTaskAdvisory(tasks)
  if (!message) return {}

  return buildContextHookOutput("Stop", message)
}

const stopLifecycleTasks: SwizStopHook = {
  name: "stop-lifecycle-tasks",
  event: "stop",
  timeout: 2,
  run: evaluateStopLifecycleTasks,
}

export default stopLifecycleTasks

if (import.meta.main) {
  await runSwizHookAsMain(stopLifecycleTasks)
}
