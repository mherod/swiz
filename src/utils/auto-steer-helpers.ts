/**
 * Auto-steer scheduling and terminal control helpers.
 * Manages steering messages sent to the terminal via AppleScript.
 *
 * Extracted from hook-utils.ts (issue #422).
 */

import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { z } from "zod"
import type { AutoSteerTrigger } from "../auto-steer-store.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import {
  SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS,
  swizMcpChannelHeartbeatPath,
  swizMcpChannelNotifyPath,
  swizMcpChannelStatusPath,
} from "../temp-paths.ts"
import { isAutoSteerDeferredForForegroundAppName } from "./auto-steer-foreground.ts"

/**
 * Touch the MCP channel notify sentinel so the `swiz mcp` drain loop wakes
 * up immediately instead of waiting for its poll interval. Advisory — failure
 * to touch the file is swallowed because the drain loop still polls as a
 * safety fallback.
 */
function touchMcpChannelNotify(cwd: string): void {
  const path = swizMcpChannelNotifyPath(projectKeyFromCwd(cwd))
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    try {
      writeFileSync(path, "")
    } catch {
      // swallow — notify is advisory
    }
  }
}

const MCP_CHANNEL_TRIGGERS = new Set<AutoSteerTrigger>([
  "next_turn",
  "after_commit",
  "after_all_tasks_complete",
])

export type McpChannelWatcherState = "starting" | "active" | "error" | "unavailable" | "closed"

export interface McpChannelStatusSnapshot {
  projectKey: string
  cwd: string
  pid: number
  serverName: string
  serverVersion: string
  connected: boolean
  watcherState: McpChannelWatcherState
  startedAt: number
  updatedAt: number
  lastDrainStartedAt?: number
  lastDrainCompletedAt?: number
  lastDrainError?: string
  deliveredCount: number
}

const mcpChannelStatusSchema = z.object({
  projectKey: z.string(),
  cwd: z.string(),
  pid: z.number(),
  serverName: z.string(),
  serverVersion: z.string(),
  connected: z.boolean(),
  watcherState: z.enum(["starting", "active", "error", "unavailable", "closed"]),
  startedAt: z.number(),
  updatedAt: z.number(),
  lastDrainStartedAt: z.number().optional(),
  lastDrainCompletedAt: z.number().optional(),
  lastDrainError: z.string().optional(),
  deliveredCount: z.number(),
})

export type McpChannelAvailabilityReason =
  | "available"
  | "cwd-missing"
  | "heartbeat-missing"
  | "heartbeat-stale"
  | "status-missing"
  | "status-invalid"
  | "status-stale"
  | "server-disconnected"

export interface McpChannelAvailability {
  available: boolean
  reason: McpChannelAvailabilityReason
  projectKey?: string
  heartbeatAgeMs?: number
  statusAgeMs?: number
  status?: McpChannelStatusSnapshot
}

function ageMs(path: string, now: number): number | null {
  try {
    return Math.max(0, now - statSync(path).mtimeMs)
  } catch {
    return null
  }
}

function parseMcpChannelStatus(raw: string): McpChannelStatusSnapshot | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = mcpChannelStatusSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function getMcpChannelAvailability(
  cwd: string | undefined,
  now: number = Date.now()
): McpChannelAvailability {
  if (!cwd) return { available: false, reason: "cwd-missing" }
  const projectKey = projectKeyFromCwd(cwd)
  const heartbeatAgeMs = ageMs(swizMcpChannelHeartbeatPath(projectKey), now)
  if (heartbeatAgeMs === null) {
    return { available: false, reason: "heartbeat-missing", projectKey }
  }
  if (heartbeatAgeMs > SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS) {
    return { available: false, reason: "heartbeat-stale", projectKey, heartbeatAgeMs }
  }

  const statusPath = swizMcpChannelStatusPath(projectKey)
  const statusAgeMs = ageMs(statusPath, now)
  if (statusAgeMs === null) {
    return { available: false, reason: "status-missing", projectKey, heartbeatAgeMs }
  }
  if (statusAgeMs > SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS) {
    return {
      available: false,
      reason: "status-stale",
      projectKey,
      heartbeatAgeMs,
      statusAgeMs,
    }
  }

  const status = parseMcpChannelStatus(readFileSync(statusPath, "utf8"))
  if (!status) {
    return { available: false, reason: "status-invalid", projectKey, heartbeatAgeMs, statusAgeMs }
  }
  if (!status.connected) {
    return {
      available: false,
      reason: "server-disconnected",
      projectKey,
      heartbeatAgeMs,
      statusAgeMs,
      status,
    }
  }

  return {
    available: true,
    reason: "available",
    projectKey,
    heartbeatAgeMs,
    statusAgeMs,
    status,
  }
}

