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

/**
 * Lightweight suffix-stripping stemmer for task-domain English.
 * Reduces inflected forms to a common root so "committing" and "commit",
 * "verifying" and "verify", "formatted" and "format" match.
 */
export function stemWord(word: string): string {
  // Check irregular forms first (can't be suffix-stripped)
  const irregular = IRREGULAR_STEMS.get(word)
  if (irregular) return irregular

  let stem = word
  // Order matters: try longest suffixes first

  // -ing forms: strip suffix, reconstruct final consonant
  if (word.endsWith("ting") && word.length > 5) stem = word.slice(0, -4) + "t"
  else if (word.endsWith("ning") && word.length > 5) stem = word.slice(0, -4) + "n"
  else if (word.endsWith("ring") && word.length > 5) stem = word.slice(0, -4) + "r"
  else if (word.endsWith("ling") && word.length > 5) stem = word.slice(0, -4) + "l"
  else if (word.endsWith("ying") && word.length > 5) stem = word.slice(0, -4) + "y"
  else if (word.endsWith("ding") && word.length > 5) stem = word.slice(0, -4) + "d"
  else if (word.endsWith("ping") && word.length > 5) stem = word.slice(0, -4) + "p"
  else if (word.endsWith("sing") && word.length > 5) stem = word.slice(0, -4) + "s"
  else if (word.endsWith("zing") && word.length > 5) stem = word.slice(0, -4) + "z"
  else if (word.endsWith("bing") && word.length > 5) stem = word.slice(0, -4) + "b"
  else if (word.endsWith("ming") && word.length > 5) stem = word.slice(0, -4) + "m"
  else if (word.endsWith("king") && word.length > 5) stem = word.slice(0, -4) + "k"
  else if (word.endsWith("ing") && word.length > 5) stem = word.slice(0, -3)
  // -ation before -tion (implementation → implement)
  else if (word.endsWith("ation") && word.length > 7) stem = word.slice(0, -5)
  else if (word.endsWith("tion") && word.length > 5) stem = word.slice(0, -4)
  // -ment: require > 9 chars to avoid stripping root words (implement, comment)
  else if (word.endsWith("ment") && word.length > 9) stem = word.slice(0, -4)
  else if (word.endsWith("ated") && word.length > 5) stem = word.slice(0, -2)
  else if (word.endsWith("ized") && word.length > 5) stem = word.slice(0, -2)
  // -ed forms: strip suffix, reconstruct final consonant
  else if (word.endsWith("ted") && word.length > 5) stem = word.slice(0, -3) + "t"
  else if (word.endsWith("ned") && word.length > 5) stem = word.slice(0, -3) + "n"
  else if (word.endsWith("red") && word.length > 5) stem = word.slice(0, -3) + "r"
  else if (word.endsWith("led") && word.length > 5) stem = word.slice(0, -3) + "l"
  else if (word.endsWith("sed") && word.length > 5) stem = word.slice(0, -3) + "s"
  else if (word.endsWith("ped") && word.length > 5) stem = word.slice(0, -3) + "p"
  else if (word.endsWith("zed") && word.length > 5) stem = word.slice(0, -3) + "z"
  else if (word.endsWith("bed") && word.length > 5) stem = word.slice(0, -3) + "b"
  else if (word.endsWith("med") && word.length > 5) stem = word.slice(0, -3) + "m"
  else if (word.endsWith("ked") && word.length > 5) stem = word.slice(0, -3) + "k"
  // -ied → -y (verified → verify, modified → modify)
  else if (word.endsWith("ied") && word.length > 5) stem = word.slice(0, -3) + "y"
  else if (word.endsWith("ed") && word.length > 4) stem = word.slice(0, -2)
  else if (word.endsWith("ly") && word.length > 4) stem = word.slice(0, -2)
  else if (word.endsWith("er") && word.length > 4) stem = word.slice(0, -2)
  else if (word.endsWith("es") && word.length > 4) stem = word.slice(0, -2)
  else if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) stem = word.slice(0, -1)

  // Collapse doubled trailing consonants (committ → commit, formatt → format)
  if (stem.length >= 4 && stem[stem.length - 1] === stem[stem.length - 2]) {
    const ch = stem[stem.length - 1]!
    if (ch >= "a" && ch <= "z" && !"aeiou".includes(ch)) {
      stem = stem.slice(0, -1)
    }
  }

  return stem
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
      return SYNONYM_MAP.get(stemmed) ?? SYNONYM_MAP.get(stemmed + "e") ?? stemmed
    })
    .sort()
  const canonical = words.join(" ")
  return Bun.hash(canonical).toString(16).padStart(16, "0")
}
