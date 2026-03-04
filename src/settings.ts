import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import type { HookDef, HookGroup } from "./manifest.ts"

export type PolicyProfile = "solo" | "team" | "strict"
export type AmbitionMode = "standard" | "aggressive"

export type ProjectState = "in-development" | "awaiting-feedback" | "released" | "paused"

/** Valid transitions from each project state. Empty array = terminal state. */
export const STATE_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  "in-development": ["awaiting-feedback", "paused", "released"],
  "awaiting-feedback": ["in-development", "released", "paused"],
  released: ["in-development", "paused"],
  paused: ["in-development"],
}

export const PROJECT_STATES: ProjectState[] = [
  "in-development",
  "awaiting-feedback",
  "released",
  "paused",
]

export const TERMINAL_STATES: ProjectState[] = ["released", "paused"]

export interface SessionSwizSettings {
  autoContinue: boolean
  prMergeMode?: boolean
}

export interface StateHistoryEntry {
  from: ProjectState | null
  to: ProjectState
  timestamp: string
}

/** Project-local policy config — lives in <repo>/.swiz/config.json */
export interface ProjectSwizSettings {
  profile?: PolicyProfile
  trivialMaxFiles?: number
  trivialMaxLines?: number
  state?: ProjectState
  stateHistory?: StateHistoryEntry[]
  memoryLineThreshold?: number
  memoryWordThreshold?: number
  /** Hook filenames to skip for this project (e.g. "stop-github-ci.ts") */
  disabledHooks?: string[]
  /** External hook plugin bundles — package names or local paths */
  plugins?: string[]
  /** Project-local hook groups — merged after built-in and plugin hooks */
  hooks?: HookGroup[]
}

/** Resolved policy thresholds after merging global + project config */
export interface ResolvedPolicy {
  trivialMaxFiles: number
  trivialMaxLines: number
  profile: PolicyProfile | null
  source: "project" | "default"
}

export interface SwizSettings {
  autoContinue: boolean
  critiquesEnabled: boolean
  ambitionMode: AmbitionMode
  narratorVoice: string
  narratorSpeed: number
  prAgeGateMinutes: number
  prMergeMode: boolean
  pushGate: boolean
  sandboxedEdits: boolean
  speak: boolean
  gitStatusGate: boolean
  nonDefaultBranchGate: boolean
  githubCiGate: boolean
  changesRequestedGate: boolean
  personalRepoIssuesGate: boolean
  memoryLineThreshold: number
  memoryWordThreshold: number
  sessions: Record<string, SessionSwizSettings>
  /** Global hook filenames to skip (e.g. "stop-github-ci.ts") */
  disabledHooks?: string[]
}

export interface EffectiveSwizSettings {
  autoContinue: boolean
  critiquesEnabled: boolean
  ambitionMode: AmbitionMode
  narratorVoice: string
  narratorSpeed: number
  prAgeGateMinutes: number
  prMergeMode: boolean
  pushGate: boolean
  sandboxedEdits: boolean
  speak: boolean
  gitStatusGate: boolean
  nonDefaultBranchGate: boolean
  githubCiGate: boolean
  changesRequestedGate: boolean
  personalRepoIssuesGate: boolean
  memoryLineThreshold: number
  memoryWordThreshold: number
  source: "global" | "session"
}

/** Default trivial-change thresholds (mirrors the gate hook's original hard-coded values) */
export const DEFAULT_MEMORY_LINE_THRESHOLD = 1400
export const DEFAULT_MEMORY_WORD_THRESHOLD = 5000

export const DEFAULT_TRIVIAL_MAX_FILES = 3
export const DEFAULT_TRIVIAL_MAX_LINES = 20

/** Named policy profiles with preset thresholds */
export const POLICY_PROFILES: Record<
  PolicyProfile,
  { trivialMaxFiles: number; trivialMaxLines: number }
