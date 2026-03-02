#!/usr/bin/env bun
// UserPromptSubmit hook: Gently suggest TaskCreate when no pending tasks exist

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { toolNameForCurrentAgent } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as { session_id?: string }
  const sessionId = input.session_id
  if (!sessionId) return

  const home = process.env.HOME
  if (!home) return
  const tasksDir = join(home, ".claude", "tasks", sessionId)

  let pendingCount = 0
  try {
    const files = await readdir(tasksDir)
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const task = (await Bun.file(join(tasksDir, f)).json()) as { status?: string }
        if (task.status === "pending" || task.status === "in_progress") {
          pendingCount++
        }
      } catch {}
    }
  } catch {
    // No tasks directory — count stays 0
  }

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
