#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.

import { emitContext, findPriorSessionTasks, type SessionHookInput } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput
  const matcher = input.matcher ?? input.trigger ?? ""

  // Only fire on compact/resume events, not fresh sessions
  if (matcher !== "compact" && matcher !== "resume") return

  let ctx =
    "Post-compaction context: Use rg instead of grep. Use the Edit/StrReplace tool, never sed/awk. " +
    "Do not co-author commits or PRs. Never disable code checks or quality gates. " +
    "Run git diff after reaching success. Check task list before starting new work."

  // Restore incomplete tasks from the prior session so the agent continues
  // the existing plan rather than starting fresh after compaction.
  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id ?? ""
  const priorTasks = await findPriorSessionTasks(cwd, sessionId)
  if (priorTasks.length > 0) {
    const taskLines = priorTasks.map((t) => `  • #${t.id} [${t.status}]: ${t.subject}`).join("\n")
    ctx +=
      `\n\nPrior session had ${priorTasks.length} incomplete task(s) — continue these instead of creating new tasks:\n` +
      taskLines
  }

  emitContext("SessionStart", ctx)
}

main()
