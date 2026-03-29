// ─── Task subject fingerprinting ────────────────────────────────────────────
//
// Deterministic text fingerprinting for task subjects. Two subjects describing
// the same work produce the same fingerprint regardless of word order,
// inflection, or synonym choice. Extracted from hooks/hook-utils.ts (issue #84).

// ─── Stop words ─────────────────────────────────────────────────────────────

const FINGERPRINT_STOP_WORDS = new Set([
  // Articles & conjunctions
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "in",
  "of",
  "on",
  "with",
  "this",
  "that",
  "all",
  "its",
  "from",
  "by",
  "at",
  "as",
  "so",
  "but",
  "not",
  "if",
  "up",
  "out",
  "into",
  "then",
  "than",
  "also",
  "just",
  "only",
  "each",
  "after",
  "before",
  "about",
  "when",
  // Auxiliary verbs (filler in task subjects)
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "having",
  // Modal verbs (don't change task intent)
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "need",
])

// ─── Phrase synonyms ───────────────────────────────────────────────────────
//
// Multi-word phrases that map to a single canonical token. Applied before
// word-level processing. Order: longest phrases first to prevent partial matches.

const PHRASE_SYNONYMS: [phrase: string, canonical: string][] = [
  // Git workflow phases → canonical multi-tokens (space-separated)
  ["working tree", "worktree"],
  ["work tree", "worktree"],
  ["collaboration guard", "prepush verify"],
  ["task preflight", "prepush verify"],
  ["pre push", "prepush"],
  ["push preflight", "prepush verify"],
  ["staged changes", "commit changes"],
  ["uncommitted changes", "commit changes"],
  ["unstaged changes", "commit changes"],
  ["conventional commits", "commitformat"],
  ["conventional commit", "commitformat"],
  // CI verification
  ["ci status", "cicheck"],
  ["ci passes", "cicheck"],
  ["ci green", "cicheck"],
  ["github checks", "cicheck"],
  // PR workflow
  ["gate check", "prcheck"],
  ["quality gate", "prcheck"],
  ["merge check", "prcheck"],
]

function applyPhraseSynonyms(normalized: string): string {
  let result = normalized
  for (const [phrase, canonical] of PHRASE_SYNONYMS) {
    result = result.replaceAll(phrase, canonical)
  }
  return result
}

// ─── Synonym map ────────────────────────────────────────────────────────────

/**
 * Synonym map: maps variant words to a single canonical form.
 * Covers task-domain verbs and nouns that agents use interchangeably.
 */
const SYNONYM_MAP = new Map<string, string>([
  // verify / check / confirm / validate → verify
  ["check", "verify"],
  ["confirm", "verify"],
  ["validate", "verify"],
  ["assert", "verify"],
  ["ensure", "verify"],
  // implement / add / create / build → implement
  ["add", "implement"],
  ["create", "implement"],
  ["build", "implement"],
  ["introduce", "implement"],
  ["wire", "implement"],
  // fix / repair / resolve / patch → fix
  ["repair", "fix"],
  ["resolve", "fix"],
  ["patch", "fix"],
  ["correct", "fix"],
  // update / modify / edit / change / revise → update
  ["modify", "update"],
  ["edit", "update"],
  ["change", "update"],
  ["revise", "update"],
  ["adjust", "update"],
  ["refine", "update"],
  // remove / delete / drop / clean → remove
  ["delete", "remove"],
  ["drop", "remove"],
  ["clean", "remove"],
  ["prune", "remove"],
  ["strip", "remove"],
  // push / deploy / ship / publish → push
  ["deploy", "push"],
  ["ship", "push"],
  ["publish", "push"],
  // commit / save / stage → commit
  ["save", "commit"],
  ["stage", "commit"],
  // test / spec → test
  ["spec", "test"],
  // run / execute / invoke / perform → run
  ["execute", "run"],
  ["invoke", "run"],
  ["perform", "run"],
  // changes / diff / modifications → changes
  ["diff", "changes"],
  ["modifications", "changes"],
  // workflow: preflight / guard / gate → verify
  ["preflight", "verify"],
  ["guard", "verify"],
  ["gate", "verify"],
  // workflow: clean / pristine → clean
  ["pristine", "clean"],
  ["worktree", "tree"],
])

