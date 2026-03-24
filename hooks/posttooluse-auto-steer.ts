#!/usr/bin/env bun
/**
 * PostToolUse hook: auto-steer — types a steering prompt into the active terminal
 * when a request has been scheduled by another hook via `scheduleAutoSteer()`.
 *
 * Consumes scheduled requests from the sentinel file and sends them via AppleScript.
 * This is an async fire-and-forget hook — it does not block tool execution.
 *
 * Terminal detection is injected into the payload by src/commands/dispatch.ts
 * (the CLI process has the terminal env vars; the daemon does not).
 */

import { sanitizeSessionId } from "../src/session-id.ts"
import { autoSteerRequestPath } from "../src/temp-paths.ts"
import {
  consumeAutoSteerRequest,
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
if (!(await Bun.file(autoSteerRequestPath(safeSession)).exists())) process.exit(0)
if (await shouldDeferAutoSteerForForegroundChatApp()) process.exit(0)

const request = await consumeAutoSteerRequest(sessionId)
if (!request) process.exit(0)

// Prefer terminal info from payload (injected by CLI dispatch for daemon compatibility),
// fall back to direct env detection (local execution without daemon).
const terminal = input._terminal as { app: TerminalApp; name: string } | undefined
const app = terminal?.app ?? detectTerminal().app

await sendAutoSteer(request.message, app, { requeueOnForegroundDeferSessionId: sessionId })
