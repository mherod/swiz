#!/usr/bin/env bun

// Stop hook: Block stop when the last assistant message contains lazy behavior
// patterns. Defense-in-depth backstop for pretooluse-offensive-language.ts —
// catches patterns that slipped past the PreToolUse gate (e.g., when the agent
// produced the offending text in its final message before attempting to stop).
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { blockStopObj } from "../src/utils/hook-utils.ts"
import {
  extractLastAssistantText,
  findAllLazyPatterns,
  formatAllDenialMessages,
  readTranscriptLines,
} from "./offensive-language-patterns.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

export async function evaluateStopOffensiveLanguage(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const transcriptPath = parsed.transcript_path ?? ""

  const lines = await readTranscriptLines(transcriptPath)
  if (lines.length === 0) return {}

  const assistantText = extractLastAssistantText(lines)
  if (!assistantText) return {}

  const matches = findAllLazyPatterns(assistantText)
  if (matches.length === 0) return {}

  return blockStopObj(
    formatAllDenialMessages(
      matches,
      "Avoidance behavior detected. Produce a corrected message that " +
        "demonstrates action, not words."
    )
  )
}

const stopOffensiveLanguage: SwizStopHook = {
  name: "stop-offensive-language",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopOffensiveLanguage(input)
  },
}

export default stopOffensiveLanguage

if (import.meta.main) {
  await runSwizHookAsMain(stopOffensiveLanguage)
}
