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

const posttooluseTimeContext: SwizHook = {
  name: "posttooluse-time-context",
  event: "postToolUse",
  timeout: 1,

  run() {
    return evaluatePosttooluseTimeContext()
  },
}

export default posttooluseTimeContext

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTimeContext)
}