> = {
  solo: { trivialMaxFiles: 10, trivialMaxLines: 100 },
  team: { trivialMaxFiles: 3, trivialMaxLines: 20 },
  strict: { trivialMaxFiles: 1, trivialMaxLines: 10 },
}

/** Resolve effective policy thresholds from a project config (if any). */
export function resolvePolicy(project: ProjectSwizSettings | null): ResolvedPolicy {
  if (!project) {
    return {
      trivialMaxFiles: DEFAULT_TRIVIAL_MAX_FILES,
      trivialMaxLines: DEFAULT_TRIVIAL_MAX_LINES,
      profile: null,
      source: "default",
    }
  }

  let trivialMaxFiles = DEFAULT_TRIVIAL_MAX_FILES
  let trivialMaxLines = DEFAULT_TRIVIAL_MAX_LINES
  let resolvedProfile: PolicyProfile | null = null

  if (project.profile) {
    resolvedProfile = project.profile
    const preset = POLICY_PROFILES[project.profile]
    trivialMaxFiles = preset.trivialMaxFiles
    trivialMaxLines = preset.trivialMaxLines
  }

  // Per-field overrides take precedence over the named profile
  if (project.trivialMaxFiles !== undefined) trivialMaxFiles = project.trivialMaxFiles
  if (project.trivialMaxLines !== undefined) trivialMaxLines = project.trivialMaxLines

  return { trivialMaxFiles, trivialMaxLines, profile: resolvedProfile, source: "project" }
}

export const DEFAULT_SETTINGS: SwizSettings = {
  autoContinue: true,
  critiquesEnabled: true,
  ambitionMode: "standard",
  narratorVoice: "",
  narratorSpeed: 0,
  prAgeGateMinutes: 10,
  prMergeMode: true,
  pushGate: false,
  sandboxedEdits: true,
  speak: false,
  gitStatusGate: true,
  nonDefaultBranchGate: true,
  githubCiGate: true,
  changesRequestedGate: true,
  personalRepoIssuesGate: true,
  memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
  memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
  sessions: {},
}

interface ReadOptions {
  home?: string | undefined
  strict?: boolean | undefined
}

interface WriteOptions {
  home?: string | undefined
}

function cloneDefaults(): SwizSettings {
  return { ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions } }
}

