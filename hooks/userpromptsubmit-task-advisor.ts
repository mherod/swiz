#!/usr/bin/env bun
// UserPromptSubmit hook: Gently suggest TaskCreate when no pending tasks exist

import { readSessionTasks, toolNameForCurrentAgent } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as { session_id?: string }
  const sessionId = input.session_id
  if (!sessionId) return

  const home = process.env.HOME
  if (!home) return

  const tasks = await readSessionTasks(sessionId, home)
  const pendingCount = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  ).length

  if (pendingCount === 0) {
    const taskCreateName = toolNameForCurrentAgent("TaskCreate")
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `No pending tasks in this session. If the upcoming work is non-trivial, use ${taskCreateName} to plan it before starting.`,
        },
      })
    )
  }
}

main()
