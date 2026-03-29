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

  // Emit prescriptive directives so the model knows what the enforced rules are.
  if (trunkMode) {
    lines.push(
      "Trunk mode enabled — commit and push directly to the default branch. No feature branches required."
    )
  } else {
    lines.push("Trunk mode disabled — use feature branches and pull requests for all changes.")
  }

  if (pushGate) {
    lines.push(
      "Push gate ON — you MUST invoke the /push skill before running git push. Bare git push is blocked."
    )
  }

  if (strictNoDirectMain) {
    lines.push(
      "Strict no-direct-main — direct pushes to main/master are forbidden. Always use a feature branch and PR."
    )
  }

  if (collaborationMode === "solo") {
    lines.push(
      "Collaboration mode: solo — this is a single-contributor repo. Direct push to main is permitted."
    )
  } else if (collaborationMode === "team") {
    lines.push(
      "Collaboration mode: team — always use feature branches and PRs, even for trivial changes."
    )
  } else if (collaborationMode === "relaxed-collab") {
    lines.push(
      "Collaboration mode: relaxed — use branches for features but trivial fixes can go directly to main."
    )
  }

  if (branch && repoSlug) {
    const store = getIssueStore()
    const protection = store.getBranchProtection<GitHubBranchProtectionRecord>(repoSlug, branch)
    if (protection) {
      const rules: string[] = []
      if (protection.requiredReviews) {
        const count = protection.requiredReviews.requiredApprovingReviewCount
        rules.push(`${count} approving review(s) required before merge`)
      }
      if (protection.requiredStatusChecks) {
        const checks = protection.requiredStatusChecks.contexts
        if (checks.length > 0) {
          rules.push(`Required status checks: ${checks.join(", ")}`)
        }
      }
      if (protection.enforceAdmins) rules.push("Rules enforced for admins too")
      if (protection.requiredLinearHistory) rules.push("Linear history required — no merge commits")
      if (!protection.allowForcePushes) rules.push("Force push is FORBIDDEN on this branch")
      if (!protection.allowDeletions) rules.push("Branch deletion is forbidden")
      if (rules.length > 0) {
        lines.push(`Branch protection rules for '${branch}': ${rules.join(". ")}.`)
      }
    }
  }

  await emitContext("PostToolUse", lines.join("\n"))
}

if (import.meta.main) void main()
