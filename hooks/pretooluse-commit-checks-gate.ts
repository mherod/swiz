#!/usr/bin/env bun
// PreToolUse hook: Block `git commit` (and `git add`) unless the required
// branch check has already been run in this transcript session.
//
// Required check (must appear as a Bash tool call before any git commit):
//   1. Branch check — `git branch --show-current` (confirms current branch)
//
// Rationale: committing without verifying the current branch risks landing
// work directly on a protected or shared main branch without a feature branch.

import {
  BRANCH_CHECK_RE,
  denyPreToolUse,
  extractBashCommands,
  formatActionPlan,
  GIT_COMMIT_RE,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""

// Only gate on git commit commands
if (!GIT_COMMIT_RE.test(command)) process.exit(0)

// ── Scan transcript for prior branch check ───────────────────────────────────

const transcriptPath: string = input?.transcript_path ?? ""
if (!transcriptPath) process.exit(0) // no transcript → can't enforce; allow

const priorCommands = await extractBashCommands(transcriptPath)

// Branch check — must use `git branch --show-current` explicitly.
// Bare `git branch`, `git branch -a`, `git branch -d foo` etc. do NOT satisfy
// the gate because they don't confirm which branch is currently checked out.
const hasBranchCheck = priorCommands.some((c) => BRANCH_CHECK_RE.test(c))

if (hasBranchCheck) process.exit(0)

// ── Block with actionable instructions ────────────────────────────────────────

denyPreToolUse(
  `BLOCKED: git commit requires a branch check to run first.\n\n` +
    `The following mandatory check has not been run in this session.\n\n` +
    formatActionPlan(["Branch check (not run yet): `git branch --show-current`"]) +
    `\n\nRun the branch check, review the output, then retry git commit.\n\n` +
    `Why this matters: committing without verifying the branch risks landing\n` +
    `work directly on a protected or shared main branch without a feature branch.`
)
