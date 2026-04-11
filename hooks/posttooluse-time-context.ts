#!/usr/bin/env bun

/**
 * PostToolUse hook: inject the current time after every tool use.
 *
 * This gives the agent a consistent wall-clock reference in the merged
 * additionalContext stream without depending on any specific tool matcher.
 */

import { format } from "date-fns"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { scheduleAutoSteerViaChannel } from "../src/utils/auto-steer-helpers.ts"

function describeTimeOfDay(date: Date): string {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return "morning ☀️"
  if (hour >= 12 && hour < 17) return "afternoon 🌤️"
  if (hour >= 17 && hour < 20) return "evening 🌆"
  return "night 🌙"
}

function moonPhaseEmoji(date: Date): string {
  const cycleDays = 29.53058867
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14)
  const daysSince = (date.getTime() - knownNewMoon) / 86_400_000
  const age = ((daysSince % cycleDays) + cycleDays) % cycleDays
  const phaseIndex = Math.floor((age / cycleDays) * 8) % 8
  const phases = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"] as const
  return phases[phaseIndex] ?? phases[0]
}

export function buildCurrentTimeContext(now = new Date()): string {
  const prettyTime = format(now, "PPpp")
  const descriptor = describeTimeOfDay(now)
  const moon = moonPhaseEmoji(now)
  return `Current time: ${prettyTime} — ${descriptor} — Moon ${moon}`
}

export function evaluatePosttooluseTimeContext(now = new Date()): SwizHookOutput {
  return buildContextHookOutput("PostToolUse", buildCurrentTimeContext(now))
}

/**
 * Fire-and-forget auto-steer of the time message, in addition to emitting it
 * as inline context. Uses `scheduleAutoSteerViaChannel` so the enqueue happens
 * regardless of terminal support — the `swiz mcp` drain loop delivers the
 * message as a `<channel source="swiz">` event on the next poll, giving a
 * steady visible stream of channel traffic for operators verifying the MCP
 * transport is live. Requires `cwd` (used as the project key for channel
 * delivery); skipped when absent.
 */
async function scheduleTimeAutoSteer(
  sessionId: string,
  cwd: string | undefined,
  message: string
): Promise<void> {
  if (!sessionId || !cwd) return
  try {
    await scheduleAutoSteerViaChannel(sessionId, message, cwd)
  } catch {
    // scheduling is cosmetic — never let it break the hook
  }
}

const posttooluseTimeContext: SwizHook<Record<string, any>> = {
  name: "posttooluse-time-context",
  event: "postToolUse",
  timeout: 1,

  async run(input) {
    const rec = (input ?? {}) as Record<string, any>
    const sessionId = typeof rec.session_id === "string" ? rec.session_id : ""
    const cwd = typeof rec.cwd === "string" ? rec.cwd : undefined
    const message = buildCurrentTimeContext()
    await scheduleTimeAutoSteer(sessionId, cwd, message)
    return buildContextHookOutput("PostToolUse", message)
  },
}

export default posttooluseTimeContext

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTimeContext)
}
