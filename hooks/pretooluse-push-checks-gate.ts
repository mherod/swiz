#!/usr/bin/env bun

// PreToolUse hook: Advise on branch/PR/collaboration checks before `git push`.
//
// Hard blocks:
//   0. Behind-remote check — blocks if remote has commits local doesn't have;
//      advises `git pull --rebase --autostash` and /resolve-conflicts skill.
//
// Advisory (surfaced as context if missing):
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
  denyPreToolUse,
  extractBashCommands,
  formatActionPlan,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  isShellTool,
  PR_CHECK_RE,
  skillAdvice,
  spawnWithTimeout,
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

// ── Behind-remote check ───────────────────────────────────────────────────────
// If the remote has commits the local branch doesn't have, pushing would create
// a diverged history. Advise `git pull --rebase --autostash` first.

const behindResult = await spawnWithTimeout(["git", "rev-list", "--count", "HEAD..@{upstream}"], {
  cwd,
  timeoutMs: 5000,
})
const behindCount = parseInt(behindResult.stdout.trim(), 10)

if (!Number.isNaN(behindCount) && behindCount > 0) {
  const conflictAdvice = skillAdvice(
    "resolve-conflicts",
    "If rebase produces merge conflicts, use the /resolve-conflicts skill to resolve them before pushing.",
    "If rebase produces merge conflicts, resolve them with `git add <file>` and `git rebase --continue`, or abort with `git rebase --abort`."
  )

  denyPreToolUse(
    `Remote is ahead by ${behindCount} commit${behindCount === 1 ? "" : "s"} — pull before pushing.\n\n` +
      `Run: \`git pull --rebase --autostash\`\n\n` +
      conflictAdvice
  )
}

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
// Satisfied by `swiz ci-wait` in the transcript (skipped when ignore-ci is on).
const hasCICheck =
  effectiveSettings.ignoreCi || !modePolicy.prHooksActive
    ? true
    : priorCommands.some((c) => CI_WAIT_RE.test(c))

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
