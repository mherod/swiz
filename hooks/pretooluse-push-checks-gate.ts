#!/usr/bin/env bun
// PreToolUse hook: Advise on branch/PR/collaboration checks before `git push`.
// Non-blocking — provides advisory context when checks haven't been run.
//
// Checked items (surfaced as advisory context if missing):
//   1. Branch check  — `git branch` (confirms current branch)
//   2. PR check      — `gh pr list ... --head` (checks for open PR on branch)
//
// Rationale: pushing without these checks risks pushing large work directly
// to main in a collaborative repo, or creating duplicate PRs.

import {
  allowPreToolUse,
  BRANCH_CHECK_RE,
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

// ── Advise on missing checks ─────────────────────────────────────────────────

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

allowPreToolUse(
  `Advisory: the following checks have not been run in this session:\n\n` +
    formatActionPlan(missing) +
    `\n\nConsider running these checks to avoid pushing large work directly\n` +
    `to main in a collaborative repo, or creating duplicate PRs.`
)
