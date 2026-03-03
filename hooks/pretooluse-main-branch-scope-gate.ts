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
  classifyChangeScope,
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

// ─── Resolve diff range once, use everywhere ─────────────────────────

// Determine the correct diff range by verifying each candidate ref exists.
// All git diff queries MUST use this resolved range to avoid data source mismatch.
const remoteRef = `origin/${currentBranch}`
const candidates = [
  { range: `${remoteRef}..HEAD`, ref: remoteRef },
  { range: "HEAD~1..HEAD", ref: "HEAD~1" },
]

let diffRange = ""
for (const c of candidates) {
  if ((await git(["rev-parse", "--verify", c.ref], cwd)) !== "") {
    diffRange = c.range
    break
  }
}

// If no valid diff range could be resolved, block with actionable guidance.
// This can happen on repos with only one commit and no remote tracking branch.
if (!diffRange) {
  denyPreToolUse(`
Push blocked: could not determine diff range for change analysis.

Neither origin/${currentBranch} nor HEAD~1 exist as valid refs.
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

const { statParsingFailed, isTrivial, isDocsOnly, scopeDescription, fileCount, totalLinesChanged } =
  classifyChangeScope(parseGitStatSummary(diffStat), changedFiles)

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
