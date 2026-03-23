import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { ensureGitExclude } from "../git-helpers.ts"
import { getHomeDirOrNull } from "../home.ts"
import type { HookDef, HookGroup } from "../manifest.ts"
import {
  DEFAULT_DIRTY_WORKTREE_THRESHOLD,
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
} from "./resolution"
import {
  ALL_STATUS_LINE_SEGMENTS,
  ambitionModeSchema,
  collaborationModeSchema,
  type ProjectSwizSettings,
  type SessionSwizSettings,
  type StateData,
  type StatusLineSegment,
  type SwizSettings,
  sessionSwizSettingsSchema,
  stateDataSchema,
} from "./types"

const LEGACY_DEFAULT_STATUS_LINE_SEGMENTS: readonly StatusLineSegment[] = [
  "repo",
  "git",
  "pr",
  "model",
  "ctx",
  "backlog",
  "mode",
  "flags",
  "time",
]

export const DEFAULT_SETTINGS: SwizSettings = {
  autoContinue: true,
  critiquesEnabled: true,
  ambitionMode: "standard",
  collaborationMode: "auto",
  narratorVoice: "",
  narratorSpeed: 0,
  prAgeGateMinutes: 10,
  prMergeMode: true,
  pushCooldownMinutes: 0,
  pushGate: false,
  sandboxedEdits: true,
  speak: false,
  updateMemoryFooter: false,
  gitStatusGate: true,
  nonDefaultBranchGate: true,
  githubCiGate: true,
  changesRequestedGate: true,
  personalRepoIssuesGate: true,
  issueCloseGate: false,
  qualityChecksGate: true,
  strictNoDirectMain: false,
  taskDurationWarningMinutes: 10,
  memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
  memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
  largeFileSizeKb: 500,
  dirtyWorktreeThreshold: DEFAULT_DIRTY_WORKTREE_THRESHOLD,
  statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
  sessions: {},
}

const statusLineSegmentSchema = z.enum(ALL_STATUS_LINE_SEGMENTS)

export const swizSettingsSchema = z.object({
  autoContinue: z.boolean().catch(DEFAULT_SETTINGS.autoContinue),
  critiquesEnabled: z.boolean().catch(DEFAULT_SETTINGS.critiquesEnabled),
  ambitionMode: z
    .enum(["standard", "aggressive", "creative", "reflective"])
    .catch(DEFAULT_SETTINGS.ambitionMode),
  collaborationMode: z
    .enum(["auto", "solo", "team", "relaxed-collab"])
    .catch(DEFAULT_SETTINGS.collaborationMode),
  narratorVoice: z.string().max(200).catch(DEFAULT_SETTINGS.narratorVoice),
  narratorSpeed: z.number().min(0).max(600).catch(DEFAULT_SETTINGS.narratorSpeed),
  prAgeGateMinutes: z.number().int().min(0).catch(DEFAULT_SETTINGS.prAgeGateMinutes),
  prMergeMode: z.boolean().catch(DEFAULT_SETTINGS.prMergeMode),
  pushCooldownMinutes: z.number().int().min(0).catch(DEFAULT_SETTINGS.pushCooldownMinutes),
  pushGate: z.boolean().catch(DEFAULT_SETTINGS.pushGate),
  sandboxedEdits: z.boolean().catch(DEFAULT_SETTINGS.sandboxedEdits),
  speak: z.boolean().catch(DEFAULT_SETTINGS.speak),
  updateMemoryFooter: z.boolean().catch(DEFAULT_SETTINGS.updateMemoryFooter),
  gitStatusGate: z.boolean().catch(DEFAULT_SETTINGS.gitStatusGate),
  nonDefaultBranchGate: z.boolean().catch(DEFAULT_SETTINGS.nonDefaultBranchGate),
  githubCiGate: z.boolean().catch(DEFAULT_SETTINGS.githubCiGate),
  changesRequestedGate: z.boolean().catch(DEFAULT_SETTINGS.changesRequestedGate),
  personalRepoIssuesGate: z.boolean().catch(DEFAULT_SETTINGS.personalRepoIssuesGate),
  issueCloseGate: z.boolean().catch(DEFAULT_SETTINGS.issueCloseGate),
  qualityChecksGate: z.boolean().catch(DEFAULT_SETTINGS.qualityChecksGate),
  strictNoDirectMain: z.boolean().catch(DEFAULT_SETTINGS.strictNoDirectMain),
  taskDurationWarningMinutes: z
    .number()
    .int()
    .min(1)
    .catch(DEFAULT_SETTINGS.taskDurationWarningMinutes),
  memoryLineThreshold: z.number().int().min(1).catch(DEFAULT_SETTINGS.memoryLineThreshold),
  memoryWordThreshold: z.number().int().min(1).catch(DEFAULT_SETTINGS.memoryWordThreshold),
  largeFileSizeKb: z.number().int().min(1).catch(DEFAULT_SETTINGS.largeFileSizeKb),
  dirtyWorktreeThreshold: z.number().int().min(1).catch(DEFAULT_SETTINGS.dirtyWorktreeThreshold),
  statusLineSegments: z
    .array(statusLineSegmentSchema)
    .catch([...ALL_STATUS_LINE_SEGMENTS])
    .transform(normalizeStatusLineSegments),
  sessions: z.record(z.string(), sessionSwizSettingsSchema).catch({}),
  disabledHooks: z.array(z.string().min(1)).optional().catch(undefined),
})

