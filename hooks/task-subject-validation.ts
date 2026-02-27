// Shared logic for compound task subject detection and splitting.

export interface CompoundResult {
  matched: false
}

export interface CompoundMatch {
  matched: true
  intro: string
  suggestions: string[]
  /** True when the task appears to test items that likely have matching implementation tasks. */
  pairing?: boolean
}

export type DetectionResult = CompoundResult | CompoundMatch

/** Extract the leading verb from a subject, e.g. "Fix" from "Fix A and B". */
function extractVerb(s: string): string | null {
  const m = s.match(/^([A-Z][a-z]*)(?:\s|$)/)
  return m ? (m[1] ?? null) : null
}

// Primary imperative verbs that signal independent deliverable tasks.
// Excludes run/verify/check/test — those are often sub-steps, not separate tasks.
const ACTION_VERBS =
  /^(add|fix|update|remove|delete|create|refactor|migrate|implement|improve|rename|move|extract|replace|rewrite|enable|disable|configure|set up|clean up|write|deploy|build|generate|publish|merge|revert|bump|review|approve|reject|audit|profile|optimize|benchmark|document|analyse|analyze)\b/i

/** Prepend verb to each part if not already present. */
function withVerb(verb: string | null, parts: string[]): string[] {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (!verb) return capitalize(p)
      // Don't prepend if part already starts with the same verb or any action verb
      if (new RegExp(`^${verb}\\b`, "i").test(p)) return p
      if (ACTION_VERBS.test(p)) return capitalize(p)
      return `${verb} ${p.trim()}`
    })
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Check if subject indicates this is a test-focused task. */
function isTestTask(bare: string): boolean {
  // Match patterns like "tests for X", "test cases for X", "test coverage for X"
  return /\b(tests?|test cases?|test coverage|test fixtures?|test suites?|test scenarios?)\b/i.test(
    bare
  )
}

