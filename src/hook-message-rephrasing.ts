import { escapeRegex as escapeRegExp } from "./utils/shell-patterns"

type RephraseRule = readonly [string, readonly string[]]

const REPHRASE_WINDOW_MS = 5 * 60 * 1000

const REPHRASE_RULES = [
  ["warning", ["heads-up", "notice", "alert", "caution", "signal"]],
  ["don't", ["avoid", "refrain from", "skip", "steer clear of", "leave out"]],
  ["do not", ["avoid", "refrain from", "skip", "steer clear of", "leave out"]],
  ["aim for", ["target", "work toward", "go for", "seek", "strive for", "try to"]],
  ["try to", ["attempt to", "work toward", "aim to", "seek to", "strive to", "go for"]],
  ["we should", ["we ought to", "we could", "let's", "it may help to", "we might", "we can"]],
  ["we must", ["we need to", "we have to", "we are required to", "we're obliged to", "we need to"]],
  [
    "we can try to",
    [
      "we can attempt to",
      "we might try to",
      "we can aim to",
      "we can work toward",
      "we could try to",
    ],
  ],
  [
    "what are we working on?",
    [
      "what's the current focus?",
      "what should we tackle?",
      "what's on deck?",
      "what's the next focus?",
      "where should we start?",
    ],
  ],
  [
    "what are we currently working on?",
    [
      "what's the current focus?",
      "what are we handling now?",
      "what's currently in focus?",
      "what's the immediate focus?",
      "what's on deck?",
    ],
  ],
  [
    "what should we do next?",
    [
      "what's next?",
      "what should come next?",
      "what's the next step?",
      "what should we tackle next?",
      "where do we go from here?",
    ],
  ],
  [
    "create tasks before starting implementation.",
    [
      "set up tasks before starting implementation.",
      "create tasks before you begin implementation.",
      "add tasks before implementation starts.",
      "make tasks before starting implementation.",
      "prepare tasks before coding.",
    ],
  ],
  ["continue in", ["stay in", "remain in", "keep going in", "proceed in", "carry on in"]],
  ["need to", ["have to", "must", "ought to", "are required to", "should"]],
  ["have to", ["need to", "must", "ought to", "are required to", "should"]],
  ["make sure to", ["be sure to", "remember to", "take care to", "confirm", "double-check"]],
  ["ensure", ["make sure", "confirm", "verify", "guarantee", "secure"]],
  ["check", ["inspect", "review", "verify", "scan", "look at"]],
  ["verify", ["confirm", "check", "validate", "double-check", "reconfirm"]],
  [
    "add one more",
    ["add another", "add one extra", "add one additional", "include one more", "add a further"],
  ],
  ["claim", ["take on", "pick up", "own", "accept", "handle"]],
  ["assign", ["allocate", "designate", "set", "route", "place"]],
  ["stay", ["remain", "keep", "stick", "persist", "linger"]],
  ["remain", ["stay", "keep", "persist", "hold", "stick"]],
  ["allowed", ["permitted", "approved", "accepted", "authorized", "enabled"]],
  ["approved", ["authorized", "accepted", "cleared", "sanctioned", "permitted"]],
  ["action plan", ["plan of action", "roadmap", "next steps", "game plan", "course of action"]],
  ["plan of action", ["action plan", "roadmap", "next steps", "game plan", "course of action"]],
  [
    "create another",
    ["make another", "create one more", "add another", "set up another", "spin up another"],
  ],
  [
    "will continue automatically",
    [
      "will keep going automatically",
      "will proceed automatically",
      "will carry on automatically",
      "will resume automatically",
      "will move on automatically",
    ],
  ],
  [
    "continue automatically",
    [
      "keep going automatically",
      "proceed automatically",
      "carry on automatically",
      "resume automatically",
      "move on automatically",
    ],
  ],
  [
    "before continuing",
    [
      "before moving on",
      "before proceeding",
      "before keeping going",
      "before pressing on",
      "before moving forward",
    ],
  ],
  ["continue", ["keep going", "proceed", "carry on", "move on", "press on"]],
  ["good", ["brilliant", "perfect", "satisfactory", "excellent", "solid", "sound"]],
  ["hygiene", ["practice", "regulation", "discipline", "routine", "stewardship"]],
  ["important", ["essential", "critical", "key", "significant", "notable", "major"]],
  ["current", ["present", "ongoing", "live", "existing", "latest", "up-to-date"]],
  ["active", ["ongoing", "live", "engaged", "open", "current", "running"]],
  ["healthy", ["sound", "robust", "steady", "balanced", "stable", "capable"]],
  ["clear", ["explicit", "precise", "plain", "obvious", "distinct", "transparent"]],
  ["specific", ["precise", "particular", "exact", "detailed", "definite", "clear"]],
  ["useful", ["helpful", "practical", "valuable", "effective", "serviceable", "worthwhile"]],
  ["focused", ["intentional", "concentrated", "disciplined", "tight", "direct", "singular"]],
  ["stable", ["steady", "sound", "firm", "secure", "balanced", "solid"]],
  ["ready", ["prepared", "set", "primed", "poised", "good to go", "all set"]],
  ["possible", ["feasible", "doable", "achievable", "realistic", "viable"]],
  ["likely", ["probable", "plausible", "expected", "apt", "predictable"]],
  ["simple", ["straightforward", "basic", "plain", "clean", "easy"]],
  ["better", ["improved", "stronger", "more effective", "superior", "finer"]],
  ["hard", ["difficult", "tough", "challenging", "tricky", "demanding"]],
  ["problem", ["issue", "concern", "matter", "risk", "snag"]],
  ["requires", ["needs", "demands", "calls for", "expects", "asks for", "warrants"]],
  ["enforces", ["upholds", "backs", "supports", "drives", "reinforces", "applies"]],
  ["overwhelm", ["flood", "swamp", "bury", "drown", "strain", "overtake"]],
  ["overload", ["burden", "strain", "flood", "swamp", "tax", "load"]],
  ["catch", ["spot", "find", "grab", "flag", "notice", "pick up"]],
  ["catches", ["spots", "finds", "grabs", "flags", "notices", "picks up"]],
  ["detect", ["flag", "spot", "find", "identify", "notice", "pick up"]],
  ["detects", ["flags", "spots", "finds", "identifies", "notices", "picks up"]],
  ["plan", ["strategy", "approach", "outline", "roadmap", "scheme", "design"]],
  ["progress", ["advance", "headway", "movement", "momentum", "gain", "leeway"]],
  ["poor", ["concerning", "risky", "troubling", "suboptimal", "weak"]],
  ["concerning", ["poor", "risky", "troubling", "suboptimal", "weak"]],
  ["risky", ["poor", "concerning", "troubling", "suboptimal", "weak"]],
] as const satisfies readonly RephraseRule[]

