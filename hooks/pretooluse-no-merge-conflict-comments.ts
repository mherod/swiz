#!/usr/bin/env bun
// PreToolUse hook: Block low-signal PR comments about merge conflicts.
// Detects gh pr comment / gh pr review --comment / gh api POST-to-comments calls
// whose body content consists only of merge-conflict or rebase-request noise, and
// denies them.  The project has dedicated local remediation paths for conflict state
// (stop-branch-conflicts.ts, /rebase-onto-main) that avoid public noise.

import {
  allowPreToolUse,
  denyPreToolUse,
  isShellTool,
  skillAdvice,
} from "../src/utils/hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
if (!isShellTool(toolName)) process.exit(0)

const command: string = input.tool_input?.command ?? ""

const GH_PR_COMMENT_RE = /\bgh\s+pr\s+comment\b/
const GH_PR_REVIEW_COMMENT_RE = /\bgh\s+pr\s+review\b.*--comment\b/
// gh api repos/{owner}/{repo}/issues/{number}/comments  (POST)
// gh api repos/{owner}/{repo}/pulls/{number}/comments   (POST)
const GH_API_ISSUE_COMMENT_RE = /\bgh\s+api\b.*\/(?:issues|pulls)\/\d+\/comments\b/

const isPrComment = GH_PR_COMMENT_RE.test(command)
const isPrReviewComment = GH_PR_REVIEW_COMMENT_RE.test(command)
const isApiComment = GH_API_ISSUE_COMMENT_RE.test(command)
if (!isPrComment && !isPrReviewComment && !isApiComment) process.exit(0)

// Extract body text from the command.
// For gh pr comment / gh pr review --comment: --body / -b flags
// For gh api: --field body=<value> or --input <file> (file-based input is opaque, skip)
function extractBody(cmd: string): string | null {
  // --field body="..." or --field body='...' or --field body=value
  const fieldMatch =
    cmd.match(/--field\s+body="((?:[^"\\]|\\.)*)"/s) ??
    cmd.match(/--field\s+body='([^']*)'/s) ??
    cmd.match(/--field\s+body=(\S+)/)
  if (fieldMatch) return fieldMatch[1] ?? null

  // --body / -b flags (used by gh pr comment and gh pr review)
  const bodyMatch =
    cmd.match(/(?:--body|-b)\s+"((?:[^"\\]|\\.)*)"/s) ??
    cmd.match(/(?:--body|-b)\s+'([^']*)'/s) ??
    cmd.match(/(?:--body|-b)\s+(\S+)/)
  if (bodyMatch) return bodyMatch[1] ?? null

  return null
}

const body = extractBody(command)
if (body === null) process.exit(0)

// NFKC-normalize before pattern matching (required by nfkc-enforcement.test.ts)
const bodyNormalized = body.normalize("NFKC").toLowerCase()

// Phrases that indicate the comment is purely about merge-conflict / rebase state
const NOISE_PHRASES: RegExp[] = [
  /merge\s*conflict/,
  /please\s+rebase/,
  /rebase\s+(?:your\s+)?branch/,
  /resolve\s+(?:the\s+)?merge\s+conflict/,
  /needs?\s+(?:a\s+)?rebase/,
  /has\s+merge\s+conflict/,
  /conflicting\s+change/,
  /branch\s+is\s+(?:behind|outdated|conflicting)/,
  /before\s+(?:it\s+can\s+be\s+)?merged/,
  /rebase\s+(?:it\s+)?(?:onto|on)\s+main/,
  /bring\s+(?:it\s+)?up\s+to\s+date/,
]

// First check: the body must contain at least one conflict signal
const hasMergeConflictSignal = NOISE_PHRASES.some((re) => re.test(bodyNormalized))
if (!hasMergeConflictSignal) allowPreToolUse("Comment has no merge-conflict signals")

// Second check: split the body into sentence fragments and verify ALL lines
// are either blank/trivial or match a noise phrase. If the body contains
// substantive content beyond the conflict notice, allow it through.
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  // Greetings / closings / very short fragments are noise
  if (trimmed.length <= 15) return true
  return NOISE_PHRASES.some((re) => re.test(trimmed))
}

const lines = bodyNormalized
  .split(/[\n.!?]/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0)

// If no parseable lines (e.g. very short body), still block — signal was found above
const allNoise = lines.length === 0 || lines.every(isNoiseLine)
if (!allNoise) allowPreToolUse("Comment contains substantive content beyond conflict notice")

const rebaseAdvice = skillAdvice(
  "rebase-onto-main",
  "Use the /rebase-onto-main skill to automatically rebase the branch.",
  [
    `Rebase the branch to resolve conflicts:`,
    `  git fetch origin`,
    `  git rebase origin/main`,
    `  # if conflicts arise: fix files, git add <file>, git rebase --continue`,
    `  git push --force-with-lease`,
  ].join("\n")
)

denyPreToolUse(
  [
    "Do not post a PR comment whose only content is a merge-conflict/rebase notice.",
    "",
    "This adds no value beyond what GitHub already shows and generates notification noise.",
    "The project already has local remediation paths for conflict state:",
    "",
    "  • stop-branch-conflicts.ts — provides rebase guidance at stop time (local only)",
    `  • ${rebaseAdvice}`,
    "",
    "If the PR needs substantive review feedback in addition to the rebase note,",
    "include that feedback and omit the generic conflict notice.",
  ].join("\n")
)
