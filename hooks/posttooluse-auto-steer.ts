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

import { statSync } from "node:fs"
import type { AutoSteerTrigger } from "../src/auto-steer-store.ts"
import { getAutoSteerStore } from "../src/auto-steer-store.ts"
import { projectKeyFromCwd } from "../src/project-key.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { sanitizeSessionId } from "../src/session-id.ts"
import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import {
  SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS,
  swizMcpChannelHeartbeatPath,
} from "../src/temp-paths.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { shouldDeferAutoSteerForForegroundChatApp } from "../src/utils/auto-steer-foreground.ts"
import { sendAutoSteer } from "../src/utils/hook-utils.ts"
import { GIT_COMMIT_RE } from "../src/utils/shell-patterns.ts"
import type { TerminalApp } from "../src/utils/terminal-detection.ts"
import { detectTerminal } from "../src/utils/terminal-detection.ts"

/**
 * True when a `swiz mcp` drain loop is actively serving this project (heartbeat
 * sentinel refreshed within the fresh window). PostToolUse then yields
 * `next_turn` delivery to the MCP channel path so Claude receives auto-steers
 * as `<channel source="swiz">` events instead of AppleScript keystrokes.
 */
function isMcpChannelLiveForCwd(cwd: string): boolean {
  if (!cwd) return false
  try {
    const path = swizMcpChannelHeartbeatPath(projectKeyFromCwd(cwd))
    const mtimeMs = statSync(path).mtimeMs
    return Date.now() - mtimeMs < SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS
  } catch {
    return false
  }
}

function hasCommitTrigger(
  store: ReturnType<typeof getAutoSteerStore>,
  safeSession: string,
  rec: Record<string, any>
): boolean {
  if (!store.hasPending(safeSession, "after_commit")) return false
  const toolName = (rec.tool_name as string) ?? ""
  const toolInput = (rec.tool_input as { command?: string } | undefined) ?? {}
  const command = toolInput.command ?? ""
  return isShellTool(toolName) && GIT_COMMIT_RE.test(command)
}

async function hasAllTasksCompleteTrigger(
  store: ReturnType<typeof getAutoSteerStore>,
  safeSession: string,
  sessionId: string
): Promise<boolean> {
  if (!store.hasPending(safeSession, "after_all_tasks_complete")) return false
  const tasks = await readSessionTasks(sessionId)
  return (
    tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "cancelled")
  )
}

async function getTriggersToDeliver(
  store: ReturnType<typeof getAutoSteerStore>,
  safeSession: string,
  sessionId: string,
  rec: Record<string, any>
): Promise<AutoSteerTrigger[]> {
  const triggers: AutoSteerTrigger[] = []

  // When the MCP channel drain loop is live for this project, it owns
  // `next_turn` delivery — skip the AppleScript path so both consumers don't
  // race for the same queue row.
  const cwd = (rec.cwd as string) ?? ""
  const mcpLive = isMcpChannelLiveForCwd(cwd)

  if (!mcpLive && store.hasPending(safeSession, "next_turn")) {
    triggers.push("next_turn")
  }

  if (hasCommitTrigger(store, safeSession, rec)) {
    triggers.push("after_commit")
  }

  if (await hasAllTasksCompleteTrigger(store, safeSession, sessionId)) {
    triggers.push("after_all_tasks_complete")
  }

  return triggers
}

async function deliverTriggers(
  store: ReturnType<typeof getAutoSteerStore>,
  safeSession: string,
  sessionId: string,
  triggersToDeliver: AutoSteerTrigger[],
  terminal: { app: TerminalApp; name: string } | undefined
) {
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
}

export async function evaluatePosttooluseAutoSteer(input: unknown): Promise<SwizHookOutput> {
  if (!input || typeof input !== "object") return {}
  const rec = input as Record<string, any>

  const sessionId = (rec.session_id as string) ?? ""
  if (!sessionId) return {}

  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return {}

  const store = getAutoSteerStore()
  const triggersToDeliver = await getTriggersToDeliver(store, safeSession, sessionId, rec)

  if (triggersToDeliver.length === 0) return {}
  if (await shouldDeferAutoSteerForForegroundChatApp()) return {}

  const terminal = rec._terminal as { app: TerminalApp; name: string } | undefined
  await deliverTriggers(store, safeSession, sessionId, triggersToDeliver, terminal)

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
