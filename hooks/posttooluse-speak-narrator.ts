#!/usr/bin/env bun
/**
 * Incremental TTS narrator — speaks only new assistant text since last call.
 * Shared by PostToolUse, Stop, SessionStart, PreCompact, UserPromptSubmit, and PreToolUse.
 * Tracks spoken position per session in /tmp/speak-pos-<session>.txt.
 * Uses PID-aware file locking with heartbeats to prevent stale locks.
 *
 * Dual-mode: SwizHook (async fire-and-forget) + runSwizHookAsMain for subprocess.
 */

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { narrateSession } from "../src/speech.ts"

export async function evaluatePosttooluseSpeakNarrator(input: unknown): Promise<SwizHookOutput> {
  if (!input || typeof input !== "object") return {}

  const record = input as Record<string, any>
  const transcriptPath: string = (record.transcript_path as string) ?? ""
  const sessionId: string = (record.session_id as string) ?? ""
  const message: string | undefined = record.message as string | undefined

  await narrateSession({
    sessionId,
    transcriptPath,
    message,
    cooldownSeconds: 0, // In-session narration is already discrete; always attempt
  })

  return {}
}

const posttooluseSpeakNarrator: SwizHook<Record<string, any>> = {
  name: "posttooluse-speak-narrator",
  event: "postToolUse",
  timeout: 30,
  async: true,

  async run(input) {
    return await evaluatePosttooluseSpeakNarrator(input)
  },
}

export default posttooluseSpeakNarrator

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseSpeakNarrator)
}
