#!/usr/bin/env bun

// PostToolUse hook: Inject swiz git settings and branch protection rules after git commands.
// Non-blocking — only emits additionalContext, never denies.
// Uses the SETTINGS_REGISTRY effectExplanation to produce prescriptive directives
// so the agent model is never in doubt about enforced rules.

import type { GitHubBranchProtectionRecord } from "../src/issue-store.ts"
import { getIssueStore } from "../src/issue-store.ts"
import { SETTINGS_REGISTRY } from "../src/settings/registry.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { emitContext, getRepoSlug, git, isGitRepo, isShellTool } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

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

/** Look up the registry effectExplanation for a setting key. */
function getEffectExplanation(key: string): string | undefined {
  const def = SETTINGS_REGISTRY.find((d) => d.key === key)
  return def?.docs?.effectExplanation
}

/** Build a directive line for a boolean setting. */
function booleanDirective(key: string, value: boolean): string {
  const explanation = getEffectExplanation(key)
  const state = value ? "enabled" : "disabled"
  if (explanation) return `${key}: ${state} — ${explanation}`
  return `${key}: ${state}`
}

/** Build a directive line for an enum/numeric setting. */
function valueDirective(key: string, value: unknown): string {
  const explanation = getEffectExplanation(key)
  if (explanation) return `${key}: ${String(value)} — ${explanation}`
  return `${key}: ${String(value)}`
}

function buildSettingsDirectives(settings: Record<string, unknown>): string[] {
  const directives: string[] = []
  for (const key of GIT_RELEVANT_KEYS) {
    const value = settings[key]
    if (value === undefined) continue
    if (typeof value === "boolean") {
      directives.push(booleanDirective(key, value))
    } else {
      directives.push(valueDirective(key, value))
    }
  }
  return directives
}

function buildProtectionDirectives(
  branch: string,
  protection: GitHubBranchProtectionRecord
): string[] {
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
    return [`Branch protection rules for '${branch}': ${rules.join(". ")}.`]
  }
  return []
}

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

  // Resolve effective settings — prefer dispatcher-injected, fall back to disk read.
  const injected = (input as Record<string, unknown>)._effectiveSettings as
    | Record<string, unknown>
    | undefined
  let settings: Record<string, unknown>
  if (injected && typeof injected.trunkMode !== "undefined") {
    settings = injected
  } else {
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

  const lines = buildSettingsDirectives(settings)

  if (branch && repoSlug) {
    const store = getIssueStore()
    const protection = store.getBranchProtection<GitHubBranchProtectionRecord>(repoSlug, branch)
    if (protection) {
      lines.push(...buildProtectionDirectives(branch, protection))
    }
  }

  if (lines.length > 0) {
    await emitContext("PostToolUse", lines.join("\n"))
  }
}

if (import.meta.main) void main()
