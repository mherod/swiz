// ─── Validation & evidence ───────────────────────────────────────────────────

export const EVIDENCE_PREFIXES = ["commit:", "pr:", "file:", "test:", "note:"]

/**
 * Segment-anchored evidence patterns.
 * Evidence is split on delimiters (—, --, ;, |, ", ") into segments first,
 * then each pattern is matched against the START of each segment.
 * This prevents free-text within one field's value (e.g. "note:CI green")
 * from satisfying the ci_green pattern as a second distinct field.
 */
export const EVIDENCE_SEGMENT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "note", re: /^note\s*:\s*\S.{4,}/i },
  { name: "conclusion", re: /^conclusion\s*:\s*\S+/i },
  { name: "run", re: /^run\s+\d{3,}/i },
  { name: "commit", re: /^(?:commit\s*:\s*)?[0-9a-f]{7,40}$/i },
  { name: "ci_green", re: /^ci[\s_]green$/i },
  { name: "pr", re: /^pr[:#]\s*\d+/i },
  { name: "file", re: /^file\s*:\s*\S+/i },
  { name: "test", re: /^test\s*:\s*\S+/i },
  { name: "no_ci", re: /^no[\s_]ci\b.*(workflow|run|configured)/i },
]

export const REQUIRED_EVIDENCE_FIELDS = 1

// Invariant: every EVIDENCE_PREFIXES entry must have a matching pattern name.
// Throws at module load time so drift is caught immediately rather than silently
// accepting a prefix that will never satisfy field validation.
{
  const _patternNames = new Set(EVIDENCE_SEGMENT_PATTERNS.map((p) => p.name))
  for (const prefix of EVIDENCE_PREFIXES) {
    const key = prefix.replace(/:$/, "")
    if (!_patternNames.has(key)) {
      throw new Error(
        `[tasks] EVIDENCE_PREFIXES mismatch: "${prefix}" has no corresponding entry in ` +
          `EVIDENCE_SEGMENT_PATTERNS. Add { name: "${key}", re: /^${key}\\s*:\\s*\\S+/i } to EVIDENCE_SEGMENT_PATTERNS.`
      )
    }
  }
}

const COMMIT_PREFIX_RE = /^commit\s*:\s*/i
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i

/** Split evidence on delimiters, check each segment independently, return matched field names. */
export function countEvidenceFields(evidence: string): string[] {
  const rawSegments = evidence
    .split(/\s*(?:—|--|;|\|)\s*|\s*,\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // Expand "commit:<sha1> <sha2> ..." into one "commit:<sha>" segment per SHA
  const segments: string[] = []
  for (const seg of rawSegments) {
    const prefixMatch = COMMIT_PREFIX_RE.exec(seg)
    if (prefixMatch) {
      const rest = seg.slice(prefixMatch[0].length).trim()
      const tokens = rest.split(/\s+/)
      if (tokens.length > 1 && tokens.every((t) => HEX_SHA_RE.test(t))) {
        for (const sha of tokens) segments.push(`commit:${sha}`)
        continue
      }
    }
    segments.push(seg)
  }
  const foundKeys = new Set<string>()
  for (const segment of segments) {
    for (const { name, re } of EVIDENCE_SEGMENT_PATTERNS) {
      if (re.test(segment)) {
        foundKeys.add(name)
        break
      }
    }
  }
  return [...foundKeys]
}

export function validateEvidence(evidence: string): string | null {
  if (!EVIDENCE_PREFIXES.some((p) => evidence.startsWith(p))) {
    return (
      `Invalid evidence format: "${evidence}"\n` +
      "Evidence must start with a recognized prefix:\n" +
      EVIDENCE_PREFIXES.map((p) => `  ${p}<value>`).join("\n") +
      '\n\nExample: --evidence "commit:abc123f" or --evidence "note:CI green"'
    )
  }

  // Validate every segment's prefix, not just the first one.
  const SEGMENT_SPLIT_RE = /\s*(?:—|--|;|\|)\s*|\s*,\s+/
  const PREFIX_SHAPE_RE = /^(\w{2,20}):/
  const segments = evidence
    .split(SEGMENT_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const seg of segments) {
    const m = PREFIX_SHAPE_RE.exec(seg)
    if (m) {
      const candidate = `${m[1]}:`
      const isKnownPrefix = EVIDENCE_PREFIXES.includes(candidate)
      const matchesPattern = EVIDENCE_SEGMENT_PATTERNS.some(({ re }) => re.test(seg))
      if (!isKnownPrefix && !matchesPattern) {
        return (
          `Invalid evidence prefix "${candidate}" in segment: "${seg}"\n` +
          "Recognized prefixes:\n" +
          EVIDENCE_PREFIXES.map((p) => `  ${p}<value>`).join("\n") +
          '\n\nExample: --evidence "commit:abc123f" or --evidence "note:CI green"'
        )
      }
    }
  }

  const matched = countEvidenceFields(evidence)
  if (matched.length < REQUIRED_EVIDENCE_FIELDS) {
    const found = matched.length > 0 ? matched.join(", ") : "none"
    return (
      `Evidence must contain at least ${REQUIRED_EVIDENCE_FIELDS} structured field, but found ${matched.length} (${found}).\n\n` +
      `Structured fields (any ${REQUIRED_EVIDENCE_FIELDS}+ required):\n` +
      EVIDENCE_SEGMENT_PATTERNS.map(({ name }) => `  • ${name}`).join("\n") +
      '\n\nExample: --evidence "note:CI green"'
    )
  }

  return null
}

export function verifyTaskSubject(taskSubject: string, verifyText: string): string | null {
  const normalizedSubject = taskSubject.toLowerCase().trim()
  const normalizedVerify = verifyText.toLowerCase().trim()
  if (normalizedSubject.startsWith(normalizedVerify)) return null
  return (
    `Verification failed.\n` +
    `  Expected subject to start with: "${verifyText}"\n` +
    `  Actual subject: "${taskSubject}"`
  )
}
