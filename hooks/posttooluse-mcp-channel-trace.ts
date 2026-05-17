#!/usr/bin/env bun

/**
 * PostToolUse hook: inject a compact MCP channel / auto-steer transport trace.
 *
 * This is intentionally advisory context. It gives the next model turn enough
 * detail to understand why auto-steer will use AppleScript, MCP channel, or no
 * transport without forcing another shell probe.
 */

import { detectCurrentAgentFromHookPayload } from "../src/agent-paths.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import {
  getMcpChannelAvailability,
  isAppleScriptTerminalApp,
} from "../src/utils/auto-steer-helpers.ts"
import { detectTerminal, type TerminalApp } from "../src/utils/terminal-detection.ts"

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return "missing"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function injectedTerminalApp(raw: Record<string, unknown>): TerminalApp {
  const terminal = raw._terminal
  if (terminal && typeof terminal === "object" && !Array.isArray(terminal)) {
    const app = (terminal as Record<string, unknown>).app
    if (typeof app === "string") return app as TerminalApp
  }
  return detectTerminal().app
}

function formatTraceValue(value: string): string {
  return value.trim().replace(/\s+/g, "-") || "unknown"
}

function agentNameForTrace(raw: Record<string, unknown>): string {
  return formatTraceValue(detectCurrentAgentFromHookPayload(raw)?.name ?? "unknown")
}

export function buildMcpChannelTrace(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const parsed = toolHookInputSchema.parse(raw)
  const cwd = parsed.cwd
  const availability = getMcpChannelAvailability(cwd)
  const terminalApp = injectedTerminalApp(raw)
  const transport = isAppleScriptTerminalApp(terminalApp)
    ? "applescript"
    : availability.available
      ? "mcp-channel"
      : "unavailable"
  const status = availability.status
  const parts = [
    "[swiz context trace]",
    `agent=${agentNameForTrace(raw)}`,
    `tool=${parsed.tool_name ?? "unknown"}`,
    `transport=${transport}`,
    `terminal=${terminalApp}`,
    `channel=${availability.available ? "available" : "unavailable"}`,
    `reason=${availability.reason}`,
    `heartbeatAge=${formatAge(availability.heartbeatAgeMs)}`,
    `statusAge=${formatAge(availability.statusAgeMs)}`,
  ]
  if (status) {
    parts.push(
      `connected=${status.connected}`,
      `watcher=${status.watcherState}`,
      `delivered=${status.deliveredCount}`,
      `lastDrainAge=${formatAge(
        status.lastDrainCompletedAt ? Date.now() - status.lastDrainCompletedAt : undefined
      )}`
    )
  }
  return parts.join(" ")
}

export function evaluatePosttooluseMcpChannelTrace(input: unknown): SwizHookOutput {
  const trace = buildMcpChannelTrace(input)
  return trace ? buildContextHookOutput("PostToolUse", trace) : {}
}

const posttooluseMcpChannelTrace: SwizHook<Record<string, unknown>> = {
  name: "posttooluse-mcp-channel-trace",
  event: "postToolUse",
  timeout: 2,
  run(input) {
    return evaluatePosttooluseMcpChannelTrace(input)
  },
}

export default posttooluseMcpChannelTrace

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseMcpChannelTrace)
}
