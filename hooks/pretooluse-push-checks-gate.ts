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
  git,
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

// ── Secret / credential pattern scan ─────────────────────────────────────────
// Scan the outgoing diff for high-confidence credential patterns before any
// bytes leave the local machine. Removed lines (diff `-` prefix) are skipped
// to avoid blocking commits that *delete* old secrets.
// Bypassed when `skipSecretScan` swiz setting is true.

const [diffResult, fileNamesResult, priorCommandsResult, globalSettings, projectSettings] =
  await Promise.all([
    spawnWithTimeout(["git", "diff", "@{upstream}..HEAD"], { cwd, timeoutMs: 10000 }),
    spawnWithTimeout(["git", "diff", "--name-only", "@{upstream}..HEAD"], { cwd, timeoutMs: 5000 }),
    extractBashCommands(transcriptPath),
    readSwizSettings(),
    readProjectSettings(cwd),
  ])

const effectiveSettingsEarly = getEffectiveSwizSettings(globalSettings, null, projectSettings)

if (!effectiveSettingsEarly.skipSecretScan && diffResult.exitCode === 0 && diffResult.stdout) {
  // Only inspect added/context lines — skip lines starting with '-'
  const addedLines = diffResult.stdout
    .split("\n")
    .filter((l) => !l.startsWith("-") || l.startsWith("---"))

  // High-confidence patterns: PEM block headers and well-known API key prefixes.
  const PEM_HEADER = /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/
  const API_KEY_PREFIXES = new RegExp(
    [
      "sk-live-[A-Za-z0-9]{20,}",
      "sk-proj-[A-Za-z0-9]{20,}",
      "ghp_[A-Za-z0-9]{36,}",
      "gho_[A-Za-z0-9]{36,}",
      "ghs_[A-Za-z0-9]{36,}",
      "AKIA[0-9A-Z]{16}",
    ].join("|")
  )

  const secretMatches: string[] = []
  for (const line of addedLines) {
    if (PEM_HEADER.test(line) || API_KEY_PREFIXES.test(line)) {
      // Truncate to avoid echoing the actual secret in the block message
      secretMatches.push(line.slice(0, 80) + (line.length > 80 ? "…" : ""))
    }
  }

  if (secretMatches.length > 0) {
    denyPreToolUse(
      `Potential secret or credential detected in outgoing diff — push blocked.\n\n` +
        `Matching lines (truncated):\n` +
        secretMatches.map((l) => `  ${l}`).join("\n") +
        `\n\nInspect with \`git diff @{upstream}..HEAD\`, then:\n` +
        `  1. Remove the secret from the file\n` +
        `  2. Soft-reset to amend: \`git reset --soft HEAD~1\`\n` +
        `  3. Rotate the credential immediately — treat it as compromised\n\n` +
        `To disable this check: \`swiz settings enable skip-secret-scan\``
    )
  }
}

// Warn items collected by the large file check — merged into `missing` below.
const largeFileWarnItems: string[] = []

// ── Large file check ──────────────────────────────────────────────────────────
// Warn (advisory) or hard-block when outgoing files exceed configured thresholds.
// Skipped gracefully when no upstream is set (fileNamesResult.exitCode !== 0).

if (fileNamesResult.exitCode === 0 && fileNamesResult.stdout) {
  const warnThresholdKb = effectiveSettingsEarly.largeFileSizeKb
  const blockThresholdKb = effectiveSettingsEarly.largeFileSizeBlockKb
  const allowPatterns: string[] = projectSettings?.largeFileAllowPatterns ?? []

  function globToRegex(pattern: string): RegExp {
    return new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u2B1B")
        .replace(/\*/g, "[^/]*")
        .replace(/\u2B1B/g, ".*")
        .replace(/\?/g, "[^/]")}$`
    )
  }

  function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${Math.floor(bytes / 1024)} KB`
  }

  const changedFiles = fileNamesResult.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)

  const blockFiles: string[] = []

  await Promise.all(
    changedFiles.map(async (filePath) => {
      // Skip files in allow patterns
      if (allowPatterns.some((p) => globToRegex(p).test(filePath))) return

      // Get blob hash from HEAD tree — returns empty if file is deleted
      const treeEntry = await git(["ls-tree", "HEAD", "--", filePath], cwd)
      if (!treeEntry) return // deleted file — no blob to measure

      const blobHash = treeEntry.split(/\s+/)[2]
      if (!blobHash || blobHash === "0000000000000000000000000000000000000000") return

      const sizeStr = await git(["cat-file", "-s", blobHash], cwd)
      const sizeBytes = parseInt(sizeStr ?? "0", 10)
      if (Number.isNaN(sizeBytes) || sizeBytes === 0) return

      const sizeKb = sizeBytes / 1024
      const label = `${formatSize(sizeBytes)} — ${filePath}`

      if (sizeKb >= blockThresholdKb) {
        blockFiles.push(label)
      } else if (sizeKb >= warnThresholdKb) {
        largeFileWarnItems.push(`Large file advisory (>${warnThresholdKb} KB): ${label}`)
      }
    })
  )

  if (blockFiles.length > 0) {
    denyPreToolUse(
      `Large file(s) in outgoing batch exceed the ${blockThresholdKb} KB block threshold — push blocked.\n\n` +
        blockFiles.map((f) => `  ${f}`).join("\n") +
        `\n\nTo resolve:\n` +
        `  1. Add the file to .gitignore\n` +
        `  2. Soft-reset to remove it from history: \`git reset --soft HEAD~1\`\n` +
        `  3. Re-commit without the large file\n\n` +
        `To change the threshold: \`swiz settings set large-file-size-block-kb <N>\``
    )
  }
}

const priorCommands = priorCommandsResult
const effectiveSettings = effectiveSettingsEarly
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

if (hasBranchCheck && hasPRCheck && hasCICheck && largeFileWarnItems.length === 0) {
  allowPreToolUse("All pre-push checks found in transcript (branch, PR, CI)")
}

// ── Advise on missing checks ─────────────────────────────────────────────────

const missing: string[] = [...largeFileWarnItems]
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
