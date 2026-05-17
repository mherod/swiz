const LEADING_MARKER_CHARS = String.raw`[\s•◼◻⏳✓✗*-]*`

const WORK_DEFERRAL_PATTERNS = [
  new RegExp(`^${LEADING_MARKER_CHARS}defer(?:red|ring)?(?:\\b|#)`, "i"),
  /\bto\s+(?:the\s+)?next\s+session\b/i,
  new RegExp(`^${LEADING_MARKER_CHARS}next\\s+session\\b`, "i"),
  new RegExp(`^${LEADING_MARKER_CHARS}follow-up\\s*:.*\\bnext\\s+session\\b`, "i"),
  new RegExp(`^${LEADING_MARKER_CHARS}future\\s*[:\\s-]`, "i"),
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:later|todo|backlog|punt|punted|postponed?|tomorrow)\\b\\s*[:\\s-]`,
    "i"
  ),
]

const CARRYOVER_DEFERRAL_PREFIX_RE = /^\s*(?:consider\b|future\s*:|follow[-\s]?up\s*:)/i

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