function normalizeSessionSettings(value: unknown): SessionSwizSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.autoContinue !== "boolean") return null
  const session: SessionSwizSettings = { autoContinue: obj.autoContinue }
  if (typeof obj.prMergeMode === "boolean") session.prMergeMode = obj.prMergeMode
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
    autoContinue:
      typeof obj.autoContinue === "boolean" ? obj.autoContinue : DEFAULT_SETTINGS.autoContinue,
    critiquesEnabled:
      typeof obj.critiquesEnabled === "boolean"
        ? obj.critiquesEnabled
        : DEFAULT_SETTINGS.critiquesEnabled,
    ambitionMode:
      obj.ambitionMode === "standard" || obj.ambitionMode === "aggressive"
        ? obj.ambitionMode
        : DEFAULT_SETTINGS.ambitionMode,
    narratorVoice:
      typeof obj.narratorVoice === "string" ? obj.narratorVoice : DEFAULT_SETTINGS.narratorVoice,
    narratorSpeed:
      typeof obj.narratorSpeed === "number" && obj.narratorSpeed >= 0
        ? obj.narratorSpeed
        : DEFAULT_SETTINGS.narratorSpeed,
    prAgeGateMinutes:
      typeof obj.prAgeGateMinutes === "number" && obj.prAgeGateMinutes >= 0
        ? obj.prAgeGateMinutes
        : DEFAULT_SETTINGS.prAgeGateMinutes,
    prMergeMode:
      typeof obj.prMergeMode === "boolean" ? obj.prMergeMode : DEFAULT_SETTINGS.prMergeMode,
    pushGate: typeof obj.pushGate === "boolean" ? obj.pushGate : DEFAULT_SETTINGS.pushGate,
    sandboxedEdits:
      typeof obj.sandboxedEdits === "boolean"
        ? obj.sandboxedEdits
        : DEFAULT_SETTINGS.sandboxedEdits,
    speak: typeof obj.speak === "boolean" ? obj.speak : DEFAULT_SETTINGS.speak,
    gitStatusGate:
      typeof obj.gitStatusGate === "boolean" ? obj.gitStatusGate : DEFAULT_SETTINGS.gitStatusGate,
    nonDefaultBranchGate:
      typeof obj.nonDefaultBranchGate === "boolean"
        ? obj.nonDefaultBranchGate
        : DEFAULT_SETTINGS.nonDefaultBranchGate,
    githubCiGate:
      typeof obj.githubCiGate === "boolean" ? obj.githubCiGate : DEFAULT_SETTINGS.githubCiGate,
    changesRequestedGate:
      typeof obj.changesRequestedGate === "boolean"
        ? obj.changesRequestedGate
        : DEFAULT_SETTINGS.changesRequestedGate,
    personalRepoIssuesGate:
      typeof obj.personalRepoIssuesGate === "boolean"
        ? obj.personalRepoIssuesGate
        : DEFAULT_SETTINGS.personalRepoIssuesGate,
    memoryLineThreshold:
      typeof obj.memoryLineThreshold === "number" && obj.memoryLineThreshold > 0
        ? obj.memoryLineThreshold
        : DEFAULT_SETTINGS.memoryLineThreshold,
    memoryWordThreshold:
      typeof obj.memoryWordThreshold === "number" && obj.memoryWordThreshold > 0
        ? obj.memoryWordThreshold
        : DEFAULT_SETTINGS.memoryWordThreshold,
    sessions,
    ...(Array.isArray(obj.disabledHooks) &&
    obj.disabledHooks.every((h: unknown) => typeof h === "string")
      ? { disabledHooks: obj.disabledHooks as string[] }
      : {}),
  }
}

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".swiz", "config.json")
}

function normalizeProjectSettings(value: unknown): ProjectSwizSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const result: ProjectSwizSettings = {}
  const profile = obj.profile
  if (profile !== undefined) {
    if (profile !== "solo" && profile !== "team" && profile !== "strict") return null
    result.profile = profile as PolicyProfile
  }
  if (typeof obj.trivialMaxFiles === "number" && obj.trivialMaxFiles > 0) {
    result.trivialMaxFiles = obj.trivialMaxFiles
  }
  if (typeof obj.trivialMaxLines === "number" && obj.trivialMaxLines > 0) {
    result.trivialMaxLines = obj.trivialMaxLines
  }
  if (typeof obj.memoryLineThreshold === "number" && obj.memoryLineThreshold > 0) {
    result.memoryLineThreshold = obj.memoryLineThreshold
  }
  if (typeof obj.memoryWordThreshold === "number" && obj.memoryWordThreshold > 0) {
    result.memoryWordThreshold = obj.memoryWordThreshold
  }
  if (typeof obj.state === "string" && obj.state in STATE_TRANSITIONS) {
    result.state = obj.state as ProjectState
  }
  if (Array.isArray(obj.stateHistory)) {
    result.stateHistory = (obj.stateHistory as StateHistoryEntry[]).filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof e.to === "string" &&
        typeof e.timestamp === "string"
    )
  }
  if (
    Array.isArray(obj.disabledHooks) &&
    obj.disabledHooks.every((h: unknown) => typeof h === "string")
  ) {
    result.disabledHooks = obj.disabledHooks as string[]
  }
  if (Array.isArray(obj.plugins) && obj.plugins.every((p: unknown) => typeof p === "string")) {
    result.plugins = obj.plugins as string[]
  }
  if (Array.isArray(obj.hooks)) {
    const validated = normalizeProjectHooks(obj.hooks as unknown[])
    if (validated.length > 0) result.hooks = validated
  }
  return result
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

