// Shared compact-memory guidance used by hooks and CLI commands.
// Keep these strings centralized so fallback wording and checklists
// stay consistent everywhere thresholds are enforced.

import type { ActionPlanItem } from "./action-plan.ts"

// ---------------------------------------------------------------------------
// Slash command / CLI identifier (user-facing)
// ---------------------------------------------------------------------------

/** Slash command shown to agents (Claude Code / Cursor style). */
export const COMPACT_MEMORY_SLASH = "/compact-memory" as const

/**
 * Standard prefix for skill-directed compaction messages, e.g.
 * "Use the /compact-memory skill to reduce …".
 */
export const USE_COMPACT_MEMORY_SKILL = `Use the ${COMPACT_MEMORY_SLASH} skill`

/** Skill id for `skillAdvice()` and `swiz` subcommand name (no leading slash). */
export const COMPACT_MEMORY_SKILL_ID = "compact-memory" as const

// ---------------------------------------------------------------------------
// Core principle
// ---------------------------------------------------------------------------

/** CLAUDE.md is a direct guide to the codebase, not a diary. */
export const NOT_A_DIARY_PRINCIPLE =
  "CLAUDE.md is a direct guide to the codebase, NOT a diary. Remove all narrative, reflective, and temporal language. Convert everything to prescriptive DO/DON'T/Reference directives."

// ---------------------------------------------------------------------------
// Always-retain categories (never remove these during compaction)
// ---------------------------------------------------------------------------

/** Items that must never be abbreviated or deleted during compaction. */
export const ALWAYS_RETAIN_ITEMS: readonly string[] = [
  "Names (functions, variables, classes, files)",
  "Numbers (versions, line numbers, counts, thresholds)",
  "IDs (issue numbers, commit hashes, tool IDs)",
  "URLs and file paths",
  "Commands and code snippets",
  "Technical specifications and constraints",
]

// ---------------------------------------------------------------------------
// Surgical word-removal strategies
// ---------------------------------------------------------------------------

/**
 * Ordered list of surgical reduction strategies.
 * Callers may display these as a numbered guide.
 */
export const SURGICAL_STRATEGIES: readonly string[] = [
  "Remove redundant modifiers and auxiliary verbs (e.g., 'actual progress' → 'progress', 'will take effect' → 'take effect').",
  "Simplify compound phrases (e.g., 'file edit operation' → 'edit operation').",
  "Remove parenthetical restatements that repeat the surrounding text or state the obvious.",
  "Eliminate redundant qualifiers where context makes precision clear.",
  "Consolidate repeated topics — multiple sections on the same concept → one comprehensive section.",
  "Convert session notes and narrative language to DO/DON'T/Reference directives; remove content that cannot be converted.",
  "Cross-reference instead of repeating — state shared guidance once, reference it elsewhere.",
  "Collapse similar DO/DON'T lists on related topics into one comprehensive list.",
]

// ---------------------------------------------------------------------------
// Legacy inline core (kept for backward-compat with existing callers)
// ---------------------------------------------------------------------------

const MANUAL_COMPACTION_CORE =
  "remove redundant modifiers and parenthetical restatements, collapse duplicate topics/lists, convert narrative/session notes to DO/DON'T/Reference directives, and preserve names/IDs/URLs/commands/thresholds"

/**
 * Build manual fallback guidance text for a specific subject.
 *
 * Example:
 * `manualCompactionFallback("CLAUDE.md")`
 * -> "Compact CLAUDE.md manually: ..."
 */
export function manualCompactionFallback(subject: string): string {
  return `Compact ${subject} manually: ${MANUAL_COMPACTION_CORE}.`
}

/**
 * Build manual fallback guidance text for contexts that are not subject-specific.
 *
 * Example:
 * `manualCompactionGuidanceFallback()`
 * -> "Use compact-memory guidance manually: ..."
 */
export function manualCompactionGuidanceFallback(): string {
  return `Use compact-memory guidance manually: ${MANUAL_COMPACTION_CORE}.`
}

// ---------------------------------------------------------------------------
// Compaction checklist
// ---------------------------------------------------------------------------

/**
 * Shared checklist steps for memory-file compaction.
 * Callers provide the final verification step to keep context-specific commands.
 *
 * Example:
 * `compactionChecklistSteps("Re-check: `wc -w CLAUDE.md`")`
 */
export function compactionChecklistSteps(verificationStep: string): ActionPlanItem[] {
  return [
    "Remove unnecessary content:",
    [
      "Redundant modifiers, auxiliary verbs, and filler phrasing.",
      "Parenthetical restatements and duplicate bullets, sections, and topic lists.",
      "Narrative language ('we learned', 'this session', 'when we tried') — convert to directives or remove.",
    ],
    "Convert remaining content to direct DO/DON'T/Reference guidance.",
    "Preserve all technical specifics: names, IDs, URLs, commands, and numeric constraints.",
    "Apply surgical strategies: consolidate repeated topics, cross-reference instead of repeating, collapse similar lists.",
    verificationStep,
  ]
}

// ---------------------------------------------------------------------------
// Verification checklist
// ---------------------------------------------------------------------------

/**
 * Verification steps to confirm compaction succeeded.
 * Callers provide the re-run command appropriate for their context.
 *
 * Example:
 * `compactionVerificationSteps("bun ~/.claude/skills/compact-memory/scripts/analyze-claude-md.ts")`
 */
export function compactionVerificationSteps(rerunCommand: string): ActionPlanItem[] {
  return [
    `Re-run analysis: \`${rerunCommand}\``,
    [
      '"Overall status" must show "✓ All files within limits".',
      '"Files Exceeding Thresholds" shows "None ✓" and "Total Footprint" shows "✓ Within limit".',
    ],
    "Confirm word count decreased (never increased).",
    "Verify no specifics removed: all function names, version numbers, IDs, URLs, commands, and file paths remain intact.",
    "Search for residual narrative language ('we learned', 'this session', 'when we', 'during this') and convert or remove.",
  ]
}
