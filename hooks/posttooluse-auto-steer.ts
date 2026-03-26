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
 */

import type { AutoSteerTrigger } from "../src/auto-steer-store.ts"
import { getAutoSteerStore } from "../src/auto-steer-store.ts"
import { sanitizeSessionId } from "../src/session-id.ts"
import {
  GIT_COMMIT_RE,
  isShellTool,
  readSessionTasks,
  sendAutoSteer,
  shouldDeferAutoSteerForForegroundChatApp,
} from "./utils/hook-utils.ts"
import type { TerminalApp } from "./utils/terminal-detection.ts"
import { detectTerminal } from "./utils/terminal-detection.ts"

const input = (await Bun.stdin.json().catch(() => null)) as Record<string, unknown> | null
if (!input) process.exit(0)

const sessionId = (input.session_id as string) ?? ""
if (!sessionId) process.exit(0)

const safeSession = sanitizeSessionId(sessionId)
if (!safeSession) process.exit(0)

const store = getAutoSteerStore()

// Determine which triggers are eligible this cycle.
const triggersToDeliver: AutoSteerTrigger[] = []

// next_turn: always eligible
if (store.hasPending(safeSession, "next_turn")) {
  triggersToDeliver.push("next_turn")
}

// after_commit: eligible when the tool was a Bash `git commit`
const toolName = (input.tool_name as string) ?? ""
const toolInput = (input.tool_input as { command?: string } | undefined) ?? {}
const command = toolInput.command ?? ""
if (
  isShellTool(toolName) &&
  GIT_COMMIT_RE.test(command) &&
  store.hasPending(safeSession, "after_commit")
) {
  triggersToDeliver.push("after_commit")
}

// after_all_tasks_complete: eligible when all session tasks are completed
if (store.hasPending(safeSession, "after_all_tasks_complete")) {
  const tasks = await readSessionTasks(sessionId)
  const allComplete =
    tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "cancelled")
  if (allComplete) {
    triggersToDeliver.push("after_all_tasks_complete")
  }
}

if (triggersToDeliver.length === 0) process.exit(0)
if (await shouldDeferAutoSteerForForegroundChatApp()) process.exit(0)

// Prefer terminal info from payload (injected by CLI dispatch for daemon compatibility),
// fall back to direct env detection (local execution without daemon).
const terminal = input._terminal as { app: TerminalApp; name: string } | undefined
const app = terminal?.app ?? detectTerminal().app

// Consume and deliver all eligible triggers in FIFO order.
// Two dedup layers:
//   1. Enqueue-side (in store.enqueue): skips if identical pending or recently delivered
//   2. Send-side (here): deduplicates within the current batch
const sent = new Set<string>()
for (const trigger of triggersToDeliver) {
  const requests = store.consume(safeSession, trigger)
  for (const req of requests) {
    if (sent.has(req.message)) continue
    await sendAutoSteer(req.message, app, { requeueOnForegroundDeferSessionId: sessionId })
    sent.add(req.message)
  }
}

// Prune old delivered rows to prevent unbounded DB growth.
store.prune()
