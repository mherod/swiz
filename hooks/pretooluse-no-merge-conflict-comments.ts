#!/usr/bin/env bun
/**
 * PreToolUse hook: Block low-signal PR comments about merge conflicts.
 * Detects gh pr comment / gh pr review --comment / gh api POST-to-comments calls
 * whose body content consists only of merge-conflict or rebase-request noise, and
 * denies them. The project has dedicated local remediation paths for conflict state
 * (stop-branch-conflicts.ts, /rebase-onto-main) that avoid public noise.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import type { ShellHookInput } from "./schemas.ts"

const GH_PR_COMMENT_RE = /\bgh\s+pr\s+comment\b/
const GH_PR_REVIEW_COMMENT_RE = /\bgh\s+pr\s+review\b.*--comment\b/
const GH_API_ISSUE_COMMENT_RE = /\bgh\s+api\b.*\/(?:issues|pulls)\/\d+\/comments\b/

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

/** Extract body text from gh pr comment / gh pr review / gh api commands. */
function extractBody(cmd: string): string | null {
  const fieldMatch =
    cmd.match(/--field\s+body="((?:[^"\\]|\\.)*)"/s) ??
    cmd.match(/--field\s+body='([^']*)'/s) ??
    cmd.match(/--field\s+body=(\S+)/)
  if (fieldMatch) return fieldMatch[1] ?? null

  const bodyMatch =
    cmd.match(/(?:--body|-b)\s+"((?:[^"\\]|\\.)*)"/s) ??
    cmd.match(/(?:--body|-b)\s+'([^']*)'/s) ??
    cmd.match(/(?:--body|-b)\s+(\S+)/)
  if (bodyMatch) return bodyMatch[1] ?? null

  return null
}

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  if (trimmed.length <= 15) return true
  return NOISE_PHRASES.some((re) => re.test(trimmed))
}

function isCommentCommand(command: string): boolean {
  return (
    GH_PR_COMMENT_RE.test(command) ||
    GH_PR_REVIEW_COMMENT_RE.test(command) ||
    GH_API_ISSUE_COMMENT_RE.test(command)
  )
}

function isPureNoise(bodyNormalized: string): boolean {
  const lines = bodyNormalized
    .split(/[\n.!?]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  return lines.length === 0 || lines.every(isNoiseLine)
}

function evaluate(input: ShellHookInput) {
  // In standalone mode the matcher isn't applied, so guard on tool name.
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = input.tool_input?.command ?? ""
  if (!isCommentCommand(command)) return {}

  const body = extractBody(command)
  if (body === null) return {}

  // NFKC-normalize before pattern matching
  const bodyNormalized = body.normalize("NFKC").toLowerCase()

  const hasMergeConflictSignal = NOISE_PHRASES.some((re) => re.test(bodyNormalized))
  if (!hasMergeConflictSignal) return preToolUseAllow("Comment has no merge-conflict signals")

  if (!isPureNoise(bodyNormalized))
    return preToolUseAllow("Comment contains substantive content beyond conflict notice")

  const rebaseAdvice = skillAdvice(
    "rebase-onto-main",
    "Use the /rebase-onto-main skill to automatically rebase the branch.",
    [
      "Rebase the branch to resolve conflicts:",
      "  git fetch origin",
      "  git rebase origin/main",
      "  # if conflicts arise: fix files, git add <file>, git rebase --continue",
      "  git push --force-with-lease",
    ].join("\n")
  )

  return preToolUseDeny(
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
}

const pretoolusNoMergeConflictComments: SwizShellHook = {
  name: "pretooluse-no-merge-conflict-comments",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretoolusNoMergeConflictComments

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoMergeConflictComments)
