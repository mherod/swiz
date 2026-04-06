#!/usr/bin/env bun
// Changelog staleness detection module for stop-auto-continue hook
// Checks if CHANGELOG.md is stale relative to the latest commit

import { git, isGitRepo } from "../../src/git-helpers.ts"

const ONE_DAY = 86400

/**
 * Check if CHANGELOG.md is stale (last updated > 1 day before the latest commit).
 * Returns a human-readable status string, or "" if not stale or not applicable.
 */
export async function checkChangelogStaleness(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return ""

  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) return ""

  // Find CHANGELOG.md
  let changelogPath = ""
  if (await Bun.file(`${repoRoot}/CHANGELOG.md`).exists()) {
    changelogPath = "CHANGELOG.md"
  } else {
    const lsFiles = await git(["ls-files"], repoRoot)
    const match = lsFiles.split("\n").find((f) => /^CHANGELOG\.md$/i.test(f))
    if (match) changelogPath = match
  }

  if (!changelogPath) return ""

  const lastCommitTime = parseInt(await git(["log", "-1", "--format=%ct"], repoRoot), 10)
  if (Number.isNaN(lastCommitTime)) return ""

  const changelogTime = parseInt(
    await git(["log", "-1", "--format=%ct", "--", changelogPath], repoRoot),
    10
  )
  if (Number.isNaN(changelogTime)) return ""

  const gap = lastCommitTime - changelogTime
  if (gap <= ONE_DAY) return ""

  const days = Math.floor(gap / ONE_DAY)
  const hours = Math.floor((gap % ONE_DAY) / 3600)

  return `CHANGELOG.md is stale — last updated ${days}d ${hours}h before the most recent commit. It should be updated.`
}