const swizSettingsWithoutSessionsSchema = swizSettingsSchema.omit({ sessions: true })

export interface ReadOptions {
  home?: string | undefined
  strict?: boolean | undefined
}

export interface WriteOptions {
  home?: string | undefined
}

function cloneDefaults(): SwizSettings {
  return { ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions } }
}

function normalizeStatusLineSegments(value: unknown): StatusLineSegment[] {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.statusLineSegments

  const valid = value.every(
    (s: unknown) =>
      typeof s === "string" && (ALL_STATUS_LINE_SEGMENTS as readonly string[]).includes(s)
  )
  if (!valid) return DEFAULT_SETTINGS.statusLineSegments

  const segments = value as StatusLineSegment[]
  if (segments.includes("state")) return segments

  const isLegacyDefault =
    segments.length === LEGACY_DEFAULT_STATUS_LINE_SEGMENTS.length &&
    LEGACY_DEFAULT_STATUS_LINE_SEGMENTS.every((segment) => segments.includes(segment))

  return isLegacyDefault ? [...ALL_STATUS_LINE_SEGMENTS] : segments
}

function normalizeSessionSettings(value: unknown): SessionSwizSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.autoContinue !== "boolean") return null
  const session: SessionSwizSettings = { autoContinue: obj.autoContinue }
  if (typeof obj.prMergeMode === "boolean") session.prMergeMode = obj.prMergeMode
  if (
    obj.ambitionMode === "standard" ||
    obj.ambitionMode === "aggressive" ||
    obj.ambitionMode === "creative" ||
    obj.ambitionMode === "reflective"
  ) {
    session.ambitionMode = obj.ambitionMode
  }
  if (collaborationModeSchema.safeParse(obj.collaborationMode).success) {
    session.collaborationMode = obj.collaborationMode as import("./types").CollaborationMode
  }
  return session
}

function normalizeSettings(value: unknown): SwizSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return cloneDefaults()
  const obj = value as Record<string, unknown>
  const rawSessions = obj.sessions
  const sessions: Record<string, SessionSwizSettings> = {}

  if (rawSessions && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
    for (const [sessionId, sessionValue] of Object.entries(rawSessions)) {
      const normalized = normalizeSessionSettings(sessionValue)
      if (normalized) sessions[sessionId] = normalized
    }
  }

  return {
    ...swizSettingsWithoutSessionsSchema.parse(obj),
    sessions,
  }
}

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".swiz", "config.json")
}

/** Copy positive-number fields from obj into result. */
function applyPositiveNumberFields(
  obj: Record<string, unknown>,
  result: ProjectSwizSettings,
  keys: (keyof ProjectSwizSettings)[]
): void {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === "number" && val > 0) {
      ;(result as Record<string, unknown>)[key] = val
    }
  }
}

/** Copy boolean fields from obj into result. */
function applyBooleanFields(
  obj: Record<string, unknown>,
  result: ProjectSwizSettings,
  keys: (keyof ProjectSwizSettings)[]
): void {
  for (const key of keys) {
    if (typeof obj[key] === "boolean") {
      ;(result as Record<string, unknown>)[key] = obj[key]
    }
  }
}

/** Copy string-array fields from obj into result. */
function applyStringArrayFields(
  obj: Record<string, unknown>,
  result: ProjectSwizSettings,
  keys: (keyof ProjectSwizSettings)[]
): void {
  for (const key of keys) {
    if (
      Array.isArray(obj[key]) &&
      (obj[key] as unknown[]).every((v: unknown) => typeof v === "string")
    ) {
      ;(result as Record<string, unknown>)[key] = obj[key]
    }
  }
}

function parseDefaultBranch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const branch = value.trim()
  return branch && !/\s/.test(branch) ? branch : undefined
}

function applySchemaFields(obj: Record<string, unknown>, result: ProjectSwizSettings): void {
  const ambitionMode = ambitionModeSchema.safeParse(obj.ambitionMode)
  if (ambitionMode.success) result.ambitionMode = ambitionMode.data
  const collaborationMode = collaborationModeSchema.safeParse(obj.collaborationMode)
  if (collaborationMode.success) result.collaborationMode = collaborationMode.data
}

