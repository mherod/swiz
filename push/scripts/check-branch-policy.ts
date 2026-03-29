#!/usr/bin/env bun

// Pre-push branch policy gate.
//
// Enforces rules for direct pushes to the effective default branch:
//   1. Collaboration detection — blocks all direct pushes in collaborative repos
//   2. File count limits — blocks >5 non-docs/config files
//   3. Commit type policy — blocks feat commits with >3 files
//   4. Fail-closed — blocks non-trivial pushes when gh CLI is unavailable
//
// Usage: bun push/scripts/check-branch-policy.ts
// Reads: git state (branch, upstream, changed files, commit messages)
// Exits: 0 = allow, 1 = block (prints BLOCKED message to stderr)

import {
  detectProjectCollaborationPolicy,
  getCollaborationModePolicy,
} from "../../src/collaboration-policy.ts"
import { isDocsOrConfig, parseCommitType } from "../../src/git-helpers.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import {
  getDefaultBranch,
  gh,
  git,
  isDefaultBranch,
  isGitRepo,
} from "../../src/utils/hook-utils.ts"

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function block(reason: string, opts: { trunkMode?: boolean } = {}): never {
  const trunkMode = opts.trunkMode === true
  console.error(`BLOCKED: ${reason}`)
  if (trunkMode) {
    console.error(
      "\nTrunk mode is enabled — direct pushes to the default branch are expected. " +
        "Fix the issue above (or run `gh auth login` if gh is required), not by opening a feature-branch PR."
    )
  } else {
    console.error(
      "\nUse a feature branch instead:\n" +
        "  git checkout -b feat/<description>\n" +
        "  git push origin feat/<description>\n" +
        "  gh pr create"
    )
  }
  process.exit(1)
}

// ── Main ────────────────────────────────────────────────────────────────────

const cwd = process.cwd()

if (!(await isGitRepo(cwd))) process.exit(0)

const branch = await git(["branch", "--show-current"], cwd)
if (!branch) process.exit(0)
const defaultBranch = await getDefaultBranch(cwd)
if (!isDefaultBranch(branch, defaultBranch)) process.exit(0)

const projectSettings = await readProjectSettings(cwd)
const trunkMode = projectSettings?.trunkMode === true

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
      "  3. Or use a feature branch (no gh required)",
    { trunkMode }
  )
}

// ── Check 2: Collaboration detection + mode policy ───────────────────────

const [collaboration, globalSettings] = await Promise.all([
  detectProjectCollaborationPolicy(cwd),
  readSwizSettings(),
])
collaborationResolved = collaboration.resolved

const effectiveSettings = getEffectiveSwizSettings(globalSettings, null, projectSettings)
const modePolicy = getCollaborationModePolicy(effectiveSettings.collaborationMode)

// Settings-layer mode takes precedence over signal-based detection:
// - If requireFeatureBranch=true (team/relaxed-collab), block direct push regardless of signals.
// - If requireFeatureBranch=false and signals say collaborative, also block.
// - If requireFeatureBranch=false and signals say solo (auto/solo), allow.
// Trunk mode: expect direct pushes to the default branch — skip feature-branch collaboration gates.
if (modePolicy.requireFeatureBranch && !trunkMode) {
  block(
    `Collaboration mode "${effectiveSettings.collaborationMode}" requires a feature branch — direct pushes to ${branch} are not allowed.\n\n` +
      "Create a feature branch:\n" +
      "  git checkout -b feat/<description>\n" +
      "  git push origin feat/<description>\n" +
      "  gh pr create"
  )
}

if (collaboration.isCollaborative && !trunkMode) {
  block(
    `Collaborative repository detected — direct pushes to ${branch} are not allowed.\n\n` +
      "Collaboration signals:\n" +
      collaboration.signals.map((s) => `  - ${s}`).join("\n")
  )
}

// If collaboration checks partially failed, treat as fail-closed for non-trivial
if (!collaborationResolved && nonDocsFiles.length > MAX_TRIVIAL_FILES && !trunkMode) {
  block(
    "Collaboration state could not be fully resolved (partial gh API failures).\n\n" +
      `${nonDocsFiles.length} non-docs/config file(s) changed — blocking as a precaution.`
  )
}

// ── Check 3: File count hard limit ──────────────────────────────────────

if (nonDocsFiles.length > MAX_FILES_HARD_BLOCK) {
  block(
    `Too many files for a direct push to ${branch}: ${nonDocsFiles.length} non-docs/config files (limit: ${MAX_FILES_HARD_BLOCK}).`,
    { trunkMode }
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
        `Commit: "${msg}"`,
      { trunkMode }
    )
  }

  if (type === "feat" && nonDocsFiles.length <= MAX_TRIVIAL_FILES) {
    console.error(
      trunkMode
        ? `Warning: Feature commit with ${nonDocsFiles.length} file(s) (trunk mode — ensure change is appropriate for a direct default-branch push).\n` +
            `Commit: "${msg}"`
        : `Warning: Feature commit with ${nonDocsFiles.length} file(s) — consider using a feature branch for features.\n` +
            `Commit: "${msg}"`
    )
  }

  // Non-standard types with many files
  if (type !== null && !TRIVIAL_TYPES.has(type) && type !== "feat") {
    if (nonDocsFiles.length > MAX_FILES_HARD_BLOCK) {
      block(
        `Non-standard commit type "${type}" with ${nonDocsFiles.length} files exceeds limit (${MAX_FILES_HARD_BLOCK}).`,
        { trunkMode }
      )
    }
  }
}

// All checks passed
process.exit(0)
