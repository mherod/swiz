#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.

import {
  emitContext,
  findPriorSessionTasks,
  isIncompleteTaskStatus,
  readSessionTasks,
  type SessionHookInput,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput
  const matcher = input.matcher ?? input.trigger ?? ""

  // Only fire on compact/resume events, not fresh sessions
  if (matcher !== "compact" && matcher !== "resume") return

  let ctx =
    "Post-compaction context: Always use rg instead of grep. Always use Edit tool, never sed/awk. " +
    "Do not co-author commits. Never disable code checks or quality gates. " +
    "Run git diff after reaching success."

  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id ?? ""

  // Surface current session's incomplete tasks — these survive compaction on disk
  // but the agent loses awareness of them when context resets.
  const currentTasks = await readSessionTasks(sessionId)
  const currentIncomplete = currentTasks.filter((t) => isIncompleteTaskStatus(t.status))
  if (currentIncomplete.length > 0) {
    const taskLines = currentIncomplete
      .map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`)
      .join("\n")
    ctx +=
      `\n\nThis session has ${currentIncomplete.length} incomplete task(s) that survived compaction:\n` +
      taskLines +
      `\n\nIMPORTANT: Complete or update these tasks using TaskUpdate — do NOT create new tasks ` +
      `for the same work. The stop hook will block until every task in this session is completed. ` +
      `If the work described by a task is already done, mark it completed immediately.`
  }

  // Also check prior sessions for incomplete tasks (if current session has none)
  if (currentIncomplete.length === 0) {
    const priorResult = await findPriorSessionTasks(cwd, sessionId)
    if (priorResult && priorResult.tasks.length > 0) {
      const { sessionId: priorSessionId, tasks: priorTasks } = priorResult
      const taskLines = priorTasks.map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`).join("\n")
      const completeHint = priorTasks
        .map(
          (t) => `  swiz tasks complete ${t.id} --session ${priorSessionId} --evidence "note:done"`
        )
        .join("\n")
      ctx +=
        `\n\nPrior session (${priorSessionId}) had ${priorTasks.length} incomplete task(s). ` +
        `If already done, complete them:\n${completeHint}\n` +
        `Otherwise continue these instead of creating new tasks:\n` +
        taskLines
    }
  }

  emitContext("SessionStart", ctx)
}

main()