function applyHooksAndCategories(obj: Record<string, unknown>, result: ProjectSwizSettings): void {
  if (Array.isArray(obj.hooks)) {
    const validated = normalizeProjectHooks(obj.hooks as unknown[])
    if (validated.length > 0) result.hooks = validated
  }
  const categories = parseStringArray(obj.allowedSkillCategories)
  if (categories.length > 0) result.allowedSkillCategories = categories
}

function normalizeProjectSettings(value: unknown): ProjectSwizSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const result: ProjectSwizSettings = {}

  const profile = obj.profile
  if (profile !== undefined) {
    const parsed = z.enum(["solo", "team", "strict"]).safeParse(profile)
    if (!parsed.success) return null
    result.profile = parsed.data
  }

  applyPositiveNumberFields(obj, result, [
    "trivialMaxFiles",
    "trivialMaxLines",
    "memoryLineThreshold",
    "memoryWordThreshold",
    "largeFileSizeKb",
    "dirtyWorktreeThreshold",
    "taskDurationWarningMinutes",
  ])

  const defaultBranch = parseDefaultBranch(obj.defaultBranch)
  if (defaultBranch) result.defaultBranch = defaultBranch

  applySchemaFields(obj, result)
  applyBooleanFields(obj, result, ["autoContinue", "qualityChecksGate", "strictNoDirectMain"])
  applyStringArrayFields(obj, result, ["disabledHooks", "plugins", "largeFileAllowPatterns"])
  applyHooksAndCategories(obj, result)
  return result
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return []
  const items = (value as unknown[]).filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0
  )
  return items.length === value.length ? items.map((c) => c.trim()) : []
}

/** Validate and normalize project-local hook groups from config JSON */
function normalizeProjectHooks(raw: unknown[]): HookGroup[] {
  const groups: HookGroup[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const g = item as Record<string, unknown>
    if (typeof g.event !== "string") continue
    if (!Array.isArray(g.hooks)) continue
    const hooks = (g.hooks as unknown[])
      .filter(
        (h): h is Record<string, unknown> =>
          !!h &&
          typeof h === "object" &&
          !Array.isArray(h) &&
          typeof (h as Record<string, unknown>).file === "string"
      )
      .map((h): HookDef => {
        const def: HookDef = { file: h.file as string }
        if (typeof h.timeout === "number") def.timeout = h.timeout
        if (typeof h.async === "boolean") def.async = h.async
        if (typeof h.condition === "string") def.condition = h.condition
        if (typeof h.cooldownSeconds === "number") def.cooldownSeconds = h.cooldownSeconds
        if (Array.isArray(h.stacks) && h.stacks.every((s: unknown) => typeof s === "string")) {
          def.stacks = h.stacks as string[]
        }
        if (
          Array.isArray(h.requiredSettings) &&
          h.requiredSettings.every((s: unknown) => typeof s === "string")
        ) {
          def.requiredSettings =
            h.requiredSettings as (keyof import("./types").EffectiveSwizSettings)[]
        }
        return def
      })
    if (hooks.length > 0) {
      groups.push({
        event: g.event,
        ...(typeof g.matcher === "string" ? { matcher: g.matcher } : {}),
        hooks,
      })
    }
  }
  return groups
}

/**
 * Resolve project-local hook file paths relative to the project root.
 * Returns the resolved groups and any validation warnings for missing files.
 */
export function resolveProjectHooks(
  hooks: HookGroup[],
  projectRoot: string
): { resolved: HookGroup[]; warnings: string[] } {
  const warnings: string[] = []
  const resolved = hooks
    .map((g) => ({
      ...g,
      hooks: g.hooks
        .filter((h) => {
          const absPath = isAbsolute(h.file) ? h.file : join(projectRoot, h.file)
          if (!existsSync(absPath)) {
            warnings.push(`Project hook file not found: ${h.file} (resolved to ${absPath})`)
            return false
          }
          return true
        })
        .map((h) => ({
          ...h,
          file: isAbsolute(h.file) ? h.file : join(projectRoot, h.file),
        })),
    }))
    .filter((g) => g.hooks.length > 0)
  return { resolved, warnings }
}

export function getStatePath(cwd: string): string {
  return join(cwd, ".swiz", "state.json")
}

