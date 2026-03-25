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
  // run / execute / invoke → run
  ["execute", "run"],
  ["invoke", "run"],
  // changes / diff / modifications → changes
  ["diff", "changes"],
  ["modifications", "changes"],
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
 * Lightweight suffix-stripping stemmer for task-domain English.
 * Reduces inflected forms to a common root so "committing" and "commit",
 * "verifying" and "verify", "formatted" and "format" match.
 */
export function stemWord(word: string): string {
  const irregular = IRREGULAR_STEMS.get(word)
  if (irregular) return irregular
  return collapseDoubledConsonant(applySuffixRules(word))
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

/**
 * Two subjects overlap if they share ≥50% of their significant words.
 * This catches cases like "Push backward-compat error commit" vs
 * "Push backward-compat commit" without false-positiving on unrelated tasks.
 */
export function subjectsOverlap(a: string, b: string): boolean {
  const wordsA = significantWords(a)
  const wordsB = significantWords(b)
  if (wordsA.size === 0 || wordsB.size === 0) return false
  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }
  const minSize = Math.min(wordsA.size, wordsB.size)
  return overlap / minSize >= 0.5
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

export function computeSubjectFingerprint(subject: string): string {
  const normalized = subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const words = normalized
    .split(" ")
    .filter((w) => w.length > 2 && !FINGERPRINT_STOP_WORDS.has(w))
    .map((w) => {
      const stemmed = stemWord(w)
      // Try stem directly, then with silent-e restored (creat→create)
      return SYNONYM_MAP.get(stemmed) ?? SYNONYM_MAP.get(`${stemmed}e`) ?? stemmed
    })
    .sort()
  const canonical = words.join(" ")
  return Bun.hash(canonical).toString(16).padStart(16, "0")
}