// ─── Irregular stems ────────────────────────────────────────────────────────

const IRREGULAR_STEMS = new Map<string, string>([
  ["built", "build"],
  ["ran", "run"],
  ["wrote", "write"],
  ["written", "write"],
  ["sent", "send"],
  ["made", "make"],
  ["found", "find"],
  ["got", "get"],
  ["gotten", "get"],
  ["took", "take"],
  ["taken", "take"],
  ["gave", "give"],
  ["given", "give"],
  ["broke", "break"],
  ["broken", "break"],
  ["reset", "reset"],
  ["kept", "keep"],
  ["knew", "know"],
  ["known", "know"],
  ["shown", "show"],
  ["began", "begin"],
  ["begun", "begin"],
  ["chose", "choose"],
  ["chosen", "choose"],
  ["saw", "see"],
  ["seen", "see"],
  ["went", "go"],
  ["gone", "go"],
  ["did", "do"],
  ["done", "do"],
  ["undone", "do"],
  ["brought", "bring"],
  ["caught", "catch"],
  ["threw", "throw"],
  ["thrown", "throw"],
  ["held", "hold"],
  ["told", "tell"],
  ["led", "lead"],
  ["lost", "lose"],
  ["left", "leave"],
  ["spent", "spend"],
  ["thought", "think"],
  ["bound", "bind"],
  ["stuck", "stick"],
  ["hid", "hide"],
  ["hidden", "hide"],
  ["withdrew", "withdraw"],
  ["withdrawn", "withdraw"],
  ["grew", "grow"],
  ["grown", "grow"],
  ["drew", "draw"],
  ["drawn", "draw"],
  ["spun", "spin"],
  ["woke", "wake"],
  ["woken", "wake"],
  ["laid", "lay"],
  ["dealt", "deal"],
  ["meant", "mean"],
  ["understood", "understand"],
  ["felt", "feel"],
  ["taught", "teach"],
  ["slid", "slide"],
  ["stole", "steal"],
  ["stolen", "steal"],
  ["swept", "sweep"],
  ["spoke", "speak"],
  ["spoken", "speak"],
  ["tore", "tear"],
  ["torn", "tear"],
  ["fed", "feed"],
  ["fought", "fight"],
  ["sought", "seek"],
  ["slept", "sleep"],
  ["sang", "sing"],
  ["sung", "sing"],
  ["sank", "sink"],
  ["sunk", "sink"],
  ["sat", "sit"],
  ["stood", "stand"],
  ["swung", "swing"],
  // Irregular plurals / noun forms
  ["indices", "index"],
  ["statuses", "status"],
  ["patches", "patch"],
  ["branches", "branch"],
  ["matches", "match"],
  ["caches", "cache"],
  ["batches", "batch"],
])

// ─── Stemmer ────────────────────────────────────────────────────────────────

// Suffix rules table: [suffix, minWordLen, sliceEnd, append]
// Order matters: longest/most-specific suffixes first.
type SuffixRule = [suffix: string, minLen: number, sliceEnd: number, append: string]

const SUFFIX_RULES: SuffixRule[] = [
  // -ing forms: doubled consonant before "ing" → strip 4, keep consonant
  ...Array.from("tnrlydszbpmk", (ch) => [`${ch}ing`, 6, -4, ch] as SuffixRule),
  ["ing", 6, -3, ""],
  // -ation before -tion (implementation → implement)
  ["ation", 8, -5, ""],
  ["tion", 6, -4, ""],
  // -ment: require >= 10 chars to avoid stripping root words (implement, comment)
  ["ment", 10, -4, ""],
  ["ated", 6, -2, ""],
  ["ized", 6, -2, ""],
  // -ed forms: doubled consonant before "ed" → strip 3, keep consonant
  ...Array.from("tnrlspzbmk", (ch) => [`${ch}ed`, 6, -3, ch] as SuffixRule),
  // -ied → -y (verified → verify, modified → modify)
  ["ied", 6, -3, "y"],
  ["ed", 5, -2, ""],
  ["ly", 5, -2, ""],
  ["er", 5, -2, ""],
  ["es", 5, -2, ""],
]

