import type { Command } from "../types.ts"

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

// ─── Pattern clusters ─────────────────────────────────────────────────────────
//
// Weights are in the range [-1, +1]. Each match contributes its weight to a
// running raw score that is later clamped and normalised.
//
// Patterns were derived from analysis of real PR review comments in a
// production GitHub repository (RaptorMarketing/ramp3-spike) covering ≈900
// PRs and issues, spanning automated bot reviews, human inline comments, and
// triage notes.

interface Pattern {
  re: RegExp
  weight: number
  label: string
}

// Approval signals ─────────────────────────────────────────────────────────────

const APPROVAL_PATTERNS: Pattern[] = [
  // Explicit bot/human verdict stamps — highest signal
  {
    re: /✅\s*\*{0,2}Approved\*{0,2}/i,
    weight: 0.8,
    label: "explicit approval stamp",
  },
  {
    re: /^Approved\s*[—–\-:]/m,
    weight: 0.72,
    label: "approval verdict (start of line)",
  },
  {
    re: /\bApproved\b.*\bCI\s+passes\b/i,
    weight: 0.65,
    label: "approval + CI green",
  },

  // CI / build green
  {
    re: /\bAll\s+CI\s+checks\s+(?:pass(?:ed)?|green)\b/i,
    weight: 0.45,
    label: "all CI checks pass",
  },
  {
    re: /(?<!until )\bCI\s+(?:passes|passed|is green|green)\b/i,
    weight: 0.4,
    label: "CI passes",
  },
  {
    re: /\bAll\s+checks\s+(?:are\s+)?(?:pass(?:ing|ed)?|green)\b/i,
    weight: 0.4,
    label: "all checks pass",
  },
  {
    re: /\ball\s+(?:checks?\s+)?now\s+green\b/i,
    weight: 0.4,
    label: "all checks now green",
  },
  {
    re: /\bCI\s+(?:pass(?:es|ed)|green)\b.*\(lint,?\s+typecheck/i,
    weight: 0.35,
    label: "CI passes (lint/typecheck detail)",
  },

  // Merge readiness
  { re: /\bsafe to merge\b/i, weight: 0.5, label: "safe to merge" },
  {
    re: /\bready for (?:review|merge)\b/i,
    weight: 0.35,
    label: "ready for review/merge",
  },
  {
    re: /\bready for implementation\b/i,
    weight: 0.3,
    label: "ready for implementation",
  },
  {
    re: /\bStale\b.*\breviews?\s+dismissed\b.*\bReady\b/i,
    weight: 0.8,
    label: "stale review dismissed, now ready",
  },

  // Feedback loop closed
  {
    re: /\ball\s+(?:review\s+)?feedback\s+(?:has\s+been\s+)?addressed\b/i,
    weight: 0.4,
    label: "all feedback addressed",
  },
  {
    re: /\ball\s+review\s+feedback\s+h(?:as|ave)\s+been\s+addressed\b/i,
    weight: 0.4,
    label: "all feedback addressed",
  },

  // Quality endorsements
  {
    re: /\bimplementation\s+is\s+solid\b/i,
    weight: 0.3,
    label: "implementation solid",
  },
  {
    re: /\bwell.(?:implemented|structured|scoped|specified)\b/i,
    weight: 0.25,
    label: "well-[word] quality stamp",
  },
  { re: /\bno\s+issues\s+found\b/i, weight: 0.35, label: "no issues found" },
  {
    re: /\boverall\s+implementation\s+is\b/i,
    weight: 0.15,
    label: "overall implementation endorsed",
  },
  {
    re: /\b(?:clean|correct),\s*(?:minimal|backwards.compatible|correct)\b/i,
    weight: 0.2,
    label: "clean + qualifier",
  },
  { re: /\bidiomatic\b/i, weight: 0.12, label: "idiomatic code" },
  { re: /\bbackwards.compatible\b/i, weight: 0.12, label: "backwards-compatible" },
  {
    re: /\bstrictly\s+correct\b/i,
    weight: 0.2,
    label: "strictly correct",
  },
  {
    re: /\bsemantics\s+are\s+(?:correct|equivalent)\b/i,
    weight: 0.18,
    label: "semantics correct",
  },

  // Correctness affirmations (low weight, additive)
  { re: /\bcorrectly\b/gi, weight: 0.04, label: "correctly (×N)" },
  {
    re: /\bno\s+logic\s+changes?\b/i,
    weight: 0.2,
    label: "no logic changes",
  },

  // Issue triage positive signals
  {
    re: /\b[Ww]ell.specified\b/,
    weight: 0.2,
    label: "well-specified (issue quality)",
  },
  {
    re: /\bNo\s+missing\s+information\b/i,
    weight: 0.18,
    label: "no missing info",
  },
  {
    re: /\bNo\s+duplicates?\s+found\b/i,
    weight: 0.12,
    label: "no duplicates",
  },
]

// Rejection signals ────────────────────────────────────────────────────────────

const REJECTION_PATTERNS: Pattern[] = [
  // Explicit blocking
  {
    re: /CHANGES_REQUESTED/,
    weight: -0.75,
    label: "CHANGES_REQUESTED review state",
  },
  {
    re: /\bUnmet\s+Acceptance\s+Criterion\b/i,
    weight: -0.72,
    label: "unmet acceptance criterion",
  },
  {
    re: /\bblocking\s+issues?\b/i,
    weight: -0.5,
    label: "blocking issues",
  },
  {
    re: /(?<!neither )(?<!not )\b(?:is|remains?|this\s+is)\s+a\s+blocker\b/i,
    weight: -0.4,
    label: "is/remains a blocker",
  },
  {
    re: /\bUnmet\b.*\bblocker\b/i,
    weight: -0.35,
    label: "unmet blocker condition",
  },

  // CI failure
  {
    re: /\bCI\s+(?:Failure|fail(?:ing|ed))\b/i,
    weight: -0.65,
    label: "CI failure",
  },
  {
    re: /\bCI\s+is\s+fail(?:ing|ed)\b/i,
    weight: -0.6,
    label: "CI failing",
  },
  {
    re: /\b(?:checks?|build|lint|typecheck)\s+(?:is\s+)?fail(?:ing|ed)\b/i,
    weight: -0.5,
    label: "checks/build failing",
  },
  {
    re: /\bfails?\s+(?:due\s+to|because\s+of)\b/i,
    weight: -0.4,
    label: "fails due to",
  },

  // Missing requirements
  {
    re: /\bare\s+missing\s+from\s+this\s+PR\b/i,
    weight: -0.45,
    label: "missing from PR",
  },
  {
    re: /\bmissing\s+from\s+this\s+PR\b/i,
    weight: -0.4,
    label: "missing from PR",
  },
  {
    re: /\bno\s+tests?\s+(?:for|were|have been|added)\b/i,
    weight: -0.3,
    label: "no tests added",
  },
  {
    re: /\btests?\s+must\s+cover\b/i,
    weight: -0.35,
    label: "tests must cover",
  },
  {
    re: /\bmust\s+be\s+(?:fixed|addressed|resolved)\b/i,
    weight: -0.3,
    label: "must be fixed",
  },

  // Gate conditions
  {
    re: /\bbefore\s+(?:this\s+)?(?:can|could)\s+be\s+merged\b/i,
    weight: -0.4,
    label: "before can be merged",
  },
  {
    re: /\bcan(?:not|'t)\s+be\s+merged\b/i,
    weight: -0.45,
    label: "cannot be merged",
  },
  {
    re: /\bVerify\s+CI\s+passes\b/i,
    weight: -0.2,
    label: "verify CI passes (pending)",
  },
  {
    re: /\bre.request\s+review\b/i,
    weight: -0.25,
    label: "re-request review",
  },

  // Bot deferral / ambiguous verdict
  {
    re: /\bHuman\s+reviewer\s+should\s+check\b/i,
    weight: -0.25,
    label: "human review needed",
  },
  {
    re: /\bReview\s+verdict\s+missing\b/i,
    weight: -0.2,
    label: "review verdict missing",
  },
  {
    re: /\bAuto.requested\s+changes\b/i,
    weight: -0.4,
    label: "auto-requested changes",
  },
]

// Hedging patterns — these reduce the magnitude of nearby negative signals ─────

const HEDGING_PATTERNS: Pattern[] = [
  // Explicit non-blocker declarations
  {
    re: /\bnon.blocking\b/i,
    weight: 0.2,
    label: "non-blocking (reduces negatives)",
  },
  {
    re: /\bneither\s+is\s+a\s+blocker\b/i,
    weight: 0.22,
    label: "neither is a blocker",
  },
  {
    re: /\bnot\s+a\s+(?:blocker|regression)\b/i,
    weight: 0.18,
    label: "not a blocker/regression",
  },
  {
    re: /\bminor\s+enough\s+not\s+to\s+block\b/i,
    weight: 0.2,
    label: "minor enough not to block",
  },

  // Deferral
  {
    re: /\bfor\s+(?:a\s+)?follow.up\b/i,
    weight: 0.12,
    label: "deferred to follow-up",
  },
  {
    re: /\bin\s+a\s+follow.up\b/i,
    weight: 0.1,
    label: "in a follow-up",
  },

  // Soft suggestions
  {
    re: /\bConsider\b/gi,
    weight: 0.04,
    label: "Consider (soft suggestion, ×N)",
  },
  {
    re: /\bworth\s+(?:noting|cleaning\s+up|considering|revisiting)\b/i,
    weight: 0.06,
    label: "worth noting (observation)",
  },
  {
    re: /\bharmless\s+but\b/i,
    weight: 0.1,
    label: "harmless but (downplayed)",
  },
  {
    re: /\bNot\s+a\s+regression\b/i,
    weight: 0.15,
    label: "not a regression",
  },
]

// ─── Scoring engine ───────────────────────────────────────────────────────────

interface Match {
  label: string
  weight: number
  count: number
}

function collectMatches(text: string, patterns: Pattern[]): Match[] {
  const matches: Match[] = []
  for (const { re, weight, label } of patterns) {
    const flags = re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g")
    const hits = [...text.matchAll(flags)]
    if (hits.length > 0) {
      // For repeating patterns (correctly, Consider) count individually; others cap at 1
      const isRepeating = re.flags.includes("g") && Math.abs(weight) < 0.15
      const count = isRepeating ? hits.length : 1
      matches.push({ label, weight, count })
    }
  }
  return matches
}

// Check whether a negative match is contextually hedged by proximity to a
// hedging phrase within a 200-char window (before or after). If so, halve its
// effective weight.
function hedgingDampFactor(text: string): number {
  const hedgeRe = /\bnon.blocking\b|\bneither is a blocker\b|\bnot a blocker\b|\bfor (?:a )?follow.up\b|\bin a follow.up\b|\bminor enough not to block\b/gi
  const hedgeHits = [...text.matchAll(hedgeRe)]
  if (hedgeHits.length === 0) return 1.0
  // Ratio: more hedges relative to text length means more dampening
  const hedgeDensity = hedgeHits.length / Math.max(1, text.split(/\s+/).length / 100)
  return Math.max(0.4, 1.0 - hedgeDensity * 0.25)
}

export function scoreSentiment(text: string): {
  score: number
  approvalMatches: Match[]
  rejectionMatches: Match[]
  hedgingMatches: Match[]
} {
  const approvalMatches = collectMatches(text, APPROVAL_PATTERNS)
  const rejectionMatches = collectMatches(text, REJECTION_PATTERNS)
  const hedgingMatches = collectMatches(text, HEDGING_PATTERNS)

  const dampFactor = hedgingDampFactor(text)

  let raw = 0
  for (const m of approvalMatches) raw += m.weight * m.count
  for (const m of rejectionMatches) raw += m.weight * m.count * dampFactor
  for (const m of hedgingMatches) raw += m.weight * m.count

  // Clamp to [-1, +1]
  const score = Math.max(-1, Math.min(1, raw))
  return { score, approvalMatches, rejectionMatches, hedgingMatches }
}

// ─── Output formatting ────────────────────────────────────────────────────────

function verdict(score: number): { label: string; color: string } {
  if (score >= 0.5) return { label: "APPROVED", color: GREEN }
  if (score >= 0.2) return { label: "LIKELY APPROVED", color: CYAN }
  if (score >= -0.2) return { label: "NEUTRAL", color: YELLOW }
  if (score >= -0.5) return { label: "LIKELY REJECTED", color: YELLOW }
  return { label: "REJECTED", color: RED }
}

function bar(score: number, width = 30): string {
  const mid = Math.floor(width / 2)
  const chars = Array(width).fill("─")
  chars[mid] = "┼"
  const pos = Math.round(((score + 1) / 2) * (width - 1))
  chars[pos] = score >= 0 ? "▶" : "◀"
  return chars.join("")
}

function printMatches(matches: Match[], color: string, sign: string): void {
  for (const m of matches) {
    const weightStr = `${sign}${Math.abs(m.weight * m.count).toFixed(2)}`
    const countNote = m.count > 1 ? ` ×${m.count}` : ""
    console.log(
      `  ${color}${weightStr.padStart(6)}${RESET}  ${DIM}${m.label}${countNote}${RESET}`
    )
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const sentimentCommand: Command = {
  name: "sentiment",
  description: "Score text for approval/rejection sentiment using heuristic regex clusters",
  usage: "swiz sentiment [text]\n       echo 'text' | swiz sentiment",
  options: [
    { flags: "--json", description: "Output result as JSON" },
    { flags: "--score-only", description: "Print only the numeric score" },
  ],

  async run(args: string[]) {
    const jsonMode = args.includes("--json")
    const scoreOnly = args.includes("--score-only")
    const filteredArgs = args.filter((a) => !a.startsWith("--"))

    let text: string

    if (filteredArgs.length > 0) {
      text = filteredArgs.join(" ")
    } else if (!process.stdin.isTTY) {
      text = await Bun.stdin.text()
    } else {
      throw new Error(
        "No input provided. Pass text as an argument or pipe via stdin.\n" +
          "  swiz sentiment 'LGTM, CI passes. Safe to merge.'\n" +
          "  echo 'text' | swiz sentiment"
      )
    }

    const { score, approvalMatches, rejectionMatches, hedgingMatches } = scoreSentiment(text)
    const { label, color } = verdict(score)

    if (scoreOnly) {
      console.log(score.toFixed(4))
      return
    }

    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            score,
            label,
            approval: approvalMatches.map((m) => ({ label: m.label, weight: m.weight, count: m.count })),
            rejection: rejectionMatches.map((m) => ({ label: m.label, weight: m.weight, count: m.count })),
            hedging: hedgingMatches.map((m) => ({ label: m.label, weight: m.weight, count: m.count })),
          },
          null,
          2
        )
      )
      return
    }

    const scoreStr = (score >= 0 ? "+" : "") + score.toFixed(3)
    console.log()
    console.log(
      `  ${BOLD}Score: ${color}${scoreStr}${RESET}  ${BOLD}${color}${label}${RESET}`
    )
    console.log(`  ${DIM}${bar(score)}${RESET}`)
    console.log()

    if (approvalMatches.length > 0) {
      console.log(`  ${GREEN}Approval signals${RESET}`)
      printMatches(approvalMatches, GREEN, "+")
      console.log()
    }

    if (rejectionMatches.length > 0) {
      console.log(`  ${RED}Rejection signals${RESET}`)
      printMatches(rejectionMatches, RED, "-")
      console.log()
    }

    if (hedgingMatches.length > 0) {
      console.log(`  ${YELLOW}Hedging / context${RESET}`)
      printMatches(hedgingMatches, YELLOW, "+")
      console.log()
    }
  },
}
