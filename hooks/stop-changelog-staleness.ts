#!/usr/bin/env bun
// Stop hook: Block stop if CHANGELOG.md hasn't been updated within 1 day of the last commit

import {
  blockStop,
  createSessionTask,
  git,
  isGitRepo,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) return

  // Find CHANGELOG.md
  let changelogPath = ""
  if (await Bun.file(`${repoRoot}/CHANGELOG.md`).exists()) {
    changelogPath = "CHANGELOG.md"
  } else {
    const lsFiles = await git(["ls-files", repoRoot], cwd)
    const match = lsFiles.split("\n").find((f) => /^CHANGELOG\.md$/i.test(f))
    if (match) changelogPath = match
  }

  if (!changelogPath) return

  // Timestamp of last commit (any file)
  const lastCommitTime = parseInt(await git(["log", "-1", "--format=%ct"], cwd))
  if (isNaN(lastCommitTime)) return

  // Timestamp of last commit touching CHANGELOG.md
  const changelogTime = parseInt(await git(["log", "-1", "--format=%ct", "--", changelogPath], cwd))
  if (isNaN(changelogTime)) return

  const gap = lastCommitTime - changelogTime
  const ONE_DAY = 86400

  if (gap <= ONE_DAY) return

  const days = Math.floor(gap / 86400)
  const hours = Math.floor((gap % 86400) / 3600)

  await createSessionTask(
    input.session_id,
    "stop-changelog-staleness-task-created",
    "Update CHANGELOG.md",
    `CHANGELOG.md is ${days}d ${hours}h behind the latest commit. Run /changelog to regenerate and commit the updated changelog.`
  )

  const advice = skillAdvice(
    "changelog",
    "Run the /changelog skill to generate and update CHANGELOG.md, then commit the result.",
    "Update CHANGELOG.md with recent changes, then commit the result."
  )

  blockStop(
    `CHANGELOG.md is stale — last updated ${days}d ${hours}h before the most recent commit.\n\n` +
      "The changelog must be kept current with every commit session.\n\n" +
      advice
  )
}

main()