function applySuffixRules(word: string): string {
  for (const [suffix, minLen, sliceEnd, append] of SUFFIX_RULES) {
    if (word.length >= minLen && word.endsWith(suffix)) {
      return word.slice(0, sliceEnd) + append
    }
  }
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1)
  }
  return word
}

function collapseDoubledConsonant(stem: string): string {
  if (stem.length >= 4 && stem[stem.length - 1] === stem[stem.length - 2]) {
    const ch = stem[stem.length - 1]!
    if (ch >= "a" && ch <= "z" && !"aeiou".includes(ch)) {
      return stem.slice(0, -1)
    }
  }
  return stem
}

/**
 * Words starting with "un" where the prefix is NOT a negation.
 * These are etymologically distinct roots that must not be stripped.
 */
const UN_PREFIX_BLOCKLIST = new Set([
  "understand",
  "under",
  "undo",
  "unique",
  "uniqu",
  "unify",
  "union",
  "universe",
  "univers",
  "unless",
  "unlike",
  "until",
  "unusual",
  "uncle",
  "uncl",
  "unit",
  "unix",
  "unison",
  "unfold",
])

/**
 * Strip negation prefix "un" when the remaining stem is a meaningful word.
 * "uncommit" → "commit", "unpush" → "push", "uncook" → "cook".
 * Guards: stem after stripping must be ≥3 chars, and the original word
 * must not be in the blocklist of non-negation "un-" words.
 */
function stripNegationPrefix(stem: string): string {
  if (stem.length >= 5 && stem.startsWith("un") && !UN_PREFIX_BLOCKLIST.has(stem)) {
    const remainder = stem.slice(2)
    if (remainder.length >= 3) return remainder
  }
  return stem
}

/**
 * Lightweight suffix-stripping stemmer for task-domain English.
 * Reduces inflected forms to a common root so "committing" and "commit",
 * "verifying" and "verify", "formatted" and "format" match.
 * Also strips negation prefixes so "uncommitted" → "commit".
 */
