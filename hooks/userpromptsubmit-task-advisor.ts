#!/usr/bin/env bun
// UserPromptSubmit hook: Gently suggest TaskCreate when no pending tasks exist

import { findPriorSessionTasks, readSessionTasks, toolNameForCurrentAgent } from "./hook-utils.ts"

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
      const taskLines = priorTasks.map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`).join("\n")
      const completeHint = priorTasks
        .map(
          (t) => `  swiz tasks complete ${t.id} --session ${priorSessionId} --evidence "note:done"`
        )
        .join("\n")
      additionalContext =
        `Prior session (${priorSessionId}) had ${priorTasks.length} incomplete task(s). ` +
        `If already done, complete them:\n${completeHint}\n` +
        `Otherwise resume using ${taskCreateName} before starting new work:\n` +
        taskLines
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