const REPHRASE_LOOKUP = new Map<string, readonly string[]>()
for (const [match, replacements] of REPHRASE_RULES) {
  REPHRASE_LOOKUP.set(match, replacements)
}

const REPHRASE_PATTERN = new RegExp(
  REPHRASE_RULES.map(([match]) => `(?<![\\w-])${escapeRegExp(match)}(?![\\w-])`).join("|"),
  "gi"
)

const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g

function preserveCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase()

  const first = original.at(0)
  if (
    first &&
    first === first.toUpperCase() &&
    original.slice(1) === original.slice(1).toLowerCase()
  ) {
    return replacement[0]!.toUpperCase() + replacement.slice(1)
  }

  return replacement
}

function chooseReplacement(
  match: string,
  replacements: readonly string[],
  randomSource: () => number
): string {
  const picked = replacements[Math.floor(randomSource() * replacements.length)]!
  return preserveCase(match, picked)
}

function stableSeed(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
  }
  return hash >>> 0
}

export function selectStableHookVariant<T>(
  key: string,
  variants: readonly T[],
  nowMs = Date.now()
): T {
  if (variants.length === 0) {
    throw new Error("selectStableHookVariant requires at least one variant")
  }
  const windowKey = Math.floor(nowMs / REPHRASE_WINDOW_MS)
  const seed = stableSeed(`${windowKey}\0${key}`)
  return variants[seed % variants.length]!
}

function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function createWindowedRandomSource(text: string, nowMs = Date.now()): () => number {
  const windowKey = Math.floor(nowMs / REPHRASE_WINDOW_MS)
  return makeSeededRandom(stableSeed(`${windowKey}\0${text}`))
}

export function rephraseHookMessage(text: string, randomSource?: () => number): string {
  const source = randomSource ?? createWindowedRandomSource(text)
  return text
    .split(CODE_SEGMENT_RE)
    .map((segment) => {
      if (segment.startsWith("`")) return segment
      return segment.replace(REPHRASE_PATTERN, (match) => {
        const replacements = REPHRASE_LOOKUP.get(match.toLowerCase())
        if (!replacements) return match
        return chooseReplacement(match, replacements, source)
      })
    })
    .join("")
}
