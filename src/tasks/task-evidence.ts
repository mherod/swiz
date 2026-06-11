/**
 * Canonical task-completion-evidence vocabulary and predicates.
 *
 * Completion evidence is checked in three semantically distinct ways across the
 * governance surface; this module is their single home so the vocabulary cannot
 * drift between callers:
 *
 * - {@link hasMeaningfulCompletionEvidence} — "is there any evidence at all?"
 *   (non-empty). Gates the CLI auto-transition shortcut in `task-service.ts`.
 * - {@link hasStructuredEvidence} — "is it traceable?" (a `commit:`/`pr:`/… marker).
 *   Bypasses the `pretooluse-no-phantom-task-completion` block.
 * - {@link hasCiEvidence} — "does it prove CI passed?". Required by the
 *   `stop-completion-auditor` after a `git push`.
 *
 * Pure leaf module — no imports — so hooks can import it without circular-dep or
 * daemon-coupling risk.
 */

/** Traceable evidence-marker prefixes that indicate real, referenceable work. */
const STRUCTURED_EVIDENCE_MARKERS = ["commit", "pr", "file", "test", "ci_green", "run"] as const

/** Matches a traceable evidence marker like `commit:<sha>` or `pr:<url>`. */
const STRUCTURED_EVIDENCE_RE = new RegExp(
  String.raw`\b(?:${STRUCTURED_EVIDENCE_MARKERS.join("|")}):[^\s]`
)

/** Matches evidence that a CI run passed (green/pass/success, or success conclusion). */
const CI_EVIDENCE_RE = /\bci\b.*(?:green|pass|success)|conclusion.*success/i

/**
 * A pending task that never dwelled in `in_progress` has no observable work
 * behind it, so an auto-transition straight to `completed` is phantom-prone.
 * Evidence is meaningful only when it is non-empty after trimming — the
 * service-layer analogue of the no-phantom-completion hook.
 */
export function hasMeaningfulCompletionEvidence(evidence: string | undefined): boolean {
  return typeof evidence === "string" && evidence.trim().length > 0
}

/** True when text carries a traceable evidence marker (`commit:`, `pr:`, …). */
export function hasStructuredEvidence(text: string): boolean {
  return STRUCTURED_EVIDENCE_RE.test(text)
}

/** True when text indicates a CI run passed. */
export function hasCiEvidence(text: string): boolean {
  return CI_EVIDENCE_RE.test(text)
}
