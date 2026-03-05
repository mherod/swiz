// Shared compact-memory guidance used by hooks and CLI commands.
// Keep these strings centralized so fallback wording and checklists
// stay consistent everywhere thresholds are enforced.

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

/**
 * Shared checklist steps for memory-file compaction.
 * Callers provide the final verification step to keep context-specific commands.
 *
 * Example:
 * `compactionChecklistSteps("Re-check: `wc -w CLAUDE.md`")`
 */
export function compactionChecklistSteps(verificationStep: string): string[] {
  return [
    "Remove redundant modifiers, auxiliary verbs, and filler phrasing.",
    "Remove parenthetical restatements and duplicate bullets, sections, and topic lists.",
    "Convert narrative/session language into direct DO/DON'T/Reference guidance.",
    "Keep all technical specifics: names, IDs, URLs, commands, and numeric constraints.",
    verificationStep,
  ]
}