export function detect(s: string): DetectionResult {
  const verb = extractVerb(s)
  const bare = verb ? s.slice(verb.length).trim() : s

  // Multiple issue hashes — most specific, check first
  const hashes = s.match(/#\d+/g) ?? []
  if (hashes.length >= 2) {
    const suggestions = hashes.map((h: string) => (verb ? `${verb} ${h}` : h))
    return {
      matched: true,
      intro: "Tasks relating to different issues should be tracked separately. Suggested split:",
      suggestions,
    }
  }

  // 2+ commas (3+ items) — check before " and " since lists often end with ", and"
  if ((s.match(/,/g) ?? []).length >= 2) {
    // "foo, bar, and baz" → ["foo", "bar", "baz"]
    const normalized = bare
      .replace(/,?\s+and\s+/i, ", ") // ", and" or " and" → ", "
      .replace(/,\s*$/, "") // strip trailing comma
    const parts = normalized.split(/,\s*/)

    // Detect suffix-only trailing items: short (≤20 chars) and no action verb.
    // E.g. "Get X for Dec 2025, Jan 2026, Feb 2026" → trailing parts are "Jan 2026", "Feb 2026"
    // In this case, expand each trailing part by replacing the corresponding suffix
    // of the first item, giving full-context task names.
    const trailingAreSuffixes = parts
      .slice(1)
      .every((p) => p.trim().length <= 20 && !ACTION_VERBS.test(p.trim()))
    if (trailingAreSuffixes && parts.length >= 2) {
      // The first part is the full reference item, e.g. "usage breakdowns from billing console for Dec 2025"
      // (bare already has the verb stripped). Find the longest trailing suffix of the
      // first part whose length is ≤ the max trailing-item length, then use everything
      // before it as the shared stem.
      const firstPart = (parts[0] ?? "").trim()
      const firstTokens = firstPart.split(/\s+/)
      const maxSuffixLen = Math.max(...parts.slice(1).map((p) => p.trim().length))

      // Walk backwards to find how many tokens form the suffix that is being varied
      let suffixTokens = 0
      for (let i = firstTokens.length - 1; i >= 0; i--) {
        const candidate = firstTokens.slice(i).join(" ")
        if (candidate.length <= maxSuffixLen) {
          suffixTokens = firstTokens.length - i
        } else {
          break
        }
      }

      if (suffixTokens > 0) {
        // stemTokens = everything before the varied suffix (still in bare, no verb)
        const stemTokens = firstTokens.slice(0, firstTokens.length - suffixTokens)
        const stemBare = stemTokens.join(" ").trim() // e.g. "usage breakdowns from billing console for"
        const prefix = verb ? `${verb} ` : ""
        // First part is already the full item; trailing parts need the stem prepended.
        // If stemBare is non-empty, return the stem-expanded suggestions.
        // If stemBare is empty (all tokens are the suffix), fall through to the
        // shared-object check below before finally falling back to withVerb.
        if (stemBare) {
          const suggestions = parts.map((p, i) =>
            i === 0
              ? capitalize(`${prefix}${firstPart}`.trim())
              : capitalize(`${prefix}${stemBare} ${p.trim()}`.trim())
          )

          // For test tasks, signal pairing so the agent knows to update existing
          // implementation tasks rather than creating separate test tasks.
          const pairing = isTestTask(bare)
          const intro = pairing
            ? "This test task covers multiple items. If implementation tasks already exist for each item, update them to include tests rather than creating separate test tasks. Suggested test task names:"
            : "This is a compound task. Suggested split:"

          return { matched: true, intro, suggestions, ...(pairing ? { pairing: true } : {}) }
        }
      }
    }

    // Detect shared trailing object: leading parts are bare action verbs (1-2 words),
    // and only the last part carries the object. E.g. "Review, approve, and merge the PR"
    // → append the object from the last item to each bare-verb part.
    const lastPart = (parts[parts.length - 1] ?? "").trim()
    const lastVerbMatch = lastPart.match(ACTION_VERBS)
    if (lastVerbMatch) {
      const lastVerb = lastVerbMatch[0]
      const sharedObject = lastPart.slice(lastVerb.length).trim()
      const leadingAreBareVerbs =
        sharedObject.length > 0 &&
        parts
          .slice(0, -1)
          .every((p) => ACTION_VERBS.test(p.trim()) && p.trim().split(/\s+/).length <= 2)
      if (leadingAreBareVerbs) {
        const suggestions = parts.map((p) => {
          const t = p.trim()
          const v = t.match(ACTION_VERBS)?.[0] ?? t
          const own = t.slice(v.length).trim()
          return capitalize(`${v} ${own || sharedObject}`.trim())
        })
        return { matched: true, intro: "This is a compound task. Suggested split:", suggestions }
      }
    }

    return {
      matched: true,
      intro: "This is a compound task. Suggested split:",
      suggestions: withVerb(verb, parts),
    }
  }

  // " and " conjunction — split on first occurrence only
  // Both sides must start with an action verb to be considered independent tasks.
  // If the second part is just a sub-step or modifier (e.g. "make executable",
  // "run validation"), it's not a separate concern.
  if (/ and /i.test(bare)) {
    const parts = bare.split(/ and /i)
    // Flag if the second (and any further) parts start with an action verb —
    // that signals an independent new task, not just a sub-step or modifier.
    const trailingPartsAreActions = parts.slice(1).every((p) => ACTION_VERBS.test(p.trim()))
    if (trailingPartsAreActions) {
      return {
        matched: true,
        intro: "This is a compound task. Suggested split:",
        suggestions: withVerb(verb, parts),
      }
    }
  }

  return { matched: false }
}

export function formatMessage(result: CompoundMatch, postfix?: string): string {
  const lines = [result.intro, ...result.suggestions.map((s) => `  • ${s}`)]
  if (postfix) lines.push(postfix)
  return lines.join("\n")
}
