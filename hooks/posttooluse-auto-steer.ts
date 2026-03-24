#!/usr/bin/env bun
/**
 * PostToolUse hook: auto-steer — types "Continue" into the active terminal session
 * when a request has been scheduled by another hook via `scheduleAutoSteer()`.
 *
 * Supports both iTerm2 (write text) and Terminal.app (do script).
 * This is an async fire-and-forget hook — it does not block tool execution.
 * Requires Automation permissions granted in System Settings.
 *
 * Scheduling flow:
 * 1. Any hook calls `scheduleAutoSteer(sessionId)` to write a sentinel file
 * 2. This hook runs on the next PostToolUse, checks for the sentinel
 * 3. If present, consumes it and types "Continue" into the terminal
 *
 * Terminal detection is injected into the payload by src/commands/dispatch.ts
 * (the CLI process has the terminal env vars; the daemon does not).
 */

import { createScript, runScript } from "applescript-node"
import { consumeAutoSteerRequest } from "./utils/hook-utils.ts"
import type { TerminalApp } from "./utils/terminal-detection.ts"
import { detectTerminal } from "./utils/terminal-detection.ts"

const input = (await Bun.stdin.json().catch(() => null)) as Record<string, unknown> | null
if (!input) process.exit(0)

const sessionId = (input.session_id as string) ?? ""
if (!sessionId) process.exit(0)

// Only fire if another hook has scheduled an auto-steer request
const hasRequest = await consumeAutoSteerRequest(sessionId)
if (!hasRequest) process.exit(0)

// Prefer terminal info from payload (injected by CLI dispatch for daemon compatibility),
// fall back to direct env detection (local execution without daemon).
const terminal = input._terminal as { app: TerminalApp; name: string } | undefined
const app: TerminalApp = terminal?.app ?? detectTerminal().app

if (app === "iterm2") {
  const script = createScript()
    .tell("iTerm")
    .tellTarget("current session of current window")
    .raw('write text "Continue"')
    .end()
    .end()
  await runScript(script).catch(() => {})
} else if (app === "apple-terminal") {
  const script = createScript().tell("Terminal").raw('do script "Continue" in front window').end()
  await runScript(script).catch(() => {})
}
// Other terminals (Ghostty, Warp, etc.) — no AppleScript support; silently skip
