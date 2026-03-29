#!/usr/bin/env bun

/**
 * PreToolUse hook: scans the last assistant message for lazy behavior patterns.
 *
 * All detection logic (patterns, scanning, formatting) lives in
 * offensive-language-patterns.ts. This file is a thin shell that reads the
 * transcript, runs detection, and calls denyPreToolUse/allowPreToolUse.
 *
 * When an AI provider is available, generates a refined denial message that
 * uses transcript context to directly challenge the specific objection —
 * falling back to static messages when no provider exists.
 */

import { z } from "zod"
import { allowPreToolUse, denyPreToolUse, scheduleAutoSteer } from "../src/utils/hook-utils.ts"
import {
  CATEGORY_LABELS,
  extractLastAssistantText,
  findAllLazyPatterns,
  formatAllDenialMessages,
  type LazyPattern,
  readTranscriptLines,
} from "./offensive-language-patterns.ts"
import { toolHookInputSchema } from "./schemas.ts"

// ── AI-refined feedback ──────────────────────────────────────────────────────

const refinedFeedbackSchema = z.object({
  challenge: z
    .string()
    .describe(
      "A direct, pointed rebuttal (2-3 sentences) that names exactly what the assistant said, " +
        "explains why it is avoidance behavior, and states what they must do instead. " +
        "No hedging, no softening."
    ),
})

function buildRefinedPrompt(assistantText: string, matches: LazyPattern[]): string {
  const categories = matches.map((m) => CATEGORY_LABELS[m.category]).join(", ")
  const matchedPhrases = matches.map((m) => {
    const hit = m.pattern.exec(assistantText)
    return hit ? `"${hit[0]}"` : `[${m.category} pattern]`
  })

  return (
    `You are a behavioral enforcement system. The assistant just wrote a message that ` +
    `exhibits avoidance behavior in these categories: ${categories}.\n\n` +
    `Matched phrases: ${matchedPhrases.join(", ")}\n\n` +
    `ASSISTANT'S MESSAGE (excerpt, last 2000 chars):\n` +
    `---\n${assistantText.slice(-2000)}\n---\n\n` +
    `Write a sharp, specific rebuttal that:\n` +
    `1. Quotes or paraphrases the exact avoidance phrase the assistant used\n` +
    `2. Names the evasion tactic (e.g., "hedging", "deferring responsibility", "buying time")\n` +
    `3. States the concrete action the assistant must take instead\n\n` +
    `Do NOT be generic. Do NOT repeat boilerplate. Address THIS specific message.\n` +
    `Reply with a JSON object: { "challenge": "..." }`
  )
}

async function tryRefinedFeedback(
  assistantText: string,
  matches: LazyPattern[]
): Promise<string | null> {
  try {
    const { hasAiProvider, promptObject } = await import("../src/ai-providers.ts")
    if (!hasAiProvider()) return null

    const prompt = buildRefinedPrompt(assistantText, matches)
    const result = await promptObject(prompt, refinedFeedbackSchema, { timeout: 15_000 })
    return result.challenge || null
  } catch {
    return null // Fall back to static messages
  }
}

// ── Suffix shared by both paths ──────────────────────────────────────────────

const BLOCKING_SUFFIX = "Demonstrate corrected behavior through action, not words."

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
    // Try AI-refined feedback; fall back to static messages
    const refined = await tryRefinedFeedback(assistantText, matches)
    const reason = refined
      ? `${refined}\n\n${BLOCKING_SUFFIX}`
      : formatAllDenialMessages(matches, BLOCKING_SUFFIX)

    const sessionId = (input.session_id as string) ?? ""
    // Auto-steer delivers the message — allow silently to avoid duplicate guidance.
    // If auto-steer unavailable, deny as usual.
    if (sessionId && (await scheduleAutoSteer(sessionId, reason, undefined, input.cwd))) {
      allowPreToolUse("")
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
