#!/usr/bin/env bun
/**
 * Notification hook: speak — uses the TTS narrator to speak incoming notifications.
 *
 * Triggered by the daemon when new assistant text is detected in transcripts
 * for projects with `speak` enabled.
 */

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"

export function evaluateNotificationSpeak(input: unknown): SwizHookOutput {
  if (!input || typeof input !== "object") return {}
  const rec = input as Record<string, any>

  if (rec.type !== "assistant_message" || !rec.message) return {}

  const settings = rec._effectiveSettings as Record<string, any> | undefined
  const voice = settings?.["narrator-voice"] as string | undefined
  const speed = settings?.["narrator-speed"] as number | undefined

  const cmd = ["bun", "hooks/speak.ts"]
  if (voice) cmd.push("--voice", voice)
  if (speed) cmd.push("--speed", String(speed))
  cmd.push(rec.message)

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
