#!/usr/bin/env bun
// PreToolUse hook: Block `git push` unless the required branch/PR/collaboration
// checks have already been run in this transcript session.
//
// Required checks (must appear as Bash tool calls before any git push):
//   1. Branch check  — `git branch` (confirms current branch)
//   2. PR check      — `gh pr list ... --head` (checks for open PR on branch)
//
// Rationale: pushing without these checks risks pushing large work directly
// to main in a collaborative repo, or creating duplicate PRs.

import {
  BRANCH_CHECK_RE,
  denyPreToolUse,
  extractBashCommands,
  formatActionPlan,
  GIT_PUSH_RE,
  isShellTool,
  PR_CHECK_RE,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""

// Only gate on git push commands
if (!GIT_PUSH_RE.test(command)) process.exit(0)

// ── Scan transcript for prior checks ─────────────────────────────────────────

const transcriptPath: string = input?.transcript_path ?? ""
if (!transcriptPath) process.exit(0) // no transcript → can't enforce; allow

const priorCommands = await extractBashCommands(transcriptPath)

// Check 1: branch check — must use `git branch --show-current` explicitly.
// Bare `git branch`, `git branch -a`, `git branch -d foo` etc. do NOT satisfy
// the gate because they don't confirm which branch is currently checked out.
// Use (?!\S) so `--show-current-upstream` (a non-existent but theoretically
// matchable string) does not falsely satisfy the gate.
const hasBranchCheck = priorCommands.some((c) => BRANCH_CHECK_RE.test(c))

// Check 2: open-PR check (`gh pr list` with `--head`)
const hasPRCheck = priorCommands.some((c) => PR_CHECK_RE.test(c))

if (hasBranchCheck && hasPRCheck) process.exit(0)

// ── Block with actionable instructions ────────────────────────────────────────

const missing: string[] = []
if (!hasBranchCheck) {
  missing.push("Branch check (not run yet): `git branch --show-current`")
}
if (!hasPRCheck) {
  missing.push(
    "Open-PR check (not run yet): " +
      "`gh pr list --state open --head $(git branch --show-current)`"
  )
}

denyPreToolUse(
  `BLOCKED: git push requires branch/PR checks to run first.\n\n` +
    `The following mandatory checks have not been run in this session.\n\n` +
    formatActionPlan(missing) +
    `\n\nRun the missing checks, review the output, then retry git push.\n\n` +
    `Why this matters: pushing without these checks risks pushing large work\n` +
    `directly to main in a collaborative repo, or creating duplicate PRs.`
)
