const LEADING_MARKER_CHARS = String.raw`[\s•◼◻⏳✓✗*-]*`

const WORK_DEFERRAL_PATTERNS = [
  // "Defer #1727", "Deferred: ...", "Deferring: ..."
  new RegExp(`^${LEADING_MARKER_CHARS}defer(?:red|ring)?(?:\\b|#)`, "i"),
  // "Park this", "Parked: billing work", "Parking this issue"
  new RegExp(`^${LEADING_MARKER_CHARS}park(?:ed|ing)?\\b`, "i"),
  // "Shelve the refactor", "Shelved: billing work"
  new RegExp(`^${LEADING_MARKER_CHARS}shelved?\\b`, "i"),
  // "Icebox: redesign the UI", "Iceboxed: dark mode"
  new RegExp(`^${LEADING_MARKER_CHARS}icebox(?:ed)?\\b`, "i"),
  // "Carry over billing work", "Carry-forward the migration"
  new RegExp(`^${LEADING_MARKER_CHARS}carry[-\\s]?(?:over|forward)\\b`, "i"),
  // "... to/for/until next session/sprint/release/iteration/cycle/week"
  /\b(?:to|for|until)\s+(?:the\s+)?next\s+(?:session|sprint|release|iteration|cycle|week)\b/i,
  // "Next session: ...", "Next sprint: ...", etc.
  new RegExp(
    `^${LEADING_MARKER_CHARS}next\\s+(?:session|sprint|release|iteration|cycle|week)\\b`,
    "i"
  ),
  // "Follow-up: consider X", "Follow-up: revisit X" — vague intent masking deferral
  new RegExp(`^${LEADING_MARKER_CHARS}follow-up\\s*:\\s*(?:consider|revisit)\\b`, "i"),
  new RegExp(`^${LEADING_MARKER_CHARS}follow-up\\s*:.*\\bnext\\s+session\\b`, "i"),
  new RegExp(`^${LEADING_MARKER_CHARS}future\\s*[:\\s-]`, "i"),
  // "Later:", "Backlog:", "Someday:", "Eventually:", "Hold:", "Hold off:"
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:later|todo|backlog|punt|punted|postponed?|tomorrow|someday|eventually|hold(?:\\s+off)?)\\b\\s*[:\\s-]`,
    "i"
  ),
]

const CARRYOVER_DEFERRAL_PREFIX_RE = /^\s*(?:consider\b|revisit\b|future\s*:|follow[-\s]?up\s*:)/i

/**
 * Detects task subjects that defer current-session work instead of describing
 * the work to do now.
 */
export function isTaskSubjectWorkDeferral(subject: string | undefined | null): boolean {
  return typeof subject === "string" && WORK_DEFERRAL_PATTERNS.some((re) => re.test(subject))
}

/**
 * Detects stop-check carry-over notes that are intentionally parked for a
 * later session and should not block stop.
 */
export function isTaskSubjectCarryoverDeferral(subject: string | undefined | null): boolean {
  return typeof subject === "string" && CARRYOVER_DEFERRAL_PREFIX_RE.test(subject)
}

export function stripTaskSubjectCarryoverDeferralPrefix(subject: string): string {
  return subject.replace(CARRYOVER_DEFERRAL_PREFIX_RE, "").trim()
}
