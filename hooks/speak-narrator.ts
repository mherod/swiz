#!/usr/bin/env bun

/**
 * Incremental TTS narrator — speaks only new assistant text since last call.
 * Shared by PostToolUse, Stop, SessionStart, PreCompact, UserPromptSubmit, and PreToolUse.
 * Tracks spoken position per session in /tmp/speak-pos-<session>.txt.
 * Uses PID-aware file locking with heartbeats to prevent stale locks.
 *
 * Dual-mode: SwizHook (async fire-and-forget) + runSwizHookAsMain for subprocess.
 */

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { narrateSession } from "../src/speech.ts"

export async function evaluateSpeakNarrator(input: unknown): Promise<SwizHookOutput> {
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

const speakNarrator: SwizHook<Record<string, any>> = {
  name: "speak-narrator",
  event: "postToolUse",
  timeout: 30,
  async: true,

  async run(input) {
    return await evaluateSpeakNarrator(input)
  },
}

export default speakNarrator

if (import.meta.main) {
  await runSwizHookAsMain(speakNarrator)
}
