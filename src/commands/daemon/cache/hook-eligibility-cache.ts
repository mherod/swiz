import { detectProjectStack } from "../../../detect-frameworks.ts"
import { resolvePrMergeActive } from "../../../dispatch/index.ts"
import {
  evalCondition,
  type HookGroup,
  hookIdentifier,
  isInlineHookDef,
  manifest,
} from "../../../manifest.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
  resolveProjectHooks,
} from "../../../settings.ts"
import { getWorkflowIntent } from "../../../state-machine.ts"
import { KeyedAsyncCache } from "../../../utils/keyed-async-cache.ts"

export interface EligibilitySnapshot {
  disabledHooks: string[]
  detectedStacks: string[]
  prMergeActive: boolean
  workflowIntent: string | null
  conditionResults: Record<string, boolean>
  computedAt: number
}

/**
 * Per-project hook eligibility — disabled hooks, detected stacks, evaluated
 * conditions. Entries live until the daemon invalidates them, so no TTL is set.
 */
export class HookEligibilityCache {
  private readonly cache = new KeyedAsyncCache<EligibilitySnapshot>()

  compute(cwd: string): Promise<EligibilitySnapshot> {
    return this.cache.get(cwd, computeEligibility)
  }

  invalidateProject(cwd: string): void {
    this.cache.invalidate(cwd)
  }

  invalidateAll(): void {
    this.cache.invalidateAll()
  }

  get size(): number {
    return this.cache.size
  }
}

async function resolveWorkflowIntent(cwd: string): Promise<string | null> {
  try {
    const state = await readProjectState(cwd)
    return state ? getWorkflowIntent(state) : null
  } catch {
    return null
  }
}

async function evalHookConditions(
  groups: HookGroup[],
  results: Record<string, boolean>
): Promise<void> {
  const pending: Array<{ file: string; condition: string }> = []
  for (const group of groups)
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      if (hook.condition && !(hookIdentifier(hook) in results))
        pending.push({ file: hook.file, condition: hook.condition })
    }

  if (pending.length === 0) return
  const evaluated = await Promise.all(pending.map(({ condition }) => evalCondition(condition)))
  for (let i = 0; i < pending.length; i++) results[pending[i]!.file] = evaluated[i]!
}

async function computeEligibility(cwd: string): Promise<EligibilitySnapshot> {
  const [settings, projectSettings, detectedStacks, workflowIntent] = await Promise.all([
    readSwizSettings(),
    cwd ? readProjectSettings(cwd) : Promise.resolve(null),
    cwd ? detectProjectStack(cwd) : Promise.resolve([]),
    resolveWorkflowIntent(cwd),
  ])
  const effective = getEffectiveSwizSettings(settings, null)

  const disabledSet = new Set([
    ...(settings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])
  const prMergeActive = resolvePrMergeActive(effective.collaborationMode, effective.prMergeMode)

  const conditionResults: Record<string, boolean> = {}
  await evalHookConditions(manifest, conditionResults)
  if (projectSettings?.hooks?.length) {
    const { resolved } = resolveProjectHooks(projectSettings.hooks, cwd)
    await evalHookConditions(resolved, conditionResults)
  }

  return {
    disabledHooks: [...disabledSet],
    detectedStacks,
    prMergeActive,
    workflowIntent,
    conditionResults,
    computedAt: Date.now(),
  }
}
