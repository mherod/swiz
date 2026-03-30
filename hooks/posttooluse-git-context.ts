#!/usr/bin/env bun

// PostToolUse hook: Inject swiz git settings and branch protection rules after git commands
// when the worktree has uncommitted changes (dirty workflow). Clean trees stay silent.
// Non-blocking — only emits additionalContext, never denies.
// Uses the SETTINGS_REGISTRY effectExplanation to produce prescriptive directives
// so the agent model is never in doubt about enforced rules.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { ToolHookInput } from "./schemas.ts"

const GIT_CMD_RE = /\bgit\b/

/** Settings keys relevant to git operations — emitted as context after every git command. */
const GIT_RELEVANT_KEYS: readonly string[] = [
  "trunkMode",
  "pushGate",
  "strictNoDirectMain",
  "collaborationMode",
  "gitStatusGate",
  "nonDefaultBranchGate",
  "githubCiGate",
  "ignoreCi",
  "changesRequestedGate",
  "qualityChecksGate",
  "skipSecretScan",
  "prMergeMode",
  "prAgeGateMinutes",
  "pushCooldownMinutes",
]

const posttoolusGitContext: SwizHook<ToolHookInput> = {
  name: "posttooluse-git-context",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    const { tool_name, cwd } = input
    if (!tool_name || !cwd) return {}

    const { buildContextHookOutput, isShellTool, git, getRepoSlug, isGitRepo } = await import(
      "../src/utils/hook-utils.ts"
    )
    if (!isShellTool(tool_name)) return {}
    const command: string = ((input.tool_input as Record<string, unknown>)?.command as string) ?? ""
    if (!GIT_CMD_RE.test(command)) return {}
    if (!(await isGitRepo(cwd))) return {}

    const [porcelain, branch, repoSlug] = await Promise.all([
      git(["status", "--porcelain"], cwd),
      git(["branch", "--show-current"], cwd),
      getRepoSlug(cwd),
    ])
    if (!porcelain.trim()) return {}

    // Resolve effective settings — prefer dispatcher-injected, fall back to disk read.
    const injected = (input as Record<string, unknown>)._effectiveSettings as
      | Record<string, unknown>
      | undefined
    let settings: Record<string, unknown>
    if (injected && typeof injected.trunkMode !== "undefined") {
      settings = injected
    } else {
      const { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } = await import(
        "../src/settings.ts"
      )
      const [swizSettings, projectSettings] = await Promise.all([
        readSwizSettings(),
        readProjectSettings(cwd),
      ])
      settings = getEffectiveSwizSettings(
        swizSettings,
        input.session_id,
        projectSettings
      ) as unknown as Record<string, unknown>
    }

    const { SETTINGS_REGISTRY } = await import("../src/settings.ts")

    function getEffectExplanation(key: string): string | undefined {
      const def = SETTINGS_REGISTRY.find((d) => d.key === key)
      return def?.docs?.effectExplanation
    }

    function booleanDirective(key: string, value: boolean): string {
      const explanation = getEffectExplanation(key)
      const state = value ? "enabled" : "disabled"
      if (explanation) return `${key}: ${state} — ${explanation}`
      return `${key}: ${state}`
    }

    function valueDirective(key: string, value: unknown): string {
      const explanation = getEffectExplanation(key)
      if (explanation) return `${key}: ${String(value)} — ${explanation}`
      return `${key}: ${String(value)}`
    }

    const lines: string[] = []
    for (const key of GIT_RELEVANT_KEYS) {
      const value = settings[key]
      if (value === undefined) continue
      if (typeof value === "boolean") {
        lines.push(booleanDirective(key, value))
      } else {
        lines.push(valueDirective(key, value))
      }
    }

    if (branch && repoSlug) {
      const { getIssueStore } = await import("../src/issue-store.ts")
      const store = getIssueStore()
      type BranchProtection = {
        requiredReviews?: { requiredApprovingReviewCount: number }
        requiredStatusChecks?: { contexts: string[] }
        enforceAdmins?: boolean
        requiredLinearHistory?: boolean
        allowForcePushes?: boolean
        allowDeletions?: boolean
      }
      const protection = store.getBranchProtection<BranchProtection>(repoSlug, branch)
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
        if (protection.requiredLinearHistory)
          rules.push("Linear history required — no merge commits")
        if (!protection.allowForcePushes) rules.push("Force push is FORBIDDEN on this branch")
        if (!protection.allowDeletions) rules.push("Branch deletion is forbidden")
        if (rules.length > 0) {
          lines.push(`Branch protection rules for '${branch}': ${rules.join(". ")}.`)
        }
      }
    }

    if (lines.length > 0) {
      return buildContextHookOutput("PostToolUse", lines.join("\n"))
    }

    return {}
  },
}

export default posttoolusGitContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusGitContext)
}