export function stemWord(word: string): string {
  const irregular = IRREGULAR_STEMS.get(word)
  if (irregular) return irregular
  return stripNegationPrefix(collapseDoubledConsonant(applySuffixRules(word)))
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

/**
 * Compute a deterministic fingerprint from a task subject.
 *
 * Pipeline: lowercase → strip punctuation → tokenize → filter stop words →
 * stem each word (irregular lookup then suffix strip) → synonym map → sort → hash.
 *
 * Two subjects describing the same work produce the same fingerprint
 * regardless of word order, inflection, or synonym choice.
 */
// ─── Subject text analysis ──────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace for fuzzy comparison. */
export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Extract significant words (skip stop words and short tokens). */
export function significantWords(normalized: string): Set<string> {
  return new Set(
    normalized.split(" ").filter((w) => w.length > 2 && !FINGERPRINT_STOP_WORDS.has(w))
  )
}

/** Extract significant words with phrase synonyms, stemming, and synonym resolution applied. */
export function canonicalWords(normalized: string): Set<string> {
  const withPhrases = applyPhraseSynonyms(normalized)
  return new Set(
    withPhrases
      .split(" ")
      .filter((w) => w.length > 2 && !FINGERPRINT_STOP_WORDS.has(w))
      .map((w) => {
        const stemmed = stemWord(w)
        return SYNONYM_MAP.get(stemmed) ?? SYNONYM_MAP.get(`${stemmed}e`) ?? stemmed
      })
  )
}

// ─── Domain classification ─────────────────────────────────────────────────
//
// Maps canonical words to semantic domains. Two tasks in the same domain with
// overlapping action verbs are likely duplicates even when word overlap is low.
// This catches subsumption cases like "Commit staged changes" vs
// "Perform Git Commit and Push" — both in the git-commit domain.

const DOMAIN_MAP = new Map<string, string>([
  // git-commit domain: staging, committing, worktree cleanliness
  ["commit", "git-commit"],
  ["push", "git-commit"],
  ["worktree", "git-commit"],
  ["tree", "git-commit"],
  ["remove", "git-commit"], // "clean" stems to "remove" via synonym
  ["git", "git-commit"],
  ["commitformat", "git-commit"],
  // prepush domain: guards, preflights, collaboration checks
  ["prepush", "git-prepush"],
  // ci domain
  ["cicheck", "ci"],
  // pr domain
  ["prcheck", "pr"],
])

/** Action verbs — words that describe what the task does (vs what it acts on). */
const ACTION_VERBS = new Set([
  "verify",
  "run",
  "implement",
  "fix",
  "update",
  "remove",
  "push",
  "commit",
  "test",
])

function classifyDomains(words: Set<string>): Set<string> {
  const domains = new Set<string>()
  for (const w of words) {
    const domain = DOMAIN_MAP.get(w)
    if (domain) domains.add(domain)
  }
  return domains
}

// ─── Verb-object decomposition (lightweight POS) ───────────────────────────

const WORKFLOW_PIPELINES: string[][] = [
  ["commit", "push", "verify", "remove", "run"],
  ["test", "verify", "fix"],
]

function sameWorkflowPipeline(verbA: string, verbB: string): boolean {
  if (verbA === verbB) return true
  for (const pipeline of WORKFLOW_PIPELINES) {
    if (pipeline.includes(verbA) && pipeline.includes(verbB)) return true
  }
  return false
}

function extractVerb(words: Set<string>): string | null {
  for (const w of words) {
    if (ACTION_VERBS.has(w)) return w
  }
  return null
}

/**
 * Two subjects overlap if:
 * 1. They share ≥50% of their canonical (stemmed+synonymized) significant words, OR
 * 2. They share a semantic domain AND either have high domain-word density,
 *    verbs in the same workflow pipeline, or a shared action verb.
 */
export function subjectsOverlap(a: string, b: string): boolean {
  const wordsA = canonicalWords(normalizeSubject(a))
  const wordsB = canonicalWords(normalizeSubject(b))
  if (wordsA.size === 0 || wordsB.size === 0) return false

  // Check 1: word-level overlap ≥50%
  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }
  const minSize = Math.min(wordsA.size, wordsB.size)
  if (overlap / minSize >= 0.5) return true

  // Check 2: shared domain with domain-word density check
  const domainsA = classifyDomains(wordsA)
  const domainsB = classifyDomains(wordsB)
  for (const domain of domainsA) {
    if (!domainsB.has(domain)) continue

    let countA = 0
    let countB = 0
    for (const w of wordsA) if (DOMAIN_MAP.get(w) === domain) countA++
    for (const w of wordsB) if (DOMAIN_MAP.get(w) === domain) countB++

    const ratioA = countA / wordsA.size
    const ratioB = countB / wordsB.size
    if (ratioA >= 0.5 && ratioB >= 0.5) return true

    // Check if verbs are in the same workflow pipeline
    const verbA = extractVerb(wordsA)
    const verbB = extractVerb(wordsB)
    if (verbA && verbB && sameWorkflowPipeline(verbA, verbB)) return true

    // Fallback: shared action verb
    for (const w of wordsA) {
      if (ACTION_VERBS.has(w) && wordsB.has(w)) return true
    }
  }

  return false
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

export function computeSubjectFingerprint(subject: string): string {
  const words = [...canonicalWords(normalizeSubject(subject))].sort()
  const canonical = words.join(" ")
  return Bun.hash(canonical).toString(16).padStart(16, "0")
}