export function isMcpChannelLiveForCwd(cwd: string): boolean {
  return getMcpChannelAvailability(cwd).available
}

export interface AutoSteerRequest {
  message: string
  timestamp: number
  trigger?: AutoSteerTrigger
}

/** Hard cap on how long humanisation may block a hook before falling back to the raw text. */
const HUMANISE_TIMEOUT_MS = 8_000

const HUMANISE_SYSTEM_PROMPT = [
  "You rewrite terse, machine-generated coding-agent steering notes into a short, natural paragraph.",
  "Keep the rewrite to one paragraph in a calm, collegial human voice, as if a teammate left the nudge.",
  "Preserve every concrete instruction, file path, command, and constraint exactly.",
  "Do not add new instructions, headings, bullet points, quotes, or commentary about the rewrite.",
  "Return only the rewritten paragraph.",
].join(" ")

/**
 * Rewrite a steering message into a humanised, single paragraph via the AI provider layer.
 *
 * Always uses the OpenRouter provider: its fast hosted models keep the rewrite
 * well under {@link HUMANISE_TIMEOUT_MS}, unlike the local Claude CLI which can
 * block the calling hook for 6-13s and ignore the timeout.
 *
 * Fail-open: when OpenRouter is unavailable, the call errors, or it exceeds the
 * timeout, the original message is returned unchanged so scheduling never
 * depends on the model being reachable.
 */
export async function humaniseAutoSteerMessage(message: string): Promise<string> {
  const trimmed = message.trim()
  if (!trimmed) return message

  try {
    const { promptText } = await import("../ai-providers.ts")
    const prompt = `${HUMANISE_SYSTEM_PROMPT}\n\nSteering note to rewrite:\n${trimmed}`
    const rewritten = (
      await promptText(prompt, { provider: "openrouter", timeout: HUMANISE_TIMEOUT_MS })
    ).trim()
    return rewritten || message
  } catch {
    return message
  }
}

const AUTOSTEER_SUPPORTED_TERMINALS = new Set(["iterm2", "apple-terminal"])

type AutoSteerTerminalKind = "iterm2" | "apple-terminal"

type CreateScript = typeof import("applescript-node").createScript

type RunScript = typeof import("applescript-node").runScript

/** Maps canonical terminal IDs to their macOS application names for AppleScript. */
const TERMINAL_APP_NAME: Record<AutoSteerTerminalKind, string> = {
  iterm2: "iTerm",
  "apple-terminal": "Terminal",
}

