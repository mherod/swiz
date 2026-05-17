const LEADING_MARKER_CHARS = String.raw`[\s•◼◻⏳✓✗⎿*-]*`
const ISSUE_REF = String.raw`(?:issue\s*)?#\d+`

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
  // Issue-selection labels are not concrete current-session work.
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:pick|choose|select|grab|take|queue|line\\s+up|shortlist|prioriti[sz]e)\\s+(?:the\\s+)?(?:next\\s+)?(?:issue|pick|task|work\\s+item)\\b`,
    "i"
  ),
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:next|candidate|possible|potential|optional)\\s+(?:issue|pick|task|work\\s+item)\\b`,
    "i"
  ),
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:consider|revisit|evaluate|assess|scope|plan|circle\\s+back\\s+to|come\\s+back\\s+to|return\\s+to)\\s+${ISSUE_REF}\\b`,
    "i"
  ),
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:consider|revisit|evaluate|assess|scope|plan)\\s+(?:the\\s+)?(?:next\\s+)?issue\\b`,
    "i"
  ),
  new RegExp(
    `^${LEADING_MARKER_CHARS}(?:maybe|if\\s+time|when\\s+time\\s+allows|if\\s+there(?:'s|\\s+is)?\\s+time)\\b.*(?:issue|#\\d+)`,
    "i"
  ),
  /\b(?:not\s+now|later\s+if|when\s+there(?:'s|\s+is)\s+time)\b/i,
  /\b(?:after|following)\s+(?:this|the)\s+(?:session|turn|current\s+task)\b/i,
  /\b(?:save|leave|reserve)\b.*\b(?:later|tomorrow|next\s+(?:session|sprint|release|iteration|cycle|week))\b/i,
  // "... to/for/until next session/sprint/release/iteration/cycle/week"
  /\b(?:to|for|until)\s+(?:the\s+)?next\s+(?:session|sprint|release|iteration|cycle|week)\b/i,
  // "Next session: ...", "Next sprint: ...", etc.
  new RegExp(
    `^${LEADING_MARKER_CHARS}next\\s+(?:session|sprint|release|iteration|cycle|week)\\b`,
    "i"
  ),
  // Any "Follow-up: X" task defers current-session work — do it now or record a real blocker
  new RegExp(`^${LEADING_MARKER_CHARS}follow[-\\s]?up\\s*:`, "i"),
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
  if (typeof subject !== "string") return false
  const normalized = subject.normalize("NFKC")
  return WORK_DEFERRAL_PATTERNS.some((re) => re.test(normalized))
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
