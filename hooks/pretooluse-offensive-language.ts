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
  findLazyPattern,
  formatDenialMessage,
  readTranscriptLines,
} from "./offensive-language-patterns.ts"
import { toolHookInputSchema } from "./schemas.ts"
import { allowPreToolUse, denyPreToolUse } from "./utils/hook-utils.ts"

async function main() {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const transcriptPath = input.transcript_path ?? ""

  if (!transcriptPath) process.exit(0)

  const lines = await readTranscriptLines(transcriptPath)
  if (lines.length === 0) process.exit(0)

  const assistantText = extractLastAssistantText(lines)
  if (!assistantText) process.exit(0)

  const match = findLazyPattern(assistantText)
  if (match) {
    denyPreToolUse(
      formatDenialMessage(
        match,
        "This hook scans your most recent message and will keep blocking until " +
          "your next message demonstrates corrected behavior through action, not words."
      )
    )
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
