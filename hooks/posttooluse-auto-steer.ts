#!/usr/bin/env bun
/**
 * PostToolUse hook: auto-steer — types a steering prompt into the active terminal
 * when a request has been scheduled by another hook via `scheduleAutoSteer()`.
 *
 * The message comes from the scheduling hook — it carries the actual advisory context
 * or action directive, not just "Continue". This gives the agent actionable steering.
 *
 * Supports both iTerm2 (write text) and Terminal.app (do script).
 * This is an async fire-and-forget hook — it does not block tool execution.
 * Requires Automation permissions granted in System Settings.
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
const request = await consumeAutoSteerRequest(sessionId)
if (!request) process.exit(0)

// Escape the message for AppleScript string embedding
const escaped = request.message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")

// Prefer terminal info from payload (injected by CLI dispatch for daemon compatibility),
// fall back to direct env detection (local execution without daemon).
const terminal = input._terminal as { app: TerminalApp; name: string } | undefined
const app: TerminalApp = terminal?.app ?? detectTerminal().app

if (app === "iterm2") {
  const script = createScript()
    .tell("iTerm")
    .tellTarget("current session of current window")
    .raw(`write text "${escaped}"`)
    .end()
    .end()
  await runScript(script).catch(() => {})
} else if (app === "apple-terminal") {
  const script = createScript().tell("Terminal").raw(`do script "${escaped}" in front window`).end()
  await runScript(script).catch(() => {})
}
// Other terminals (Ghostty, Warp, etc.) — no AppleScript support; silently skip
