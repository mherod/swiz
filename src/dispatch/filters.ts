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
  readProjectState,
  readSwizSettings,
} from "../settings.ts"
import { getWorkflowIntent } from "../state-machine.ts"

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
  collaborationMode: CollaborationMode = "auto",
  prAgeGateMinutes = 0
): HookGroup[] {
  if (resolvePrMergeActive(collaborationMode, prMergeMode)) return groups

  // When a grace period is configured, keep the age-gate hook active even if
  // PR-merge mode is disabled — the setting takes precedence over mode filtering.
  const settingsPreserved = new Set<string>()
  if (prAgeGateMinutes > 0) settingsPreserved.add("pretooluse-pr-age-gate.ts")

  return groups
    .map((group) => {
      const hooks = group.hooks.filter(
        (hook) => !PR_MERGE_MODE_DISABLED_HOOKS.has(hook.file) || settingsPreserved.has(hook.file)
      )
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

// ─── State-based filtering ──────────────────────────────────────────────────

/**
 * Hooks that should be skipped when the project is in terminal states (released, paused).
 * These hooks are designed for active development and make no sense in terminal states.
 */
const ACTIVE_DEVELOPMENT_ONLY_HOOKS = new Set([
  "posttooluse-git-task-autocomplete.ts", // Suggests task creation only during active work
  "pretooluse-state-gate.ts", // Enforces development-related state gates
  "posttooluse-task-advisor.ts", // Suggests follow-up tasks during active development
])

export async function filterStateHooks(groups: HookGroup[], cwd: string): Promise<HookGroup[]> {
  try {
    const state = await readProjectState(cwd)
    if (!state) return groups

    const intent = getWorkflowIntent(state)

    // In paused/released states, skip hooks that only make sense during active development
    if (intent === "paused-work" || intent === "released-stable") {
      return groups
        .map((group) => {
          const hooks = group.hooks.filter((hook) => !ACTIVE_DEVELOPMENT_ONLY_HOOKS.has(hook.file))
          return hooks.length === group.hooks.length ? group : { ...group, hooks }
        })
        .filter((group) => group.hooks.length > 0)
    }

    return groups
  } catch {
    // If state reading fails, proceed without state-based filtering
    return groups
  }
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
    effective.collaborationMode,
    effective.prAgeGateMinutes
  )
  const stackFiltered = filterStackHooks(filtered, detectedStacks)
  const stateFiltered = await filterStateHooks(stackFiltered, cwd)
  return filterDisabledHooks(stateFiltered, disabledSet)
}
