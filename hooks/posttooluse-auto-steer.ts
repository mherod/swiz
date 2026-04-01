#!/usr/bin/env bun
/**
 * PostToolUse hook: auto-steer — types a steering prompt into the active terminal
 * when a request has been scheduled by another hook via `scheduleAutoSteer()`.
 *
 * Handles three trigger types during PostToolUse:
 *   - `next_turn`              — deliver on every PostToolUse cycle (default)
 *   - `after_commit`           — deliver when the tool was a Bash `git commit`
 *   - `after_all_tasks_complete` — deliver when all session tasks are completed
 *
 * Consumes scheduled requests from the SQLite queue and sends them via AppleScript.
 * This is an async fire-and-forget hook — it does not block tool execution.
 *
 * Terminal detection is injected into the payload by src/commands/dispatch.ts
 * (the CLI process has the terminal env vars; the daemon does not).
 *
 * Dual-mode: SwizHook + runSwizHookAsMain.
 */

import type { AutoSteerTrigger } from "../src/auto-steer-store.ts"
import { getAutoSteerStore } from "../src/auto-steer-store.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { sanitizeSessionId } from "../src/session-id.ts"
import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import {
  GIT_COMMIT_RE,
  isShellTool,
  sendAutoSteer,
  shouldDeferAutoSteerForForegroundChatApp,
} from "../src/utils/hook-utils.ts"
import type { TerminalApp } from "../src/utils/terminal-detection.ts"
import { detectTerminal } from "../src/utils/terminal-detection.ts"

export async function evaluatePosttooluseAutoSteer(input: unknown): Promise<SwizHookOutput> {
  if (!input || typeof input !== "object") return {}
  const rec = input as Record<string, any>

  const sessionId = (rec.session_id as string) ?? ""
  if (!sessionId) return {}

  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return {}

  const store = getAutoSteerStore()
  const triggersToDeliver: AutoSteerTrigger[] = []

  if (store.hasPending(safeSession, "next_turn")) {
    triggersToDeliver.push("next_turn")
  }

  const toolName = (rec.tool_name as string) ?? ""
  const toolInput = (rec.tool_input as { command?: string } | undefined) ?? {}
  const command = toolInput.command ?? ""
  if (
    isShellTool(toolName) &&
    GIT_COMMIT_RE.test(command) &&
    store.hasPending(safeSession, "after_commit")
  ) {
    triggersToDeliver.push("after_commit")
  }

  if (store.hasPending(safeSession, "after_all_tasks_complete")) {
    const tasks = await readSessionTasks(sessionId)
    const allComplete =
      tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "cancelled")
    if (allComplete) {
      triggersToDeliver.push("after_all_tasks_complete")
    }
  }

  if (triggersToDeliver.length === 0) return {}
  if (await shouldDeferAutoSteerForForegroundChatApp()) return {}

  const terminal = rec._terminal as { app: TerminalApp; name: string } | undefined
  const app = terminal?.app ?? detectTerminal().app

  const sent = new Set<string>()
  for (const trigger of triggersToDeliver) {
    const requests = store.consumeOne(safeSession, trigger)
    const req = requests[0]
    if (req && !sent.has(req.message)) {
      await sendAutoSteer(req.message, app, { requeueOnForegroundDeferSessionId: sessionId })
      sent.add(req.message)
    }
  }

  store.prune()
  return {}
}

const posttooluseAutoSteer: SwizHook<Record<string, any>> = {
  name: "posttooluse-auto-steer",
  event: "postToolUse",
  timeout: 10,
  async: true,
  requiredSettings: ["autoSteer"],

  run(input) {
    return evaluatePosttooluseAutoSteer(input)
  },
}

export default posttooluseAutoSteer

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseAutoSteer)
}
