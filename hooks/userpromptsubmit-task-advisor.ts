#!/usr/bin/env bun
// UserPromptSubmit hook: Gently suggest TaskCreate when no pending tasks exist

import {
  findPriorSessionTasks,
  limitItems,
  readSessionTasks,
  toolNameForCurrentAgent,
} from "./hook-utils.ts"

const TASK_PREVIEW_LIMIT = 3

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as { session_id?: string; cwd?: string }
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

    // Check if the prior session had incomplete tasks the agent should resume
    const cwd = input.cwd ?? process.cwd()
    const priorResult = await findPriorSessionTasks(cwd, sessionId, home)

    let additionalContext: string
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const { visible, remaining } = limitItems(priorTasks, TASK_PREVIEW_LIMIT)
      const taskLines = visible.map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`).join("\n")
      const overflow = remaining > 0 ? `\n  ... ${remaining} more incomplete task(s)` : ""
      const completeHint = `swiz tasks complete <id> --session ${priorSessionId} --evidence "note:done"`
      additionalContext =
        `Prior session (${priorSessionId}) has ${priorTasks.length} incomplete task(s). ` +
        `If already done, run: ${completeHint}\n` +
        `Resume using ${taskCreateName} before starting new work:\n` +
        taskLines +
        overflow
    } else {
      additionalContext = `No pending tasks in this session. If the upcoming work is non-trivial, use ${taskCreateName} to plan it before starting.`
    }

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      })
    )
  }
}

main()
