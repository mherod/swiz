#!/usr/bin/env bun

// Pre-push branch policy gate.
//
// Enforces rules for direct pushes to protected branches (main/master):
//   1. Collaboration detection — blocks all direct pushes in collaborative repos
//   2. File count limits — blocks >5 non-docs/config files
//   3. Commit type policy — blocks feat commits with >3 files
//   4. Fail-closed — blocks non-trivial pushes when gh CLI is unavailable
//
// Usage: bun push/scripts/check-branch-policy.ts
// Reads: git state (branch, upstream, changed files, commit messages)
// Exits: 0 = allow, 1 = block (prints BLOCKED message to stderr)

import { gh, git, isGitRepo } from "../../hooks/hook-utils.ts"

const PROTECTED_BRANCHES = new Set(["main", "master"])
const MAX_FILES_HARD_BLOCK = 5
const MAX_TRIVIAL_FILES = 3

const TRIVIAL_TYPES = new Set([
  "fix",
  "docs",
  "style",
  "chore",
  "ci",
  "build",
  "refactor",
  "perf",
  "test",
  "revert",
])

const DOCS_CONFIG_RE =
  /\.(md|txt|json|ya?ml|toml)$|\.config\.[jt]s$|\.env\.example$|LICENSE|^\.github\/|^\.husky\//

// ── Helpers ─────────────────────────────────────────────────────────────────

function isDocsOrConfig(filePath: string): boolean {
  return DOCS_CONFIG_RE.test(filePath)
}

function parseCommitType(message: string): string | null {
  const match = message.match(/^(\w+)(\(.+?\))?[!]?:/)
  return match?.[1] ?? null
}

function block(reason: string): never {
  console.error(`BLOCKED: ${reason}`)
  console.error(
    "\nUse a feature branch instead:\n" +
      "  git checkout -b feat/<description>\n" +
      "  git push origin feat/<description>\n" +
      "  gh pr create"
  )
  process.exit(1)
}

type GhResult<T> = { ok: true; value: T } | { ok: false }

