#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import { emitContext, getGitStatusV2, isGitRepo } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

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
  const collabMode = effective.collaborationMode
  const { branch, total: uncommitted, ahead, behind } = gitStatus

  let status = `[git] branch: ${branch} | uncommitted files: ${uncommitted}`

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

  await emitContext("PostToolUse", status, cwd)
}

if (import.meta.main) void main()
