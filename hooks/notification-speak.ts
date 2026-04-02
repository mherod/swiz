#!/usr/bin/env bun

/**
 * Notification hook: speak — uses the TTS narrator to speak incoming notifications.
 *
 * Triggered by the daemon when new assistant text is detected in transcripts
 * for projects with `speak` enabled.
 */

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"

export function summarizeNotification(message: string, limit = 500): string {
  if (!message) return ""

  // 1. Truncate diffs to just a "large diff omitted" message or file list if possible
  let summarized = message.replace(/```diff[\s\S]*?```/g, "[large diff omitted]")

  // 2. Truncate other code blocks
  summarized = summarized.replace(/```[\s\S]*?```/g, "[code block omitted]")

  // 3. Normalize whitespace
  summarized = summarized.replace(/\s+/g, " ").trim()

  // 4. Hard character limit
  if (summarized.length > limit) {
    summarized = `${summarized.substring(0, limit)}...`
  }

  return summarized
}

export function evaluateNotificationSpeak(input: unknown): SwizHookOutput {
  if (!input || typeof input !== "object") return {}
  const rec = input as Record<string, any>

  if (rec.type !== "assistant_message" || !rec.message) return {}

  const settings = rec._effectiveSettings as Record<string, any> | undefined
  const voice = settings?.["narrator-voice"] as string | undefined
  const speed = settings?.["narrator-speed"] as number | undefined

  const spokenMessage = summarizeNotification(rec.message)
  if (!spokenMessage) return {}

  const cmd = ["bun", "hooks/speak.ts"]
  if (voice) cmd.push("--voice", voice)
  if (speed) cmd.push("--speed", String(speed))
  cmd.push(spokenMessage)

  // Fire and forget speech, don't block
  void spawnWithTimeout(cmd, { timeoutMs: 30000 }).catch((err) => {
    console.error(`[notification-speak] failed to spawn speak: ${err}`)
  })

  return {}
}

const notificationSpeak: SwizHook<Record<string, any>> = {
  name: "notification-speak",
  event: "notification",
  timeout: 5,
  async: true,
  requiredSettings: ["speak"],

  run(input) {
    return evaluateNotificationSpeak(input)
  },
}

export default notificationSpeak

if (import.meta.main) {
  await runSwizHookAsMain(notificationSpeak)
}
