/**
 * Auto-steer scheduling and terminal control helpers.
 * Manages steering messages sent to the terminal via AppleScript.
 *
 * Extracted from hook-utils.ts (issue #422).
 */

import {
  isAutoSteerDeferredForForegroundAppName,
  shouldDeferAutoSteerForForegroundChatApp,
} from "./auto-steer-foreground.ts"

export { isAutoSteerDeferredForForegroundAppName, shouldDeferAutoSteerForForegroundChatApp }

type Trigger = import("../auto-steer-store.ts").AutoSteerTrigger

export interface AutoSteerRequest {
  message: string
  timestamp: number
  trigger?: Trigger
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
  if (!AUTOSTEER_SUPPORTED_TERMINALS.has(terminal.app)) {
    return { terminalApp: null, settingsAutoSteer: false }
  }
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  return { terminalApp: terminal.app, settingsAutoSteer: settings.autoSteer }
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
 * Returns true if the request was scheduled, false if auto-steer is disabled
 * or the terminal doesn't support AppleScript. Callers should fall back to
 * their normal deny/block behavior when this returns false.
 */
export async function scheduleAutoSteer(
  sessionId: string,
  message = "Continue",
  trigger?: Trigger,
  cwd?: string
): Promise<boolean> {
  const { terminalApp, settingsAutoSteer } = await checkAutoSteerEligibility(sessionId)
  if (!terminalApp || !settingsAutoSteer) return false

  const safeSession = await sanitizeSessionOrReturnNull(sessionId)
  if (!safeSession) return false

  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  store.enqueue(safeSession, message, trigger ?? "next_turn", { cwd })
  return true
}

/**
 * Check whether an auto-steer request is pending for this session.
 * Atomically consumes the request — returns the steering message if pending, null otherwise.
 */
export async function consumeAutoSteerRequest(
  sessionId: string,
  trigger?: Trigger
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
