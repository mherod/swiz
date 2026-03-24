#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call

import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
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
  const gitStatus = await getGitStatusV2(cwd)
  if (!gitStatus) return

  // Prefer dispatcher-provided effective settings; fall back to computing locally.
  const injected = (input as Record<string, unknown>)._effectiveSettings as
    | Record<string, unknown>
    | undefined
  let collabMode: string
  if (injected && typeof injected.collaborationMode === "string") {
    collabMode = injected.collaborationMode
  } else {
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    collabMode = getEffectiveSwizSettings(
      settings,
      input.session_id,
      projectSettings
    ).collaborationMode
  }
  const status = buildGitContextLine(gitStatus, collabMode)

  await emitContext("PostToolUse", status, cwd)
}

if (import.meta.main) void main()
