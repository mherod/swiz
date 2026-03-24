#!/usr/bin/env bun

/**
 * PreToolUse hook: scans the last assistant message for lazy behavior patterns.
 *
 * All detection logic (patterns, scanning, formatting) lives in
 * offensive-language-patterns.ts. This file is a thin shell that reads the
 * transcript, runs detection, and calls denyPreToolUse/allowPreToolUse.
 */

import {
  extractLastAssistantText,
  findAllLazyPatterns,
  formatAllDenialMessages,
  readTranscriptLines,
} from "./offensive-language-patterns.ts"
import { toolHookInputSchema } from "./schemas.ts"
import { allowPreToolUse, denyPreToolUse, scheduleAutoSteer } from "./utils/hook-utils.ts"

async function main() {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const transcriptPath = input.transcript_path ?? ""

  if (!transcriptPath) process.exit(0)

  const lines = await readTranscriptLines(transcriptPath)
  if (lines.length === 0) process.exit(0)

  const assistantText = extractLastAssistantText(lines)
  if (!assistantText) process.exit(0)

  const matches = findAllLazyPatterns(assistantText)
  if (matches.length > 0) {
    const reason = formatAllDenialMessages(
      matches,
      "This hook scans your most recent message and will keep blocking until " +
        "your next message demonstrates corrected behavior through action, not words."
    )
    const sessionId = (input.session_id as string) ?? ""
    // If auto-steer is available, allow the call and let the steering prompt guide correction.
    // If not, deny as usual — the agent gets the reason in the denial response.
    if (sessionId && (await scheduleAutoSteer(sessionId, reason))) {
      allowPreToolUse(reason)
    }
    denyPreToolUse(reason)
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