/** Escape a message for safe embedding in an AppleScript string literal. */
function escapeForAppleScript(message: string): string {
  return message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

/** Sanitize a session ID, returning null if empty. Eliminates repeated import + check. */
async function sanitizeSessionOrReturnNull(sessionId: string): Promise<string | null> {
  const { sanitizeSessionId } = await import("../session-id.ts")
  return sanitizeSessionId(sessionId)
}

/** Build an AppleScript that returns the frontmost application name. */
function getFrontmostAppNameScript(createScript: CreateScript) {
  return createScript()
    .tell("System Events")
    .raw("return name of first application process whose frontmost is true")
    .end()
}

/** Retrieve the frontmost application name via AppleScript. */
async function getFrontmostAppName(
  createScript: CreateScript,
  runScript: RunScript
): Promise<string> {
  const script = getFrontmostAppNameScript(createScript)
  const result = await runScript(script)
  const out = result.output
  return typeof out === "string" ? out.trim() : ""
}

async function runAutoSteerTerminalScripts(
  kind: AutoSteerTerminalKind,
  escaped: string,
  createScript: CreateScript,
  runScript: RunScript
): Promise<void> {
  if (kind === "iterm2") {
    const script = createScript()
      .tell("iTerm")
      .tellTarget("current session of current window")
      .raw(`write text "${escaped}" newline no`)
      .raw(`write text ""`)
      .delay(0.1)
      .raw(`write text ""`)
      .end()
      .end()
    await runScript(script)
    return
  }

  const typeScript = createScript()
    .tell("System Events")
    .tellTarget('process "Terminal"')
    .keystroke(escaped)
    .raw(`keystroke return`)
    .delay(0.1)
    .raw(`keystroke return`)
    .end()
    .end()
  await runScript(typeScript)
}

interface AutoSteerEligibility {
  terminalApp: string | null
  settingsAutoSteer: boolean
}

/** Check terminal support and settings. Shared by isAutoSteerAvailable and scheduleAutoSteer. */
async function checkAutoSteerEligibility(sessionId: string): Promise<AutoSteerEligibility> {
  const { detectTerminal } = await import("./terminal-detection.ts")
  const terminal = detectTerminal()
  const settingsAutoSteer = await isAutoSteerSettingEnabled(sessionId)
  if (!AUTOSTEER_SUPPORTED_TERMINALS.has(terminal.app)) {
    return { terminalApp: null, settingsAutoSteer }
  }
  return { terminalApp: terminal.app, settingsAutoSteer }
}

async function isAutoSteerSettingEnabled(sessionId: string): Promise<boolean> {
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  return settings.autoSteer
}

async function isMcpChannelsSettingEnabled(sessionId: string): Promise<boolean> {
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  return settings.mcpChannels
}

function canUseMcpChannel(trigger: AutoSteerTrigger, cwd: string | undefined): cwd is string {
  return !!cwd && MCP_CHANNEL_TRIGGERS.has(trigger) && isMcpChannelLiveForCwd(cwd)
}

export function isAppleScriptTerminalApp(app: string | null | undefined): boolean {
  return !!app && AUTOSTEER_SUPPORTED_TERMINALS.has(app)
}

/**
 * Check whether auto-steer is available (setting enabled + supported terminal).
 * Returns the detected terminal app if available, null otherwise.
 */
export async function isAutoSteerAvailable(sessionId: string): Promise<string | null> {
  const { terminalApp, settingsAutoSteer } = await checkAutoSteerEligibility(sessionId)
  if (!terminalApp || !settingsAutoSteer) return null
  return terminalApp
}

export type SendAutoSteerOptions = {
  /** If the user focuses a chat app before send, re-schedule this session's request (PostToolUse path). */
  requeueOnForegroundDeferSessionId?: string
}

let autoSteerMutex: Promise<void> = Promise.resolve()

async function withAutoSteerMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = autoSteerMutex
  let release!: () => void
  autoSteerMutex = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

async function deferAutoSteerWhenChatForeground(
  originalFrontApp: string,
  message: string,
  opts?: SendAutoSteerOptions
): Promise<boolean> {
  if (!isAutoSteerDeferredForForegroundAppName(originalFrontApp)) return false
  const sid = opts?.requeueOnForegroundDeferSessionId
  if (sid) await scheduleAutoSteer(sid, message)
  return true
}

/**
 * Send a steering message directly to the terminal via AppleScript.
 * Use this for immediate sends (e.g. stop hooks) where there's no future
 * PostToolUse cycle to consume a scheduled request.
 *
 * Returns true if the message was sent, false if terminal unsupported or send failed.
 */
export async function sendAutoSteer(
  message: string,
  terminalApp?: string | null,
  opts?: SendAutoSteerOptions
): Promise<boolean> {
  return withAutoSteerMutex(async () => {
    const detected = terminalApp ?? (await import("./terminal-detection.ts")).detectTerminal().app
    if (!AUTOSTEER_SUPPORTED_TERMINALS.has(detected)) return false

    const { createScript, runScript } = await import("applescript-node")
    const escaped = escapeForAppleScript(message)
    const targetApp = TERMINAL_APP_NAME[detected as AutoSteerTerminalKind]

    const originalFrontApp = await getFrontmostAppName(createScript, runScript)
    if (await deferAutoSteerWhenChatForeground(originalFrontApp, message, opts)) return false

    const alreadyFrontmost = originalFrontApp === targetApp

    // Always bring terminal to front before messaging
    await runScript(createScript().tell(targetApp).activate().end())

    await runAutoSteerTerminalScripts(
      detected as AutoSteerTerminalKind,
      escaped,
      createScript,
      runScript
    )

    // Restore previous front app if we activated the terminal
    if (!alreadyFrontmost && originalFrontApp) {
      await runScript(createScript().tell(originalFrontApp).raw("activate").end())
    }

    return true
  }).catch(() => false)
}

/**
 * Schedule an auto-steer input with a steering prompt message.
 * The message will be typed into the terminal on the next PostToolUse cycle,
 * giving the agent actionable context (not just "Continue").
 *
 * Returns true if the request was scheduled. AppleScript-capable terminals are
 * preferred because the MCP channel is advisory and may drop notifications.
 * The MCP channel is used only when no AppleScript transport is available.
 */
export async function scheduleAutoSteer(
  sessionId: string,
  message = "Continue",
  trigger?: AutoSteerTrigger,
  cwd?: string
): Promise<boolean> {
  const safeSession = await sanitizeSessionOrReturnNull(sessionId)
  if (!safeSession) return false

  const resolvedTrigger = trigger ?? "next_turn"
  const { terminalApp, settingsAutoSteer } = await checkAutoSteerEligibility(sessionId)
  if (!settingsAutoSteer) return false

  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  if (terminalApp) {
    const humanised = await humaniseAutoSteerMessage(message)
    store.enqueue(safeSession, humanised, resolvedTrigger, { dedupKey: message })
    return true
  }

  if (!(await isMcpChannelsSettingEnabled(sessionId))) return false
  if (!canUseMcpChannel(resolvedTrigger, cwd)) return false

  const humanised = await humaniseAutoSteerMessage(message)
  const enqueued = store.enqueue(safeSession, humanised, resolvedTrigger, {
    cwd,
    dedupKey: message,
  })
  if (enqueued) touchMcpChannelNotify(cwd)
  return true
}

/**
 * Schedule an auto-steer targeted at the MCP channel path.
 *
 * Unlike `scheduleAutoSteer`, this does NOT require an AppleScript-controllable
 * terminal: delivery happens through the `swiz mcp` stdio server, which drains
 * the SQLite queue by project_key (cwd) and pushes each message to the
 * connected agent as a `<channel source="swiz">` event.
 *
 * Returns true if enqueued, false if the channel is not currently live, the
 * store de-duplicated it, or the session id could not be sanitized. The
 * `autoSteer` setting is still respected, and `mcpChannels` must also be
 * enabled because channel delivery is a transport, not a bypass of policy.
 */
export async function scheduleAutoSteerViaChannel(
  sessionId: string,
  message: string,
  cwd: string,
  trigger: AutoSteerTrigger = "next_turn",
  opts?: { ttlMs?: number }
): Promise<boolean> {
  if (!(await isAutoSteerSettingEnabled(sessionId))) return false
  if (!(await isMcpChannelsSettingEnabled(sessionId))) return false
  if (!canUseMcpChannel(trigger, cwd)) return false

  const safeSession = await sanitizeSessionOrReturnNull(sessionId)
  if (!safeSession) return false

  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  const humanised = await humaniseAutoSteerMessage(message)
  const enqueued = store.enqueue(safeSession, humanised, trigger, {
    cwd,
    ttlMs: opts?.ttlMs,
    dedupKey: message,
  })
  if (enqueued) touchMcpChannelNotify(cwd)
  return enqueued
}

/**
 * Check whether an auto-steer request is pending for this session.
 * Atomically consumes the request — returns the steering message if pending, null otherwise.
 */
export async function consumeAutoSteerRequest(
  sessionId: string,
  trigger?: AutoSteerTrigger
): Promise<AutoSteerRequest | null> {
  const safeSession = await sanitizeSessionOrReturnNull(sessionId)
  if (!safeSession) return null

  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  const requests = store.consumeOne(safeSession, trigger ?? "next_turn")
  if (requests.length === 0) return null

  const first = requests[0]!
  return { message: first.message, timestamp: first.createdAt }
}
