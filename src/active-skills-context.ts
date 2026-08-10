import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"
import {
  formatCurrentSessionUsageWindow,
  formatSkillFileReadFallback,
  getRecentlyInvokedSkillsForCurrentSession,
  type ResolvedSkillFile,
  resolveSkillFilePathForHookPayload,
  resolveSkillRecencyOptions,
} from "./skill-utils.ts"

const activeSkillsContextCache = new Map<string, Promise<string | null>>()
const ACTIVE_SKILLS_CONTEXT_CACHE_MAX = 128

interface ActiveSkillsEnrichment {
  _currentSessionToolUsage?: { events?: unknown[] }
  _effectiveSettings?: {
    skillRecencyMaxAgeMinutes?: unknown
    skillRecencyMaxTurns?: unknown
  }
  _lastUserMessageAt?: unknown
  _transcriptSummary?: { skillInvocations?: unknown[] }
}

function recencyFromEffectiveSettings(input: ToolHookInput): {
  recencyOptions: { maxTurns: number; maxAgeMs: number }
  windowText: string
} | null {
  const effective = (input as ToolHookInput & ActiveSkillsEnrichment)._effectiveSettings
  const maxTurns = effective?.skillRecencyMaxTurns
  const maxAgeMinutes = effective?.skillRecencyMaxAgeMinutes
  if (
    typeof maxTurns !== "number" ||
    !Number.isFinite(maxTurns) ||
    maxTurns <= 0 ||
    typeof maxAgeMinutes !== "number" ||
    !Number.isFinite(maxAgeMinutes) ||
    maxAgeMinutes <= 0
  ) {
    return null
  }
  const recencyOptions = { maxTurns, maxAgeMs: maxAgeMinutes * 60 * 1000 }
  return { recencyOptions, windowText: formatCurrentSessionUsageWindow(recencyOptions) }
}

function activeSkillsCacheKey(
  input: ToolHookInput,
  includeVerifiedSkillPaths: boolean
): string | null {
  const enriched = input as ToolHookInput & ActiveSkillsEnrichment
  if (
    !enriched._currentSessionToolUsage &&
    !enriched._transcriptSummary &&
    enriched._lastUserMessageAt === undefined
  ) {
    return null
  }
  const usage = enriched._currentSessionToolUsage
  const events = Array.isArray(usage?.events) ? usage.events.slice(-12) : []
  const skills = Array.isArray(enriched._transcriptSummary?.skillInvocations)
    ? enriched._transcriptSummary.skillInvocations
    : []
  return JSON.stringify([
    input.session_id ?? "",
    input.cwd ?? "",
    enriched._lastUserMessageAt ?? null,
    events,
    skills,
    enriched._effectiveSettings?.skillRecencyMaxTurns ?? null,
    enriched._effectiveSettings?.skillRecencyMaxAgeMinutes ?? null,
    includeVerifiedSkillPaths,
  ])
}

export function formatActiveSkillsContext(
  skills: string[],
  windowText: string,
  skillFiles: readonly ResolvedSkillFile[] = []
): string {
  const active = `Recently active skills (${windowText}): ${skills.map((skill) => `/${skill}`).join(", ")}.`
  return skillFiles.length > 0 ? `${active}\n${formatSkillFileReadFallback(skillFiles)}` : active
}

export async function resolveActiveSkillsContext(
  input: ToolHookInput,
  options: { includeVerifiedSkillPaths?: boolean } = {}
): Promise<string | null> {
  const includeVerifiedSkillPaths = options.includeVerifiedSkillPaths === true
  const cacheKey = activeSkillsCacheKey(input, includeVerifiedSkillPaths)
  if (cacheKey) {
    const cached = activeSkillsContextCache.get(cacheKey)
    if (cached) return cached
    const resolution = resolveActiveSkillsContextUncached(input, includeVerifiedSkillPaths)
    activeSkillsContextCache.set(cacheKey, resolution)
    if (activeSkillsContextCache.size > ACTIVE_SKILLS_CONTEXT_CACHE_MAX) {
      const oldest = activeSkillsContextCache.keys().next().value
      if (oldest !== undefined) activeSkillsContextCache.delete(oldest)
    }
    return resolution
  }
  return resolveActiveSkillsContextUncached(input, includeVerifiedSkillPaths)
}

async function resolveActiveSkillsContextUncached(
  input: ToolHookInput,
  includeVerifiedSkillPaths: boolean
): Promise<string | null> {
  try {
    const hookInput: ToolHookInput = toolHookInputSchema.parse(input)
    const cwd = hookInput.cwd ?? process.cwd()
    const { recencyOptions, windowText } =
      recencyFromEffectiveSettings(hookInput) ?? (await resolveSkillRecencyOptions(cwd))
    const skills = await getRecentlyInvokedSkillsForCurrentSession(hookInput, recencyOptions)
    if (skills.length === 0) return null
    const skillFiles = includeVerifiedSkillPaths
      ? skills.flatMap((name) => {
          const path = resolveSkillFilePathForHookPayload(name, hookInput, cwd)
          return path ? [{ name, path }] : []
        })
      : []
    return formatActiveSkillsContext(skills, windowText, skillFiles)
  } catch {
    return null
  }
}
