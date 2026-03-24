/**
 * Hook filtering — cooldown, PR-merge-mode, disabled hooks, stack filtering,
 * and settings-based filtering.
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { readFile, writeFile } from "node:fs/promises"
import { isEmergencyBypassActive } from "../commands/emergency-bypass.ts"
import { detectProjectStack } from "../detect-frameworks.ts"
import { getCanonicalPathHash } from "../git-helpers.ts"
import type { HookGroup } from "../manifest.ts"
import {
  type CollaborationMode,
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  type ProjectSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../settings.ts"
import { getWorkflowIntent } from "../state-machine.ts"
import { swizHookCooldownPath } from "../temp-paths.ts"

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
  return swizHookCooldownPath(key)
}

export async function isWithinCooldown(
  hookFile: string,
  cooldownSeconds: number,
  cwd: string
): Promise<boolean> {
  const sentinelPath = hookCooldownPath(hookFile, cwd)
  try {
    const raw = (await readFile(sentinelPath, "utf8")).trim()
    const lastRun = parseInt(raw, 10)
    if (Number.isNaN(lastRun)) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  } catch {
    return false
  }
}

export function markHookCooldown(hookFile: string, cwd: string): Promise<void> {
  return writeFile(hookCooldownPath(hookFile, cwd), String(Date.now())).catch(() => {
    // Non-fatal: if sentinel write fails the hook just runs again next time
  })
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
 * Filter hooks from groups using a predicate, preserving group references when
 * no hooks are removed and dropping groups that become empty.
 *
 * Extracted from 5 duplicate inline implementations (issue #351).
 */
export function filterHooksFromGroups(
  groups: HookGroup[],
  predicate: (hook: HookGroup["hooks"][number]) => boolean
): HookGroup[] {
  return groups
    .map((group) => {
      const hooks = group.hooks.filter(predicate)
      return hooks.length === group.hooks.length ? group : { ...group, hooks }
    })
    .filter((group) => group.hooks.length > 0)
}

/**
 * Resolve whether PR-merge hooks should be active based on collaborationMode
 * and the legacy prMergeMode boolean.
 *
 * - `team` → always enable PR-merge hooks
 * - `relaxed-collab` → always enable PR-merge hooks (branch/PR hygiene without peer-review requirement)
 * - `solo` → always disable PR-merge hooks
 * - `auto` → fall back to prMergeMode boolean
 */
export function resolvePrMergeActive(
  collaborationMode: CollaborationMode,
  prMergeMode: boolean
): boolean {
  if (collaborationMode === "team" || collaborationMode === "relaxed-collab") return true
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

  return filterHooksFromGroups(
    groups,
    (hook) => !PR_MERGE_MODE_DISABLED_HOOKS.has(hook.file) || settingsPreserved.has(hook.file)
  )
}

export function filterDisabledHooks(groups: HookGroup[], disabledHooks: Set<string>): HookGroup[] {
  if (disabledHooks.size === 0) return groups

  return filterHooksFromGroups(groups, (hook) => !disabledHooks.has(hook.file))
}

export function filterStackHooks(groups: HookGroup[], detectedStacks: string[]): HookGroup[] {
  if (detectedStacks.length === 0) return groups

  const stackSet = new Set(detectedStacks)
  return filterHooksFromGroups(
    groups,
    (hook) => !hook.stacks || hook.stacks.some((s) => stackSet.has(s))
  )
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

    // In planning/reviewing states, skip hooks that only make sense during active development
    if (intent === "planning-work" || intent === "awaiting-review") {
      return filterHooksFromGroups(groups, (hook) => !ACTIVE_DEVELOPMENT_ONLY_HOOKS.has(hook.file))
    }

    return groups
  } catch {
    // If state reading fails, proceed without state-based filtering
    return groups
  }
}

// ─── Required-settings filter ────────────────────────────────────────────────

/**
 * Remove hooks whose `requiredSettings` are not all truthy in the effective
 * settings.  This is a zero-cost fast path — the dispatcher skips the hook
 * entirely without spawning a process.
 */
export function filterRequiredSettingsHooks(
  groups: HookGroup[],
  effective: EffectiveSwizSettings
): HookGroup[] {
  return filterHooksFromGroups(groups, (hook) => {
    if (!hook.requiredSettings || hook.requiredSettings.length === 0) return true
    return hook.requiredSettings.every((key) => !!effective[key])
  })
}

// ─── Composite settings filter ──────────────────────────────────────────────

function applyFilterPipeline(
  groups: HookGroup[],
  effective: ReturnType<typeof getEffectiveSwizSettings>,
  disabledSet: Set<string>,
  detectedStacks: string[]
): HookGroup[] {
  let result = filterPrMergeModeHooks(
    groups,
    effective.prMergeMode,
    effective.collaborationMode,
    effective.prAgeGateMinutes
  )
  result = filterRequiredSettingsHooks(result, effective)
  result = filterStackHooks(result, detectedStacks)
  return filterDisabledHooks(result, disabledSet)
}

async function loadFilterSettings(
  payload: Record<string, unknown>,
  preloadedProjectSettings?: ProjectSwizSettings | null
) {
  const cwd = (payload.cwd as string | undefined) ?? ""
  const [settings, projectSettings, detectedStacks] = await Promise.all([
    readSwizSettings(),
    preloadedProjectSettings !== undefined
      ? Promise.resolve(preloadedProjectSettings)
      : cwd
        ? readProjectSettings(cwd)
        : Promise.resolve(null),
    cwd ? detectProjectStack(cwd) : Promise.resolve([]),
  ])
  const rawSessionId = payload.session_id ?? payload.sessionId
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : null
  const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings)
  const disabledSet = new Set([
    ...(settings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])
  return { cwd, effective, disabledSet, detectedStacks }
}

export async function applyHookSettingFilters(
  groups: HookGroup[],
  payload: Record<string, unknown>,
  preloadedProjectSettings?: ProjectSwizSettings | null
): Promise<HookGroup[]> {
  const { cwd, effective, disabledSet, detectedStacks } = await loadFilterSettings(
    payload,
    preloadedProjectSettings
  )

  const filtered = applyFilterPipeline(groups, effective, disabledSet, detectedStacks)
  const stateFiltered = await filterStateHooks(filtered, cwd)

  if (cwd) {
    const repoKey = getCanonicalPathHash(cwd)
    if (await isEmergencyBypassActive(repoKey)) {
      return stateFiltered.filter((g) => g.event !== "preToolUse")
    }
  }
  return stateFiltered
}
