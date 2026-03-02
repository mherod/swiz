#!/usr/bin/env bun
// PreToolUse hook: Enforce scope-based push policy for main branch.
// Classifies changes as trivial (typos, small fixes, docs) or non-trivial (features, refactors).
// Blocks non-trivial work on main in collaborative repositories.
// Trivial work is allowed directly to main in solo projects.
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

import {
  denyPreToolUse,
  getCurrentGitHubUser,
  gh,
  git,
  isShellTool,
  parseGitStatSummary,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""
const cwd: string = (input?.tool_input?.cwd as string) ?? process.cwd()

// Only check git push commands to main/master
const pushToMainRe = /\bgit\s+(?:-\w+\s+)*push\s+(?:-\w+\s+)*origin\s+(?:main|master)\b/
if (!pushToMainRe.test(command)) process.exit(0)

// Verify we're actually on main/master
const currentBranch = await git(["branch", "--show-current"], cwd)
if (currentBranch !== "main" && currentBranch !== "master") process.exit(0)

// ─── Analyze change scope ──────────────────────────────────────────────

// Count files and lines changed
// Try diff against origin/main first, fall back to HEAD~1 if no remote history exists
let diffStat = await git(["diff", "origin/main..HEAD", "--stat"], cwd)
if (!diffStat.trim()) {
  diffStat = await git(["diff", "HEAD~1..HEAD", "--stat"], cwd)
}
const { filesChanged: fileCount, insertions, deletions } = parseGitStatSummary(diffStat)
const totalLinesChanged = insertions + deletions

// Check if changes are docs-only or config-only
const diffFiles = await git(["diff", "--name-only", "origin/main..HEAD"], cwd)
const changedFiles = diffFiles.trim().split("\n").filter(Boolean)
const docsOnlyRe =
  /\.(md|txt|rst)$|^(README|CHANGELOG|LICENSE|docs\/)|(\.config\.|\.json|\.yaml|\.yml|\.toml)$/i
const isDocsOnly = changedFiles.length > 0 && changedFiles.every((f) => docsOnlyRe.test(f))

// Classify change scope
const isTrivial =
  fileCount <= 3 &&
  totalLinesChanged <= 20 &&
  !changedFiles.some((f) => /src\/|lib\/|components\//.test(f))

const isSmallFix = fileCount <= 2 && totalLinesChanged <= 30

const scopeDescription = isDocsOnly
  ? "docs-only"
  : isTrivial
    ? "trivial"
    : isSmallFix
      ? "small-fix"
      : `${fileCount}-files, ${totalLinesChanged}-lines`

// ─── Check collaborator activity ──────────────────────────────────────

// Get repo owner/repo from remote URL
const remoteUrl = await git(["remote", "get-url", "origin"], cwd)
const repoMatch = remoteUrl.match(
  /(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
)
if (!repoMatch || !repoMatch[1] || !repoMatch[2]) process.exit(0) // Can't parse repo, allow push

const [owner, repo] = [repoMatch[1]!, repoMatch[2]!]

// Check for other contributors in last 24 hours
const recentContributors = await gh(
  [
    "api",
    "repos/" + owner + "/" + repo + "/commits",
    "--jq",
    '.[] | select(.commit.author.date > (now - 86400 | strftime("%Y-%m-%dT%H:%M:%SZ"))) | .author.login',
  ],
  cwd
)

// Get current user to exclude from contributor list
const currentUser = await getCurrentGitHubUser(cwd)

const otherContributors = Array.from(
  new Set(
    recentContributors
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((c) => c !== "null" && c !== "" && c !== currentUser)
  )
)

// Check for open PRs
const openPrs = await gh(["pr", "list", "--state", "open", "--limit", "1", "--json", "number"], cwd)
const hasOpenPrs = openPrs.trim() !== "" && openPrs.trim() !== "[]"

// Determine if repo is collaborative
const isOrg =
  remoteUrl.includes("github.com/") &&
  remoteUrl.match(/github\.com\/[^/]+\//) &&
  owner !== owner.toLowerCase()
const isCollaborative = otherContributors.length > 0 || hasOpenPrs || isOrg

// ─── Enforce policy ────────────────────────────────────────────────────

if (!isCollaborative) {
  // Solo repo: allow all changes to main
  process.exit(0)
}

// Collaborative repo: block non-trivial work
if (isDocsOnly || isTrivial) {
  // Docs and trivial changes are allowed even in collaborative repos
  process.exit(0)
}

// Non-trivial work in collaborative repo: BLOCK
const reason = `
Non-trivial changes to main branch in a collaborative repository.

Change scope: ${scopeDescription} (${fileCount} files, ${totalLinesChanged} lines)
Repository: ${owner}/${repo}
Other recent contributors: ${otherContributors.length > 0 ? otherContributors.join(", ") : "none in last 24h"}

For non-trivial work, use the feature branch workflow:
  1. Create a feature branch: git checkout -b feat/description
  2. Push: git push origin feat/description
  3. Open PR: gh pr create --base main
  4. Wait for review and approval
  5. Merge via PR (not direct push)

This ensures code review, CI validation, and team coordination.
`

denyPreToolUse(reason)
