#!/usr/bin/env bun

// PreToolUse hook: Enforce scope-based push policy for the default branch.
// Classifies changes as trivial (typos, small fixes, docs) or non-trivial (features, refactors).
// Blocks non-trivial work on the default branch in collaborative repositories.
// Trivial work is allowed directly to the default branch in solo projects.
//
// Classification:
//   Trivial: ≤ 3 files, ≤ 20 lines changed, only docs/config, or single small fix
//   Non-trivial: > 3 files, > 20 lines, new features, major refactors, breaking changes
//
// Enforcement:
//   Solo repo + trivial: allowed
//   Solo repo + non-trivial: allowed (user controls their own policy)
//   Collaborative + trivial: allowed
//   Collaborative + non-trivial: BLOCKED — must use feature branch + PR

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import { readProjectSettings, readSwizSettings, resolvePolicy } from "../src/settings.ts"
import {
  classifyChangeScope,
  denyPreToolUse,
  getDefaultBranch,
  git,
  isDefaultBranch,
  isShellTool,
  parseGitStatSummary,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""
const cwd: string = (input?.tool_input?.cwd as string) ?? process.cwd()

const defaultBranch = await getDefaultBranch(cwd)

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Only check git push commands that target the effective default branch.
const pushToDefaultRe = new RegExp(
  `\\bgit\\s+(?:-\\w+\\s+)*push\\s+(?:-\\w+\\s+)*origin\\s+(${escapeRegex(defaultBranch)})\\b`
)
const pushMatch = command.match(pushToDefaultRe)
if (!pushMatch) process.exit(0)

// Determine the effective branch: prefer current branch, fall back to push target.
// Detached HEAD (CI runners, specific SHA checkouts) returns "" from --show-current,
// but the push command explicitly names the target branch.
const checkedOutBranch = await git(["branch", "--show-current"], cwd)
const targetBranch = pushMatch[1]!
const currentBranch = checkedOutBranch || targetBranch

if (!isDefaultBranch(currentBranch, defaultBranch)) process.exit(0)

// ─── Resolve diff range once, use everywhere ─────────────────────────

// Determine the correct diff range by trying progressively weaker strategies.
// All git diff queries MUST use this resolved range to avoid data source mismatch.
//
// Candidate order:
//   1. origin/branch..HEAD       — normal case (remote ref exists, linear history)
//   2. merge-base..HEAD          — rebased or diverged history (finds common ancestor)
//   3. HEAD~1..HEAD              — no remote ref (single-commit fallback)
const remoteRef = `origin/${currentBranch}`

async function resolveDiffRange(): Promise<string> {
  // Pre-step: attempt to deepen shallow clones so diff/merge-base have full
  // history. If unshallow fails (no network, origin unavailable), the
  // strategies below still try with whatever local history is available.
  const isShallow = await git(["rev-parse", "--is-shallow-repository"], cwd)
  if (isShallow === "true") {
    await git(["fetch", "--unshallow", "origin"], cwd)
  }

  // 1. Direct remote ref comparison
  if ((await git(["rev-parse", "--verify", remoteRef], cwd)) !== "") {
    return `${remoteRef}..HEAD`
  }

  // 2. Merge-base fallback for rebased/diverged histories
  const mergeBase = await git(["merge-base", remoteRef, "HEAD"], cwd)
  if (mergeBase) {
    return `${mergeBase}..HEAD`
  }

  // 3. Single parent fallback
  if ((await git(["rev-parse", "--verify", "HEAD~1"], cwd)) !== "") {
    return "HEAD~1..HEAD"
  }

  // 4. Conservative local-history fallback: use all locally available commits.
  // In shallow clones where unshallow failed and no remote ref exists, git
  // may still have N > 1 commits locally. Diff against the oldest available.
  const countStr = await git(["rev-list", "--count", "HEAD"], cwd)
  const count = parseInt(countStr, 10)
  if (count > 1) {
    return `HEAD~${count - 1}..HEAD`
  }

  return ""
}

const diffRange = await resolveDiffRange()

// If no valid diff range could be resolved, block with actionable guidance.
// This can happen on repos with only one commit and no remote tracking branch.
if (!diffRange) {
  denyPreToolUse(`
Push blocked: could not determine diff range for change analysis.

No valid comparison ref found (tried origin/${currentBranch}, merge-base, HEAD~N, local history).
This typically means the repository has only one commit and no remote tracking branch.

Remediation:
  1. Verify the remote is configured: git remote -v
  2. Fetch remote refs: git fetch origin
  3. If this is the initial push, use a feature branch:
     git checkout -b feat/description && git push origin feat/description && gh pr create --base ${currentBranch}
`)
}

const diffStat = await git(["diff", diffRange, "--stat"], cwd)
const diffFiles = await git(["diff", "--name-only", diffRange], cwd)
const changedFiles = diffFiles.trim().split("\n").filter(Boolean)

const projectSettings = await readProjectSettings(cwd)
const policy = resolvePolicy(projectSettings)

const { statParsingFailed, isTrivial, isDocsOnly, scopeDescription, fileCount, totalLinesChanged } =
  classifyChangeScope(parseGitStatSummary(diffStat), changedFiles, {
    trivialMaxFiles: policy.trivialMaxFiles,
    trivialMaxLines: policy.trivialMaxLines,
  })

// ─── Check collaborator activity ──────────────────────────────────────
const collaboration = await detectProjectCollaborationPolicy(cwd)
const owner = collaboration.repoOwner
const repo = collaboration.repoName
if (!owner || !repo) process.exit(0) // Can't parse GitHub repo, allow push
const isCollaborative = collaboration.isCollaborative

// ─── Check strict mode ────────────────────────────────────────────────
const globalSettings = await readSwizSettings()
const strictMode = globalSettings.strictNoDirectMain

// ─── Enforce policy ────────────────────────────────────────────────────

if (!isCollaborative && !strictMode) {
  // Solo repo without strict mode: allow all changes to the default branch
  process.exit(0)
}

// Collaborative repo: block non-trivial work
if (isDocsOnly || isTrivial) {
  // Docs and trivial changes are allowed even in collaborative repos
  process.exit(0)
}

// Fail-closed: stat parsing failed but files were detected
if (statParsingFailed) {
  denyPreToolUse(`
Push blocked: git diff --stat could not be parsed, but ${changedFiles.length} file(s) were detected via --name-only.

Scope: ${scopeDescription}
Repository: ${owner}/${repo}
Detected files:
${changedFiles.map((f) => `  - ${f}`).join("\n")}

This is a fail-closed guard — when change scope cannot be determined, the push is blocked to prevent unreviewed changes.

Remediation:
  1. Run: git diff --stat origin/${currentBranch}..HEAD
  2. Verify the output shows a summary line (e.g. "3 files changed, 10 insertions(+)")
  3. If the summary is missing or malformed, check for binary-only or rename-only changes
  4. If this is a false positive, use a feature branch instead:
     git checkout -b feat/description && git push origin feat/description && gh pr create --base ${currentBranch}
`)
}

// Non-trivial work: BLOCK (collaborative repo, or strict mode active)
const repoContext = isCollaborative
  ? `a collaborative repository.\n\nCollaboration signals:\n${collaboration.signals.map((s) => `  - ${s}`).join("\n")}`
  : `a solo repository with strict-no-direct-main enabled.\n\n  To disable strict mode: swiz settings disable strict-no-direct-main`

const reason = `
Non-trivial changes to '${defaultBranch}' in ${repoContext}

Change scope: ${scopeDescription} (${fileCount} files, ${totalLinesChanged} lines)
Repository: ${owner}/${repo}

For non-trivial work, use the feature branch workflow:
  1. Create a feature branch: git checkout -b feat/description
  2. Push: git push origin feat/description
  3. Open PR: gh pr create --base ${defaultBranch}
  4. Wait for review and approval
  5. Merge via PR (not direct push)

This ensures code review, CI validation, and team coordination.
`

denyPreToolUse(reason)
