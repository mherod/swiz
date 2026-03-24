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

import { getCollaborationModePolicy } from "../src/collaboration-policy.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import {
  allowPreToolUse,
  BRANCH_CHECK_RE,
  CI_WAIT_RE,
  extractBashCommands,
  formatActionPlan,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  isShellTool,
  PR_CHECK_RE,
  type ToolHookInput,
} from "./utils/hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""

// Only gate on git push commands — skip branch deletion (--delete or :branch)
if (!GIT_PUSH_RE.test(command) || GIT_PUSH_DELETE_RE.test(command)) process.exit(0)

// ── Scan transcript for prior checks ─────────────────────────────────────────

const transcriptPath: string = input?.transcript_path ?? ""
if (!transcriptPath) process.exit(0) // no transcript → can't enforce; allow

const cwd: string = (input?.tool_input?.cwd as string) ?? process.cwd()

const [priorCommands, globalSettings, projectSettings] = await Promise.all([
  extractBashCommands(transcriptPath),
  readSwizSettings(),
  readProjectSettings(cwd),
])

const effectiveSettings = getEffectiveSwizSettings(globalSettings, null, projectSettings)
const modePolicy = getCollaborationModePolicy(effectiveSettings.collaborationMode)

// Check 1: branch check — must use `git branch --show-current` explicitly.
// Bare `git branch`, `git branch -a`, `git branch -d foo` etc. do NOT satisfy
// the gate because they don't confirm which branch is currently checked out.
// Use (?!\S) so `--show-current-upstream` (a non-existent but theoretically
// matchable string) does not falsely satisfy the gate.
const hasBranchCheck = priorCommands.some((c) => BRANCH_CHECK_RE.test(c))

// Check 2: open-PR check (`gh pr list` with `--head`)
const hasPRCheck = priorCommands.some((c) => PR_CHECK_RE.test(c))

// Check 3: CI check — required when prHooksActive (team/relaxed-collab).
// Satisfied by `swiz ci-wait` in the transcript.
const hasCICheck = modePolicy.prHooksActive ? priorCommands.some((c) => CI_WAIT_RE.test(c)) : true // not required for solo/auto

if (hasBranchCheck && hasPRCheck && hasCICheck) {
  allowPreToolUse("All pre-push checks found in transcript (branch, PR, CI)")
}

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
if (!hasCICheck) {
  missing.push(
    `CI check (not run yet, required for ${effectiveSettings.collaborationMode} mode): ` +
      "`swiz ci-wait $(git rev-parse HEAD) --timeout 300`"
  )
}

allowPreToolUse(
  `Advisory: some pre-push checks are missing.\n\n` +
    formatActionPlan(missing, {
      header: "The following checks have not been run in this session:",
    }) +
    `\n\nConsider running these checks to avoid pushing large work directly\n` +
    `to main in a collaborative repo, or creating duplicate PRs.`
)
