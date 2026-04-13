#!/usr/bin/env bun

/**
 * PreToolUse hook: scans the last assistant message for lazy behavior patterns.
 *
 * All detection logic (patterns, scanning, formatting) lives in
 * offensive-language-patterns.ts. This file is a thin shell that reads the
 * transcript, runs detection, and schedules a steering auto-steer when lazy
 * phrases are found — the current tool call is never blocked.
 *
 * Delivery is auto-steer-only: the agent receives the rebuttal on the next
 * turn (either through the MCP channel when it is live, or via the
 * AppleScript terminal path). When auto-steer cannot be scheduled (setting
 * off, terminal unsupported), the hook emits nothing and the tool proceeds.
 *
 * When an AI provider is available, generates a refined message that uses
 * transcript context to directly challenge the specific objection — falling
 * back to static messages when no provider exists.
 */

import { z } from "zod"
import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { type RunSwizHookAsMainOptions, runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { extractSessionLines } from "../src/transcript-summary.ts"
import {
  messageFromUnknownError,
  scheduleAutoSteer,
  scheduleAutoSteerViaChannel,
} from "../src/utils/hook-utils.ts"
import {
  CATEGORY_LABELS,
  extractLastAssistantText,
  findAllLazyPatterns,
  formatAllDenialMessages,
  type LazyPattern,
} from "./offensive-language-patterns.ts"

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

// ── Steering suffix shared by refined + static paths ────────────────────────

const STEER_SUFFIX = "Demonstrate corrected behavior through action, not words."

/**
 * Unexpected errors always fail open: the hook is advisory-only and must not
 * block tool calls. The error is logged to stderr for operator visibility.
 */
function unexpectedHookFailureOutput(err: unknown): SwizHookOutput {
  const message = messageFromUnknownError(err)
  process.stderr.write(`pretooluse-offensive-language: unexpected error — ${message}\n`)
  return {}
}

export async function evaluatePretooluseOffensiveLanguage(
  raw: Record<string, any>
): Promise<SwizHookOutput> {
  const input = toolHookInputSchema.parse(raw)
  const transcriptPath = input.transcript_path ?? ""

  if (!transcriptPath) return {}

  // Use session-scoped lines from dispatch payload if available, else extract from file
  let lines: string[] = []
  const transcriptSummary = input._transcriptSummary as Record<string, any> | undefined
  if (transcriptSummary?.sessionLines && Array.isArray(transcriptSummary.sessionLines)) {
    lines = transcriptSummary.sessionLines
  } else {
    // Fallback: read full transcript and extract session-scoped lines
    const fullText = await Bun.file(transcriptPath).text()
    lines = extractSessionLines(fullText)
  }

  if (lines.length === 0) return {}

  const assistantText = extractLastAssistantText(lines)
  if (!assistantText) return {}

  const matches = findAllLazyPatterns(assistantText)
  if (matches.length === 0) return {}

  const sessionId = (input.session_id as string) ?? ""
  if (!sessionId) return {}

  const refined = await tryRefinedFeedback(assistantText, matches)
  const message = refined
    ? `${refined}\n\n${STEER_SUFFIX}`
    : formatAllDenialMessages(matches, STEER_SUFFIX)

  const cwd = (input.cwd as string) ?? ""
  // Prefer MCP channel delivery (works without terminal support).
  // Fall back to terminal-based auto-steer if channel unavailable.
  const delivered = cwd ? await scheduleAutoSteerViaChannel(sessionId, message, cwd) : false
  if (!delivered) {
    const terminalDelivered = await scheduleAutoSteer(
      sessionId,
      message,
      undefined,
      cwd || undefined
    )
    if (!terminalDelivered) {
      process.stderr.write(
        "pretooluse-offensive-language: auto-steer delivery failed (both channel and terminal)\n"
      )
    }
  }
  return {}
}

const pretooluseOffensiveLanguage: SwizToolHook = {
  name: "pretooluse-offensive-language",
  event: "preToolUse",
  timeout: 5,
  cooldownSeconds: 60,

  async run(input) {
    try {
      return await evaluatePretooluseOffensiveLanguage(input as Record<string, any>)
    } catch (err: unknown) {
      return unexpectedHookFailureOutput(err)
    }
  },
}

export default pretooluseOffensiveLanguage

const runAsMainOptions: RunSwizHookAsMainOptions = {
  onStdinJsonError: unexpectedHookFailureOutput,
}

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseOffensiveLanguage, runAsMainOptions)
}
