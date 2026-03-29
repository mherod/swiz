#!/usr/bin/env bun

// PreToolUse hook: Block `git commit` when on the default branch in a collaborative repository.
//
// Rationale: Committing directly to main/master in a shared repo bypasses code review.
// The correct workflow is to use a feature branch and open a PR.
//
// Policy:
//   Collaborative repo + on default branch → BLOCKED (must use feature branch)
//   Solo repo + on default branch          → allowed
//   Any repo + on feature branch           → allowed

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import { readProjectSettings } from "../src/settings.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  detectForkTopology,
  forkPrCreateCmd,
  forkPushCmd,
  GIT_COMMIT_RE,
  git,
  isShellTool,
  type ToolHookInput,
} from "../src/utils/hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""
const cwd: string = input.cwd ?? process.cwd()

if (!GIT_COMMIT_RE.test(command)) process.exit(0)

// ── Trunk mode bypass ────────────────────────────────────────────────────────
const projectSettings = await readProjectSettings(cwd)
if (projectSettings?.trunkMode) {
  allowPreToolUse("Trunk mode enabled — direct commit to default branch allowed")
}

// ── Check current branch ──────────────────────────────────────────────────────
let currentBranch: string
try {
  currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
} catch {
  process.exit(0) // can't determine branch — allow
}

if (!currentBranch) process.exit(0) // detached HEAD — allow

// ── Check if on default branch ───────────────────────────────────────────────
let defaultBranch: string
try {
  defaultBranch = await getDefaultBranch(cwd)
} catch {
  process.exit(0) // no git remote — allow
}

if (!isDefaultBranch(currentBranch, defaultBranch)) {
  allowPreToolUse(`On feature branch '${currentBranch}', not default '${defaultBranch}'`)
}

// ── Check collaboration policy ───────────────────────────────────────────────
let collaboration: Awaited<ReturnType<typeof detectProjectCollaborationPolicy>>
try {
  collaboration = await detectProjectCollaborationPolicy(cwd)
} catch {
  process.exit(0) // can't determine — allow
}

if (!collaboration.isCollaborative) {
  allowPreToolUse(`Solo repo — direct commit to '${currentBranch}' allowed`)
}

// ── Block: collaborative repo, committing to default branch ─────────────────
const signals = collaboration.signals.map((s) => `  - ${s}`).join("\n")
const owner = collaboration.repoOwner
const repo = collaboration.repoName
const repoRef = owner && repo ? `${owner}/${repo}` : "this repository"

const fork = await detectForkTopology(cwd)

denyPreToolUse(`
Committing directly to '${defaultBranch}' is blocked in ${repoRef} (collaborative repository).

Collaboration signals:
${signals}

Use the feature branch workflow instead:
  1. Create a feature branch: git checkout -b feat/description
  2. Commit your changes there
  3. Push: ${forkPushCmd("feat/description", fork)}
  4. Open PR: ${forkPrCreateCmd(defaultBranch, fork)}

This ensures code review and prevents unreviewed changes from landing on the default branch.
`)
