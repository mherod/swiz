#!/usr/bin/env bun

// Stop hook: Block stop when the remote has too many branches.
// Fires when `origin` has more than BRANCH_LIMIT remote-tracking branches.
// Cooldown (cooldownSeconds: 7200 in manifest) is enforced by the dispatcher.

import { stopHookInputSchema } from "./schemas.ts"
import { blockStop, git, isGitRepo, skillAdvice } from "./utils/hook-utils.ts"

const BRANCH_LIMIT = 40

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  // List remote-tracking branches. Fail-open: empty output or git errors skip the check.
  const raw = await git(["branch", "-r"], cwd)
  if (!raw) return

  // Exclude symbolic refs (e.g. "origin/HEAD -> origin/main") and empty lines.
  const branches = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes("->"))

  const count = branches.length
  if (count <= BRANCH_LIMIT) return

  const excess = count - BRANCH_LIMIT
  const reason =
    `Remote 'origin' has ${count} branches (limit: ${BRANCH_LIMIT}, ${excess} over limit).\n\n` +
    `Too many stale branches accumulate over time and slow down git operations, ` +
    `code review, and branch listing. Prune merged and unused branches before stopping.\n\n` +
    skillAdvice(
      "prune-branches",
      "Use the /prune-branches skill to clean up merged and unused branches.",
      `Prune stale branches:\n` +
        `  git fetch --prune\n` +
        `  git branch -r --merged origin/main | grep -v "origin/main" | ` +
        `sed 's|^\\s*origin/||' | xargs -I{} git push origin --delete {}`
    )

  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
