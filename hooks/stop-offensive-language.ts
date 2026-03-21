#!/usr/bin/env bun

// Stop hook: Block stop when the last assistant message contains lazy behavior
// patterns. Defense-in-depth backstop for pretooluse-offensive-language.ts —
// catches patterns that slipped past the PreToolUse gate (e.g., when the agent
// produced the offending text in its final message before attempting to stop).

import {
  extractLastAssistantText,
  findLazyPattern,
  formatDenialMessage,
  readTranscriptLines,
} from "./offensive-language-patterns.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { blockStop } from "./utils/hook-utils.ts"

async function main() {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const transcriptPath = input.transcript_path ?? ""

  const lines = await readTranscriptLines(transcriptPath)
  if (lines.length === 0) process.exit(0)

  const assistantText = extractLastAssistantText(lines)
  if (!assistantText) process.exit(0)

  const match = findLazyPattern(assistantText)
  if (match) {
    blockStop(
      formatDenialMessage(
        match,
        "This hook detected a lazy behavior pattern in your final message. " +
          "You cannot stop while your last message contains hedging, deferral, " +
          "or other avoidance patterns. Produce a new message that demonstrates " +
          "corrected behavior through action, not words."
      )
    )
  }

  // No match — allow stop
  process.exit(0)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