export async function readProjectState(cwd: string): Promise<ProjectState | null> {
  const settings = await readProjectSettings(cwd)
  return settings?.state ?? null
}

export async function writeProjectState(cwd: string, state: ProjectState): Promise<void> {
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

  const previousState = (existing.state as ProjectState) ?? null
  const history = Array.isArray(existing.stateHistory)
    ? (existing.stateHistory as StateHistoryEntry[])
    : []
  history.push({ from: previousState, to: state, timestamp: new Date().toISOString() })

  await Bun.write(path, JSON.stringify({ ...existing, state, stateHistory: history }, null, 2))
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
  return path
}

export async function readProjectSettings(cwd: string): Promise<ProjectSwizSettings | null> {
  const path = getProjectSettingsPath(cwd)
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return normalizeProjectSettings(await file.json())
  } catch {
    return null
  }
}

export function getSwizSettingsPath(home = process.env.HOME): string | null {
  if (!home) return null
  return join(home, ".swiz", "settings.json")
}

export async function readSwizSettings(options: ReadOptions = {}): Promise<SwizSettings> {
  const path = getSwizSettingsPath(options.home)
  if (!path) return cloneDefaults()

  const file = Bun.file(path)
  if (!(await file.exists())) return cloneDefaults()

  try {
    return normalizeSettings(await file.json())
  } catch (error) {
    if (options.strict) {
      throw new Error(`Failed to parse swiz settings at ${path}: ${String(error)}`)
    }
    return cloneDefaults()
  }
}

export function getEffectiveSwizSettings(
  settings: SwizSettings,
  sessionId?: string | null
): EffectiveSwizSettings {
  if (sessionId && settings.sessions[sessionId]) {
    const sessionSettings = settings.sessions[sessionId]!
    return {
      autoContinue: sessionSettings.autoContinue,
      critiquesEnabled: settings.critiquesEnabled,
      ambitionMode: settings.ambitionMode,
      narratorVoice: settings.narratorVoice,
      narratorSpeed: settings.narratorSpeed,
      prAgeGateMinutes: settings.prAgeGateMinutes,
      prMergeMode:
        typeof sessionSettings.prMergeMode === "boolean"
          ? sessionSettings.prMergeMode
          : settings.prMergeMode,
      pushGate: settings.pushGate,
      sandboxedEdits: settings.sandboxedEdits,
      speak: settings.speak,
      gitStatusGate: settings.gitStatusGate,
      nonDefaultBranchGate: settings.nonDefaultBranchGate,
      githubCiGate: settings.githubCiGate,
      changesRequestedGate: settings.changesRequestedGate,
      personalRepoIssuesGate: settings.personalRepoIssuesGate,
      memoryLineThreshold: settings.memoryLineThreshold,
      memoryWordThreshold: settings.memoryWordThreshold,
      source: "session",
    }
  }
  return {
    autoContinue: settings.autoContinue,
    critiquesEnabled: settings.critiquesEnabled,
    ambitionMode: settings.ambitionMode,
    narratorVoice: settings.narratorVoice,
    narratorSpeed: settings.narratorSpeed,
    prAgeGateMinutes: settings.prAgeGateMinutes,
    prMergeMode: settings.prMergeMode,
    pushGate: settings.pushGate,
    sandboxedEdits: settings.sandboxedEdits,
    speak: settings.speak,
    gitStatusGate: settings.gitStatusGate,
    nonDefaultBranchGate: settings.nonDefaultBranchGate,
    githubCiGate: settings.githubCiGate,
    changesRequestedGate: settings.changesRequestedGate,
    personalRepoIssuesGate: settings.personalRepoIssuesGate,
    memoryLineThreshold: settings.memoryLineThreshold,
    memoryWordThreshold: settings.memoryWordThreshold,
    source: "global",
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
  return path
}
