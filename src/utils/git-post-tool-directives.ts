/**
 * Build PostToolUse git-context strings: effective-setting lines and branch protection summaries.
 */

import type { IssueStore } from "../issue-store.ts"
import { SETTINGS_REGISTRY } from "../settings/registry.ts"
import type { EffectiveSwizSettings } from "../settings.ts"

/** Settings keys emitted after git commands when the worktree is dirty. */
export const GIT_RELEVANT_SETTING_KEYS: readonly string[] = [
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

/**
 * One line per relevant setting that is defined on `settings`.
 */
export function buildGitRelevantSettingLines(
  settings: EffectiveSwizSettings | Record<string, any>
): string[] {
  const rec = settings as Record<string, any>
  const lines: string[] = []
  for (const key of GIT_RELEVANT_SETTING_KEYS) {
    const value = rec[key]
    if (value === undefined) continue
    if (typeof value === "boolean") {
      lines.push(booleanDirective(key, value))
    } else {
      lines.push(valueDirective(key, value))
    }
  }
  return lines
}

export interface BranchProtectionSummary {
  requiredReviews?: { requiredApprovingReviewCount: number }
  requiredStatusChecks?: { contexts: string[] }
  enforceAdmins?: boolean
  requiredLinearHistory?: boolean
  allowForcePushes?: boolean
  allowDeletions?: boolean
}

/**
 * Human-readable branch protection sentence, or null when there is nothing to report.
 */
export function formatBranchProtectionContextLine(
  branch: string,
  protection: BranchProtectionSummary | null | undefined
): string | null {
  if (!protection) return null
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
  if (rules.length === 0) return null
  return `Branch protection rules for '${branch}': ${rules.join(". ")}.`
}

/**
 * Append branch protection line from {@link IssueStore} when `branch` and `repoSlug` are set.
 */
export function appendBranchProtectionFromStore(
  lines: string[],
  store: IssueStore,
  repoSlug: string,
  branch: string
): void {
  const protection = store.getBranchProtection<BranchProtectionSummary>(repoSlug, branch)
  const line = formatBranchProtectionContextLine(branch, protection)
  if (line) lines.push(line)
}
