#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call

import { emitContext, getGitStatusV2 } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  // Single subprocess replaces: rev-parse --git-dir, branch --show-current,
  // status --porcelain, rev-parse @{upstream}, rev-list x2
  const gitStatus = await getGitStatusV2(cwd)
  if (!gitStatus) return

  const { branch, total: uncommitted, ahead, behind } = gitStatus

  let status = `[git] branch: ${branch} | uncommitted files: ${uncommitted}`

  if (ahead > 0 && behind > 0) {
    status += ` | diverged: ${ahead} ahead, ${behind} behind`
  } else if (ahead > 0) {
    status += ` | ${ahead} unpushed commit(s)`
  } else if (behind > 0) {
    status += ` | ${behind} behind remote`
  }

  emitContext("PostToolUse", status, cwd)
}

main()