export async function readStateData(cwd: string): Promise<StateData | null> {
  const path = getStatePath(cwd)
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    const result = stateDataSchema.safeParse(await file.json())
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export async function readProjectState(
  cwd: string
): Promise<import("./types").ProjectState | null> {
  const data = await readStateData(cwd)
  return data?.state ?? null
}

export async function writeProjectState(
  cwd: string,
  state: import("./types").ProjectState
): Promise<void> {
  const path = getStatePath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const existing = await readStateData(cwd)

  const previousState = existing?.state ?? null
  const history = existing?.stateHistory ?? []
  history.push({ from: previousState, to: state, timestamp: new Date().toISOString() })

  await Bun.write(path, `${JSON.stringify({ state, stateHistory: history }, null, 2)}\n`)
  await ensureGitExclude(cwd, ".swiz/")
}

export async function writeProjectSettings(
  cwd: string,
  updates: Partial<ProjectSwizSettings>
): Promise<string> {
  const path = getProjectSettingsPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  let existing: Record<string, unknown> = {}
  const file = Bun.file(path)
  if (await file.exists()) {
    try {
      existing = (await file.json()) as Record<string, unknown>
    } catch {
      // Ignore parse errors — overwrite with clean object
    }
  }
  await Bun.write(path, JSON.stringify({ ...existing, ...updates }, null, 2))
  invalidateProjectSettingsCache(path)
  await ensureGitExclude(cwd, ".swiz/")
  return path
}

// ─── Project settings TTL cache ─────────────────────────────────────────────

const PROJECT_SETTINGS_TTL_MS = 5_000

interface ProjectSettingsCacheEntry {
  value: ProjectSwizSettings | null
  expiresAt: number
}

const _projectSettingsCache = new Map<string, ProjectSettingsCacheEntry>()

function invalidateProjectSettingsCache(path: string): void {
  _projectSettingsCache.delete(path)
}

// ─── Project settings I/O ────────────────────────────────────────────────────

export async function readProjectSettings(cwd: string): Promise<ProjectSwizSettings | null> {
  const path = getProjectSettingsPath(cwd)

  const cached = _projectSettingsCache.get(path)
  if (cached && Date.now() < cached.expiresAt) return cached.value

  const file = Bun.file(path)
  if (!(await file.exists())) {
    _projectSettingsCache.set(path, {
      value: null,
      expiresAt: Date.now() + PROJECT_SETTINGS_TTL_MS,
    })
    return null
  }
  try {
    const value = normalizeProjectSettings(await file.json())
    _projectSettingsCache.set(path, { value, expiresAt: Date.now() + PROJECT_SETTINGS_TTL_MS })
    return value
  } catch {
    _projectSettingsCache.set(path, {
      value: null,
      expiresAt: Date.now() + PROJECT_SETTINGS_TTL_MS,
    })
    return null
  }
}

export function getSwizSettingsPath(home = getHomeDirOrNull()): string | null {
  if (!home) return null
  return join(home, ".swiz", "settings.json")
}

export function getPrPollStatePath(home = getHomeDirOrNull()): string | null {
  if (!home) return null
  return join(home, ".swiz", "pr-poll-state.json")
}

// ─── Settings TTL cache ──────────────────────────────────────────────────────

const SETTINGS_TTL_MS = 5_000

interface SettingsCacheEntry {
  value: SwizSettings
  expiresAt: number
}

const _settingsCache = new Map<string, SettingsCacheEntry>()

export function invalidateSettingsCache(path: string): void {
  _settingsCache.delete(path)
}

// ─── Settings I/O ────────────────────────────────────────────────────────────

export async function readSwizSettings(options: ReadOptions = {}): Promise<SwizSettings> {
  const path = getSwizSettingsPath(options.home)
  if (!path) return cloneDefaults()

  // Strict reads bypass the cache (used for validation; must see current disk state)
  if (!options.strict) {
    const cached = _settingsCache.get(path)
    if (cached && Date.now() < cached.expiresAt) return cached.value
  }

  const file = Bun.file(path)
  if (!(await file.exists())) {
    const value = cloneDefaults()
    if (!options.strict)
      _settingsCache.set(path, { value, expiresAt: Date.now() + SETTINGS_TTL_MS })
    return value
  }

  try {
    const value = swizSettingsSchema.parse(await file.json()) as SwizSettings
    if (!options.strict)
      _settingsCache.set(path, { value, expiresAt: Date.now() + SETTINGS_TTL_MS })
    return value
  } catch (error) {
    if (options.strict) {
      throw new Error(`Failed to parse swiz settings at ${path}: ${String(error)}`)
    }
    const value = cloneDefaults()
    _settingsCache.set(path, { value, expiresAt: Date.now() + SETTINGS_TTL_MS })
    return value
  }
}

export async function writeSwizSettings(
  settings: SwizSettings,
  options: WriteOptions = {}
): Promise<string> {
  const path = getSwizSettingsPath(options.home)
  if (!path) throw new Error("HOME is not set; cannot write swiz settings.")

  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`)
  invalidateSettingsCache(path)
  return path
}
