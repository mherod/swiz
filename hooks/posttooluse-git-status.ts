#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import { toolHookInputSchema } from "./schemas.ts"
import type { GitStatusV2 } from "./utils/git-utils.ts"
import { emitContext, getGitStatusV2, isGitRepo } from "./utils/hook-utils.ts"

/**
 * Build the context line from git status data.
 * Exported for unit testing.
 */
export function buildGitContextLine(gitStatus: GitStatusV2, collabMode: string = "auto"): string {
  const { branch, total: uncommitted, ahead, behind, upstream, upstreamGone } = gitStatus

  let status = `[git] branch: ${branch}`

  if (upstreamGone) {
    status += ` | upstream: ${upstream} (gone)`
  } else if (upstream) {
    status += ` | upstream: ${upstream}`
  } else {
    status += ` | no upstream`
  }

  status += ` | uncommitted files: ${uncommitted}`

  if (ahead > 0 && behind > 0) {
    status += ` | diverged: ${ahead} ahead, ${behind} behind`
  } else if (ahead > 0) {
    status += ` | ${ahead} unpushed commit(s)`
  } else if (behind > 0) {
    status += ` | ${behind} behind remote`
  }

  if (collabMode !== "auto") {
    status += ` | collab: ${collabMode}`
  }

  return status
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  if (!(await isGitRepo(cwd))) return

  // Single subprocess replaces: branch --show-current, status --porcelain,
  // rev-parse @{upstream}, rev-list x2
  const [gitStatus, settings] = await Promise.all([getGitStatusV2(cwd), readSwizSettings()])
  if (!gitStatus) return

  const effective = getEffectiveSwizSettings(settings, input.session_id)
  const status = buildGitContextLine(gitStatus, effective.collaborationMode)

  await emitContext("PostToolUse", status, cwd)
}

if (import.meta.main) void main()
