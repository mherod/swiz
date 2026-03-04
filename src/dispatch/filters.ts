/**
 * Hook filtering — cooldown, PR-merge-mode, disabled hooks, stack filtering,
 * and settings-based filtering.
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { detectProjectStack } from "../detect-frameworks.ts"
import type { HookGroup } from "../manifest.ts"
import {
  type CollaborationMode,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../settings.ts"

// ─── Constants ──────────────────────────────────────────────────────────────

const PR_MERGE_MODE_DISABLED_HOOKS = new Set([
  "posttooluse-pr-context.ts",
  "pretooluse-pr-age-gate.ts",
  "stop-branch-conflicts.ts",
  "stop-pr-description.ts",
  "stop-pr-changes-requested.ts",
  "stop-github-ci.ts",
])

// ─── Per-hook cooldown ──────────────────────────────────────────────────────

export function hookCooldownPath(hookFile: string, cwd: string): string {
  const key = Bun.hash(hookFile + cwd).toString(16)
  return `/tmp/swiz-hook-cooldown-${key}.timestamp`
}

export function isWithinCooldown(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
  const sentinelPath = hookCooldownPath(hookFile, cwd)
  if (!existsSync(sentinelPath)) return false
  try {
    const raw = readFileSync(sentinelPath, "utf8").trim()
    const lastRun = parseInt(raw, 10)
    if (Number.isNaN(lastRun)) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  } catch {
    return false
  }
}

export function markHookCooldown(hookFile: string, cwd: string): void {
  try {
    writeFileSync(hookCooldownPath(hookFile, cwd), String(Date.now()))
  } catch {
    // Non-fatal: if sentinel write fails the hook just runs again next time
  }
}

// ─── Payload helpers ────────────────────────────────────────────────────────

export function extractCwd(payloadStr: string): string {
  try {
    const parsed = JSON.parse(payloadStr) as Record<string, unknown>
    return (parsed.cwd as string) || ""
  } catch {
    return ""
  }
}

export function countHooks(groups: HookGroup[]): number {
  return groups.reduce((total, group) => total + group.hooks.length, 0)
}

// ─── Group filters ──────────────────────────────────────────────────────────

/**
 * Resolve whether PR-merge hooks should be active based on collaborationMode
 * and the legacy prMergeMode boolean.
 *
 * - `team` → always enable PR-merge hooks
 * - `solo` → always disable PR-merge hooks
 * - `auto` → fall back to prMergeMode boolean
 */
export function resolvePrMergeActive(
  collaborationMode: CollaborationMode,
  prMergeMode: boolean
): boolean {
  if (collaborationMode === "team") return true
  if (collaborationMode === "solo") return false
  return prMergeMode // auto: use legacy boolean
}

export function filterPrMergeModeHooks(
  groups: HookGroup[],
  prMergeMode: boolean,
  collaborationMode: CollaborationMode = "auto"
): HookGroup[] {
  if (resolvePrMergeActive(collaborationMode, prMergeMode)) return groups

  return groups
    .map((group) => {
      const hooks = group.hooks.filter((hook) => !PR_MERGE_MODE_DISABLED_HOOKS.has(hook.file))
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

export function filterDisabledHooks(groups: HookGroup[], disabledHooks: Set<string>): HookGroup[] {
  if (disabledHooks.size === 0) return groups

  return groups
    .map((group) => {
      const hooks = group.hooks.filter((hook) => !disabledHooks.has(hook.file))
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

export function filterStackHooks(groups: HookGroup[], detectedStacks: string[]): HookGroup[] {
  if (detectedStacks.length === 0) return groups

  const stackSet = new Set(detectedStacks)
  return groups
    .map((group) => {
      const hooks = group.hooks.filter(
        (hook) => !hook.stacks || hook.stacks.some((s) => stackSet.has(s))
      )
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

// ─── Composite settings filter ──────────────────────────────────────────────

export async function applyHookSettingFilters(
  groups: HookGroup[],
  payload: Record<string, unknown>
): Promise<HookGroup[]> {
  const settings = await readSwizSettings()
  const cwd = (payload.cwd as string | undefined) ?? ""
  const projectSettings = cwd ? await readProjectSettings(cwd) : null
  const rawSessionId = payload.session_id ?? payload.sessionId
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : null
  const effective = getEffectiveSwizSettings(settings, sessionId)

  const disabledSet = new Set([
    ...(settings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])

  const detectedStacks = cwd ? detectProjectStack(cwd) : []
  const filtered = filterPrMergeModeHooks(
    groups,
    effective.prMergeMode,
    effective.collaborationMode
  )
  const stackFiltered = filterStackHooks(filtered, detectedStacks)
  return filterDisabledHooks(stackFiltered, disabledSet)
}