async function ghSafe<T>(args: string[], cwd: string): Promise<GhResult<T>> {
  try {
    const raw = await gh(args, cwd)
    if (!raw) return { ok: false }
    return { ok: true, value: JSON.parse(raw) as T }
  } catch {
    return { ok: false }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const cwd = process.cwd()

if (!(await isGitRepo(cwd))) process.exit(0)

const branch = await git(["branch", "--show-current"], cwd)
if (!branch || !PROTECTED_BRANCHES.has(branch)) process.exit(0)

// Get changed files between upstream and HEAD
const upstream = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd)
if (!upstream) process.exit(0) // No upstream tracking — allow

const diffBase = `${upstream}..HEAD`
const changedFilesRaw = await git(["diff", "--name-only", diffBase], cwd)
if (!changedFilesRaw) process.exit(0) // No changes — allow

const changedFiles = changedFilesRaw.split("\n").filter(Boolean)
if (changedFiles.length === 0) process.exit(0)

const allDocsConfig = changedFiles.every(isDocsOrConfig)
const nonDocsFiles = changedFiles.filter((f) => !isDocsOrConfig(f))

// Docs/config-only changes always pass regardless of count or type
if (allDocsConfig) {
  if (changedFiles.length > MAX_FILES_HARD_BLOCK) {
    console.error(
      `Info: ${changedFiles.length} docs/config files changed — allowed (docs-only bypass).`
    )
  }
  process.exit(0)
}

// ── Check 1: gh CLI availability (fail-closed for non-trivial) ──────────

let ghAvailable = false
const ghAuthResult = await gh(["auth", "status"], cwd)
ghAvailable = ghAuthResult !== ""

let collaborationResolved = false

if (!ghAvailable) {
  // Trivial changes pass without gh
  if (nonDocsFiles.length <= MAX_TRIVIAL_FILES) {
    // Check commit types — allow only trivial types
    const commitMsgsRaw = await git(["log", "--format=%s", diffBase], cwd)
    const commitMsgs = (commitMsgsRaw || "").split("\n").filter(Boolean)
    const allTrivial = commitMsgs.every((msg) => {
      const type = parseCommitType(msg)
      return type !== null && TRIVIAL_TYPES.has(type)
    })
    if (allTrivial) process.exit(0)
  }

  block(
    "Cannot determine repository collaboration state — gh CLI is unavailable or not authenticated.\n\n" +
      `${nonDocsFiles.length} non-docs/config file(s) changed. Non-trivial pushes require gh to verify collaboration state.\n\n` +
      "Remediation:\n" +
      "  1. Install gh: brew install gh\n" +
      "  2. Authenticate: gh auth login\n" +
      "  3. Or use a feature branch (no gh required)"
  )
}

// ── Check 2: Collaboration detection ────────────────────────────────────

interface GhUser {
  login: string
}

const currentUserResult = await ghSafe<GhUser>(["api", "user", "--jq", ".login"], cwd)
const currentUser = currentUserResult.ok ? String(currentUserResult.value) : null

// Run all collaboration checks in parallel
const remoteUrl = await git(["remote", "get-url", "origin"], cwd)
const isOrgRepo = (() => {
  if (!remoteUrl || !currentUser) return false
  // Extract owner from remote URL: git@github.com:owner/repo.git or https://github.com/owner/repo.git
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\//)
  const owner = match?.[1]
  return owner !== undefined && owner !== currentUser
})()

const [openPrsResult, recentContribsRaw] = await Promise.all([
  ghSafe<Array<{ number: number; author: { login: string } }>>(
    ["pr", "list", "--state", "open", "--json", "number,author", "--limit", "10"],
    cwd
  ),
  gh(
    [
      "api",
      "repos/{owner}/{repo}/commits",
      "--jq",
      `.[] | select(.commit.author.date > (now - 86400 | strftime("%Y-%m-%dT%H:%M:%SZ"))) | .author.login`,
    ],
    cwd
  ),
])

const hasOpenPRs = openPrsResult.ok && openPrsResult.value.length > 0
const recentContributors = recentContribsRaw
  ? [...new Set(recentContribsRaw.split("\n").filter(Boolean))]
  : []
const otherContributors = currentUser
  ? recentContributors.filter((c) => c !== currentUser)
  : recentContributors

collaborationResolved = true

const collaborationSignals: string[] = []
if (isOrgRepo) collaborationSignals.push("Organization repository (not a personal repo)")
if (hasOpenPRs) {
  const count = openPrsResult.ok ? openPrsResult.value.length : 0
  collaborationSignals.push(`${count} open pull request(s)`)
}
if (otherContributors.length > 0) {
  collaborationSignals.push(
    `Other contributors active in last 24h: ${otherContributors.join(", ")}`
  )
}

if (collaborationSignals.length > 0) {
  block(
    `Collaborative repository detected — direct pushes to ${branch} are not allowed.\n\n` +
      "Collaboration signals:\n" +
      collaborationSignals.map((s) => `  - ${s}`).join("\n")
  )
}

// If collaboration checks partially failed, treat as fail-closed for non-trivial
if (!collaborationResolved && nonDocsFiles.length > MAX_TRIVIAL_FILES) {
  block(
    "Collaboration state could not be fully resolved (partial gh API failures).\n\n" +
      `${nonDocsFiles.length} non-docs/config file(s) changed — blocking as a precaution.`
  )
}

// ── Check 3: File count hard limit ──────────────────────────────────────

if (nonDocsFiles.length > MAX_FILES_HARD_BLOCK) {
  block(
    `Too many files for a direct push to ${branch}: ${nonDocsFiles.length} non-docs/config files (limit: ${MAX_FILES_HARD_BLOCK}).`
  )
}

// ── Check 4: Commit type policy ─────────────────────────────────────────

const commitMessagesRaw = await git(["log", "--format=%s", diffBase], cwd)
const commitMessages = (commitMessagesRaw || "").split("\n").filter(Boolean)

for (const msg of commitMessages) {
  const type = parseCommitType(msg)

  if (type === "feat" && nonDocsFiles.length > MAX_TRIVIAL_FILES) {
    block(
      `Feature commit with ${nonDocsFiles.length} non-docs files exceeds trivial threshold (${MAX_TRIVIAL_FILES}).\n\n` +
        `Commit: "${msg}"`
    )
  }

  if (type === "feat" && nonDocsFiles.length <= MAX_TRIVIAL_FILES) {
    console.error(
      `Warning: Feature commit with ${nonDocsFiles.length} file(s) — consider using a feature branch for features.\n` +
        `Commit: "${msg}"`
    )
  }

  // Non-standard types with many files
  if (type !== null && !TRIVIAL_TYPES.has(type) && type !== "feat") {
    if (nonDocsFiles.length > MAX_FILES_HARD_BLOCK) {
      block(
        `Non-standard commit type "${type}" with ${nonDocsFiles.length} files exceeds limit (${MAX_FILES_HARD_BLOCK}).`
      )
    }
  }
}

// All checks passed
process.exit(0)
