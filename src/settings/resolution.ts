import type {
  EffectiveSwizSettings,
  PolicyProfile,
  ProjectSwizSettings,
  ResolvedMemoryThresholds,
  ResolvedPolicy,
  SwizSettings,
} from "./types"

type EffectiveSettingsBase = Omit<SwizSettings, "sessions" | "disabledHooks">

/** Default trivial-change thresholds (mirrors the gate hook's original hard-coded values) */
export const DEFAULT_MEMORY_LINE_THRESHOLD = 1400
export const DEFAULT_MEMORY_WORD_THRESHOLD = 5000
export const DEFAULT_LARGE_FILE_SIZE_KB = 500
export const DEFAULT_TASK_DURATION_WARNING_MINUTES = 10

export const DEFAULT_DIRTY_WORKTREE_THRESHOLD = 15
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

function resolveTieredValue(
  projectVal: number | undefined,
  userVal: number | undefined,
  defaultVal: number
): { value: number; source: "project" | "user" | "default" } {
  if (projectVal !== undefined) return { value: projectVal, source: "project" }
  if (userVal !== undefined) return { value: userVal, source: "user" }
  return { value: defaultVal, source: "default" }
}

/** Resolve effective memory thresholds with per-value source tracking. */
export function resolveMemoryThresholds(
  project: ProjectSwizSettings | null,
  user: { memoryLineThreshold?: number; memoryWordThreshold?: number },
  defaults: { memoryLineThreshold: number; memoryWordThreshold: number }
): ResolvedMemoryThresholds {
  const line = resolveTieredValue(
    project?.memoryLineThreshold,
    user.memoryLineThreshold,
    defaults.memoryLineThreshold
  )
  const word = resolveTieredValue(
    project?.memoryWordThreshold,
    user.memoryWordThreshold,
    defaults.memoryWordThreshold
  )
  return {
    memoryLineThreshold: line.value,
    memoryLineSource: line.source,
    memoryWordThreshold: word.value,
    memoryWordSource: word.source,
  }
}

/** Keys where project settings can override global settings. */
const PROJECT_OVERRIDABLE_KEYS = [
  "ambitionMode",
  "collaborationMode",
  "strictNoDirectMain",
  "taskDurationWarningMinutes",
  "largeFileSizeKb",
  "dirtyWorktreeThreshold",
] as const satisfies ReadonlyArray<keyof ProjectSwizSettings & keyof SwizSettings>

/** Resolve fields that support project-level overrides. */
function resolveProjectOverrides(
  settings: SwizSettings,
  projectSettings?: ProjectSwizSettings | null
): Pick<SwizSettings, (typeof PROJECT_OVERRIDABLE_KEYS)[number]> {
  const result = {} as Record<string, unknown>
  for (const key of PROJECT_OVERRIDABLE_KEYS) {
    result[key] = projectSettings?.[key] ?? settings[key]
  }
  return result as Pick<SwizSettings, (typeof PROJECT_OVERRIDABLE_KEYS)[number]>
}

function buildBaseSettings(
  settings: SwizSettings,
  projectSettings?: ProjectSwizSettings | null
): EffectiveSettingsBase {
  return {
    autoContinue: settings.autoContinue,
    critiquesEnabled: settings.critiquesEnabled,
    narratorVoice: settings.narratorVoice,
    narratorSpeed: settings.narratorSpeed,
    prAgeGateMinutes: settings.prAgeGateMinutes,
    prMergeMode: settings.prMergeMode,
    pushCooldownMinutes: settings.pushCooldownMinutes,
    pushGate: settings.pushGate,
    sandboxedEdits: settings.sandboxedEdits,
    speak: settings.speak,
    updateMemoryFooter: settings.updateMemoryFooter,
    gitStatusGate: settings.gitStatusGate,
    nonDefaultBranchGate: settings.nonDefaultBranchGate,
    githubCiGate: settings.githubCiGate,
    changesRequestedGate: settings.changesRequestedGate,
    personalRepoIssuesGate: settings.personalRepoIssuesGate,
    issueCloseGate: settings.issueCloseGate,
    memoryLineThreshold: settings.memoryLineThreshold,
    memoryWordThreshold: settings.memoryWordThreshold,
    statusLineSegments: settings.statusLineSegments,
    ...resolveProjectOverrides(settings, projectSettings),
  }
}

export function getEffectiveSwizSettings(
  settings: SwizSettings,
  sessionId?: string | null,
  projectSettings?: ProjectSwizSettings | null
): EffectiveSwizSettings {
  const base = buildBaseSettings(settings, projectSettings)

  if (sessionId && settings.sessions[sessionId]) {
    const s = settings.sessions[sessionId]!
    return {
      ...base,
      autoContinue: s.autoContinue,
      ambitionMode: s.ambitionMode ?? base.ambitionMode,
      collaborationMode: s.collaborationMode ?? base.collaborationMode,
      prMergeMode: typeof s.prMergeMode === "boolean" ? s.prMergeMode : base.prMergeMode,
      source: "session",
    }
  }
  return { ...base, source: "global" }
}
