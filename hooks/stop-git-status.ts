#!/usr/bin/env bun
// Stop hook: Block stop if git repository has uncommitted changes

import {
  blockStop,
  createSessionTask,
  git,
  isGitRepo,
  parseGitStatus,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  const porcelain = await git(["status", "--porcelain"], cwd)
  if (!porcelain) return

  const { total, modified, added, deleted, untracked, lines } = parseGitStatus(porcelain)

  const parts: string[] = []
  if (modified > 0) parts.push(`${modified} modified`)
  if (added > 0) parts.push(`${added} added`)
  if (deleted > 0) parts.push(`${deleted} deleted`)
  if (untracked > 0) parts.push(`${untracked} untracked`)
  const summary = parts.join(", ")

  let reason = "Uncommitted changes detected in git repository.\n\n"
  reason += `Status: ${summary} (${total} file(s))\n\n`
  reason += "Files with changes:\n"
  reason += lines
    .slice(0, 20)
    .map((l) => `  ${l}`)
    .join("\n")
  if (total > 20) reason += `\n  ... and ${total - 20} more file(s)`
  reason +=
    "\n\n" +
    skillAdvice(
      "commit",
      "Use the /commit skill to review and commit your changes before stopping.",
      'Stage and commit your changes before stopping:\n  git add .\n  git commit -m "<type>(<scope>): <summary>"'
    )

  await createSessionTask(
    input.session_id,
    "stop-git-status-task-created",
    "Commit uncommitted changes",
    `Git repository at ${cwd} has uncommitted changes (${summary}). Stage and commit your changes before stopping.`
  )

  blockStop(reason)
}

main()
