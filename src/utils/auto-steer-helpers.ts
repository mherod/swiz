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

export interface AutoSteerRequest {
  message: string
  timestamp: number
  trigger?: import("../auto-steer-store.ts").AutoSteerTrigger
}

const AUTOSTEER_SUPPORTED_TERMINALS = new Set(["iterm2", "apple-terminal"])

type AutoSteerTerminalKind = "iterm2" | "apple-terminal"

type CreateScript = typeof import("applescript-node").createScript

type RunScript = typeof import("applescript-node").runScript

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

/**
 * Check whether auto-steer is available (setting enabled + supported terminal).
 * Returns the detected terminal app if available, null otherwise.
 */
export async function isAutoSteerAvailable(sessionId: string): Promise<string | null> {
  const { detectTerminal } = await import("./terminal-detection.ts")
  const terminal = detectTerminal()
  if (!AUTOSTEER_SUPPORTED_TERMINALS.has(terminal.app)) return null
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  if (!settings.autoSteer) return null
  return terminal.app
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
    const app = terminalApp ?? (await import("./terminal-detection.ts")).detectTerminal().app
    if (!AUTOSTEER_SUPPORTED_TERMINALS.has(app)) return false

    const { createScript, runScript } = await import("applescript-node")
    const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")

    // Utility to bring app to front and to frontmost app again
    async function getFrontmostAppName(): Promise<string> {
      const script = createScript()
        .tell("System Events")
        .raw("return name of first application process whose frontmost is true")
        .end()
      const result = await runScript(script)
      const out = result.output
      return typeof out === "string" ? out.trim() : ""
    }

    // Bring target app to front, send message, and optionally restore original frontmost app
    try {
      let targetApp: string
      if (app === "iterm2") {
        targetApp = "iTerm"
      } else if (app === "apple-terminal") {
        targetApp = "Terminal"
      } else {
        return false
      }

      const originalFrontApp = await getFrontmostAppName()
      if (await deferAutoSteerWhenChatForeground(originalFrontApp, message, opts)) return false

      const alreadyFrontmost = originalFrontApp === targetApp

      // Always bring terminal to front before messaging
      await runScript(createScript().tell(targetApp).activate().end())

      await runAutoSteerTerminalScripts(
        app as AutoSteerTerminalKind,
        escaped,
        createScript,
        runScript
      )

      // If we brought terminal to front and it wasn't already, restore previous front app
      if (!alreadyFrontmost && originalFrontApp) {
        // Only switch back if we switched at the start
        await runScript(createScript().tell(originalFrontApp).raw("activate").end())
      }

      return true
    } catch {
      return false
    }
  })
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
  trigger?: import("../auto-steer-store.ts").AutoSteerTrigger,
  cwd?: string
): Promise<boolean> {
  // Check terminal support first (cheap, no I/O)
  const { detectTerminal } = await import("./terminal-detection.ts")
  const terminal = detectTerminal()
  if (!AUTOSTEER_SUPPORTED_TERMINALS.has(terminal.app)) return false

  // Check autoSteer setting
  const { getEffectiveSwizSettings, readSwizSettings } = await import("../settings.ts")
  const settings = getEffectiveSwizSettings(await readSwizSettings(), sessionId)
  if (!settings.autoSteer) return false

  const { sanitizeSessionId: sanitize } = await import("../session-id.ts")
  const safeSession = sanitize(sessionId)
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
  trigger?: import("../auto-steer-store.ts").AutoSteerTrigger
): Promise<AutoSteerRequest | null> {
  const { sanitizeSessionId: sanitize } = await import("../session-id.ts")
  const safeSession = sanitize(sessionId)
  if (!safeSession) return null

  const { getAutoSteerStore } = await import("../auto-steer-store.ts")
  const store = getAutoSteerStore()
  const requests = store.consumeOne(safeSession, trigger ?? "next_turn")
  if (requests.length === 0) return null

  const first = requests[0]!
  return { message: first.message, timestamp: first.createdAt }
}
