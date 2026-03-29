/**
 * Foreground app detection and auto-steer deferral logic.
 * Prevents auto-steer from interrupting the user when a chat app is focused.
 *
 * Extracted from auto-steer-helpers.ts for single-responsibility separation.
 */

/**
 * True when the given System Events frontmost process name is a chat app we should
 * not interrupt by activating the terminal (WhatsApp, Telegram, variants).
 */
export function isAutoSteerDeferredForForegroundAppName(name: string): boolean {
  const t = name.trim().toLowerCase()
  return t.startsWith("whatsapp") || t.startsWith("telegram")
}

/**
 * True when the user is currently focused on a chat app; scheduled auto-steer should
 * not consume the request (retry on a later PostToolUse).
 */
export async function shouldDeferAutoSteerForForegroundChatApp(): Promise<boolean> {
  const { createScript, runScript } = await import("applescript-node")
  const script = createScript()
    .tell("System Events")
    .raw("return name of first application process whose frontmost is true")
    .end()
  try {
    const result = await runScript(script)
    const out = result.success && typeof result.output === "string" ? result.output.trim() : ""
    return isAutoSteerDeferredForForegroundAppName(out)
  } catch {
    return false
  }
}
