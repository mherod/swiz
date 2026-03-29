#!/usr/bin/env bun

// PostToolUse hook: Inject swiz git settings and branch protection rules after git commands.
// Non-blocking — only emits additionalContext, never denies.

import type { GitHubBranchProtectionRecord } from "../src/issue-store.ts"
import { getIssueStore } from "../src/issue-store.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { emitContext, getRepoSlug, git, isGitRepo, isShellTool } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const GIT_CMD_RE = /\bgit\b/

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const { tool_name, cwd } = input
  if (!tool_name || !isShellTool(tool_name) || !cwd) return
  const command: string = ((input.tool_input as Record<string, unknown>)?.command as string) ?? ""
  if (!GIT_CMD_RE.test(command)) return
  if (!(await isGitRepo(cwd))) return

  const [branch, repoSlug] = await Promise.all([
    git(["branch", "--show-current"], cwd),
    getRepoSlug(cwd),
  ])

  const lines: string[] = []

  // Prefer dispatcher-provided effective settings; fall back to computing locally.
  const injected = (input as Record<string, unknown>)._effectiveSettings as
    | Record<string, unknown>
    | undefined
  let trunkMode: boolean
  let pushGate: boolean
  let collaborationMode: string
  let strictNoDirectMain: boolean
  if (injected && typeof injected.trunkMode !== "undefined") {
    trunkMode = Boolean(injected.trunkMode)
    pushGate = Boolean(injected.pushGate)
    collaborationMode = String(injected.collaborationMode ?? "auto")
    strictNoDirectMain = Boolean(injected.strictNoDirectMain)
  } else {
    const [swizSettings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const eff = getEffectiveSwizSettings(swizSettings, input.session_id, projectSettings)
    trunkMode = eff.trunkMode
    pushGate = eff.pushGate
    collaborationMode = eff.collaborationMode
    strictNoDirectMain = eff.strictNoDirectMain
  }

  lines.push(
    `[git-settings] trunk:${trunkMode} push-gate:${pushGate} collab:${collaborationMode} strict-no-direct-main:${strictNoDirectMain}`
  )

  if (branch && repoSlug) {
    const store = getIssueStore()
    const protection = store.getBranchProtection<GitHubBranchProtectionRecord>(repoSlug, branch)
    if (protection) {
      const parts: string[] = []
      if (protection.requiredReviews) {
        parts.push(`required-reviews:${protection.requiredReviews.requiredApprovingReviewCount}`)
      }
      if (protection.requiredStatusChecks) {
        parts.push(`required-checks:${protection.requiredStatusChecks.contexts.length}`)
      }
      if (protection.enforceAdmins) parts.push("enforce-admins")
      if (protection.requiredLinearHistory) parts.push("linear-history")
      if (!protection.allowForcePushes) parts.push("no-force-push")
      lines.push(
        `[branch-protection:${branch}] ${parts.length > 0 ? parts.join(" | ") : "configured"}`
      )
    }
  }

  await emitContext("PostToolUse", lines.join("\n"))
}

if (import.meta.main) void main()
