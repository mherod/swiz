import { z } from "zod"
import { type JsonLike, type ToolHookInput, toolHookInputSchema } from "./schemas.ts"
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

const activeSkillsEnrichmentSchema = z.looseObject({
  _currentSessionToolUsage: z
    .looseObject({
      events: z.array(z.record(z.string(), z.custom<JsonLike>())).optional(),
    })
    .optional(),
  _effectiveSettings: z
    .looseObject({
      skillRecencyMaxAgeMinutes: z.number().optional(),
      skillRecencyMaxTurns: z.number().optional(),
    })
    .optional(),
  _lastUserMessageAt: z.union([z.string(), z.number()]).optional(),
  _transcriptSummary: z
    .looseObject({
      skillInvocations: z.array(z.string()).optional(),
    })
    .optional(),
})

type ActiveSkillsEnrichment = z.infer<typeof activeSkillsEnrichmentSchema>

function recencyFromEffectiveSettings(input: ToolHookInput): {
  recencyOptions: { maxTurns: number; maxAgeMs: number }
  windowText: string
} | null {
  const parsed = activeSkillsEnrichmentSchema.safeParse(input)
  const effective = parsed.success ? parsed.data._effectiveSettings : undefined
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

function hasEnrichmentData(enriched: ActiveSkillsEnrichment): boolean {
  return (
    enriched._currentSessionToolUsage !== undefined ||
    enriched._transcriptSummary !== undefined ||
    enriched._lastUserMessageAt !== undefined
  )
}

function extractRecentUsageEvents(usage?: { events?: JsonLike[] }): JsonLike[] {
  return Array.isArray(usage?.events) ? usage.events.slice(-12) : []
}

function buildCacheKeyPayload(
  input: ToolHookInput,
  enriched: ActiveSkillsEnrichment,
  includeVerifiedSkillPaths: boolean
): readonly JsonLike[] {
  const events = extractRecentUsageEvents(enriched._currentSessionToolUsage)
  const skills = enriched._transcriptSummary?.skillInvocations ?? []
  const settings = enriched._effectiveSettings
  const lastUserMessageAt = enriched._lastUserMessageAt ?? null
  return [
    input.session_id ?? "",
    input.cwd ?? "",
    lastUserMessageAt,
    events,
    skills,
    settings?.skillRecencyMaxTurns ?? null,
    settings?.skillRecencyMaxAgeMinutes ?? null,
    includeVerifiedSkillPaths,
  ]
}

function activeSkillsCacheKey(
  input: ToolHookInput,
  includeVerifiedSkillPaths: boolean
): string | null {
  const parsed = activeSkillsEnrichmentSchema.safeParse(input)
  const enriched = parsed.success ? parsed.data : {}
  if (!hasEnrichmentData(enriched)) {
    return null
  }
  return JSON.stringify(buildCacheKeyPayload(input, enriched, includeVerifiedSkillPaths))
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
