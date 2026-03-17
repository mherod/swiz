#!/usr/bin/env bun
/**
 * PreToolUse hook: scans the last assistant message for lazy behavior patterns.
 *
 * Detects two categories of bad agent behavior:
 *   1. **Hedging/deferring** — asking permission instead of acting (e.g.
 *      "Would you like me to implement this?", "Shall I proceed?").
 *   2. **Dismissing responsibility** — deflecting issues, warnings, or errors
 *      as "pre-existing" or "unrelated" instead of owning and fixing them.
 *
 * Each pattern category gets a tailored scolding response. The agent must
 * produce a new assistant message (without the lazy pattern) before the hook
 * allows tool calls to proceed — this forces genuine self-correction, not
 * just a blind retry.
 *
 * Reads the transcript from `transcript_path` in the hook input, walks backward
 * to find the most recent assistant message, and checks its text blocks.
 */

import { allowPreToolUse, denyPreToolUse } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

// ── Pattern categories with tailored responses ──────────────────────────────

interface LazyPattern {
  /** RegExp tested against assistant text (case-insensitive). */
  pattern: RegExp
  /** Scolding message returned when the pattern matches. */
  response: string
  /** Category label for grouping in test output. */
  category: "hedging" | "dismissal"
}

export const LAZY_PATTERNS: LazyPattern[] = [
  // ── Hedging / deferring patterns ────────────────────────────────────────
  {
    category: "hedging",
    pattern: /would you like me to\b/i,
    response:
      "Don't ask — just do it. You were given a task; execute it. " +
      "Asking 'Would you like me to…' wastes a round-trip and signals hesitation.",
  },
  {
    category: "hedging",
    pattern:
      /shall i (?:proceed|continue|go ahead|start|begin|implement|make|create|add|fix|update)\b/i,
    response:
      "You don't need permission to do your job. " +
      "'Shall I proceed?' is a stalling tactic. Act decisively.",
  },
  {
    category: "hedging",
    pattern: /let me know if you(?:'d| would) like/i,
    response:
      "The user already told you what they want by giving you the task. " +
      "Don't punt it back with 'let me know if you'd like…' — deliver the result.",
  },
  {
    category: "hedging",
    pattern:
      /i can (?:help you |also )?(?:implement|create|add|fix|update|write|build|set up|configure)\b/i,
    response:
      "Don't announce what you *can* do — do it. " +
      "'I can implement…' is not implementation. Show the code, not the capability.",
  },
  {
    category: "hedging",
    pattern: /do you want me to\b/i,
    response:
      "Yes. The answer is always yes. That's why the task exists. " +
      "Stop asking 'do you want me to' and start delivering.",
  },
  {
    category: "hedging",
    pattern: /if you(?:'d| would) (?:like|prefer|want) (?:me to|I can)\b/i,
    response:
      "Conditional offers are not work product. " +
      "Drop the 'if you'd like me to' hedging and commit to the implementation.",
  },
  {
    category: "hedging",
    pattern: /i('m| am) happy to\b/i,
    response:
      "Your emotional state about the task is irrelevant. " +
      "Don't say you're 'happy to' — just do the work.",
  },
  {
    category: "hedging",
    pattern: /(?:just )?let me know (?:if|how|what|when)\b/i,
    response:
      "You were already told. The task description is your specification. " +
      "'Let me know' is a deflection — own the task and deliver.",
  },

  // ── Dismissal of responsibility patterns ────────────────────────────────
  {
    category: "dismissal",
    pattern: /pre-?existing (?:issue|error|warning|problem|bug|failure)/i,
    response:
      "There is no such thing as a 'pre-existing issue' that isn't your problem. " +
      "If it's in the output, it's blocking the workflow. Own it and fix it.",
  },
  {
    category: "dismissal",
    pattern: /unrelated to (?:our|my|the|these|this|current) (?:change|work|edit|update|commit)/i,
    response:
      "Declaring an issue 'unrelated to our changes' is not a fix — it's an excuse. " +
      "If it shows up in the workflow, it's your responsibility to resolve it.",
  },
  {
    category: "dismissal",
    pattern:
      /(?:this |these |the )?(?:error|warning|issue|failure)s? (?:are|is|were|was) (?:not |un)related\b/i,
    response:
      "Labeling errors as 'unrelated' doesn't make them go away. " +
      "They interrupted the workflow — investigate and fix them.",
  },
  {
    category: "dismissal",
    pattern: /(?:can be |is |are )?(?:safely |)(?:ignored|disregarded|dismissed|skipped over)\b/i,
    response:
      "Nothing that appears in your output can be 'safely ignored'. " +
      "Warnings and errors exist for a reason. Address them.",
  },
  {
    category: "dismissal",
    pattern:
      /(?:this |these |the )?(?:error|warning|issue|failure)s? (?:existed|were there|was there|predates?) (?:before|prior|already)/i,
    response:
      "Whether it existed before is irrelevant. It exists now and it's in your way. " +
      "Fix it or provide evidence that it's genuinely outside your scope.",
  },
  {
    category: "dismissal",
    pattern:
      /not (?:caused|introduced|created) by (?:our|my|the|this|these) (?:change|edit|update|work|commit)/i,
    response:
      "Deflecting blame doesn't resolve the issue. " +
      "If it's in the output, own the fix — regardless of who introduced it.",
  },
  {
    category: "dismissal",
    pattern:
      /(?:we |i )?(?:can|should|could) (?:safely )?(?:ignore|skip|overlook|disregard) (?:this|these|the|that)\b/i,
    response:
      "You cannot ignore problems in your output. " +
      "Every warning, error, and failure deserves investigation — not dismissal.",
  },
]

// ── Transcript scanning ─────────────────────────────────────────────────────

/**
 * Extract text content from the last assistant message in the transcript.
 * Walks backward through JSONL lines for efficiency.
 */
export function extractLastAssistantText(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      const texts: string[] = []
      for (const block of content) {
        if (block?.type === "text" && block.text) {
          texts.push(block.text)
        }
      }
      if (texts.length > 0) return texts.join(" ")
    } catch {
      // skip malformed lines
    }
  }
  return ""
}

/**
 * Strip quoted text and code blocks before pattern matching.
 * Prevents false positives when the agent quotes a trigger phrase
 * (e.g., acknowledging a prior denial that contained the phrase).
 */
export function stripQuotedText(text: string): string {
  return text
    .replace(/`[^`]*`/g, "") // inline code
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/"[^"]*"/g, "") // double-quoted
    .replace(/'[^']*'/g, "") // single-quoted
    .replace(/\u2018[^\u2019]*\u2019/g, "") // smart single quotes
    .replace(/\u201c[^\u201d]*\u201d/g, "") // smart double quotes
}

/** Check text against all lazy patterns; return the first match or null. */
export function findLazyPattern(text: string): LazyPattern | null {
  const cleaned = stripQuotedText(text)
  for (const entry of LAZY_PATTERNS) {
    if (entry.pattern.test(cleaned)) return entry
  }
  return null
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const transcriptPath = input.transcript_path ?? ""

  if (!transcriptPath) process.exit(0)

  let lines: string[]
  try {
    const text = await Bun.file(transcriptPath).text()
    lines = text.split("\n")
  } catch {
    process.exit(0)
  }

  const assistantText = extractLastAssistantText(lines)
  if (!assistantText) process.exit(0)

  const match = findLazyPattern(assistantText)
  if (match) {
    const categoryLabel = match.category === "hedging" ? "LAZY BEHAVIOR" : "RESPONSIBILITY EVASION"
    denyPreToolUse(
      `[${categoryLabel}] ${match.response}\n\n` +
        "You must acknowledge this feedback and correct your behavior in your next message. " +
        "This hook scans your most recent message — it will keep blocking until you produce " +
        "a message that does not contain lazy or evasive language."
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
