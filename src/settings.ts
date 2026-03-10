import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { ensureGitExclude } from "./git-helpers.ts"
import { getHomeDirOrNull } from "./home.ts"
import type { HookDef, HookGroup } from "./manifest.ts"

// ─── Central Zod enums — single source of truth for all domain types ─────────

export const policyProfileSchema = z.enum(["solo", "team", "strict"])
export type PolicyProfile = z.infer<typeof policyProfileSchema>

export const ambitionModeSchema = z.enum(["standard", "aggressive", "creative", "reflective"])
export type AmbitionMode = z.infer<typeof ambitionModeSchema>

export const collaborationModeSchema = z.enum(["auto", "solo", "team", "relaxed-collab"])
export type CollaborationMode = z.infer<typeof collaborationModeSchema>

export const projectStateSchema = z.enum([
  "planning",
  "developing",
  "reviewing",
  "addressing-feedback",
])
export type ProjectState = z.infer<typeof projectStateSchema>

/** Collaboration modes as an array — derived from the schema. */
export const COLLABORATION_MODES: CollaborationMode[] = collaborationModeSchema.options

/** Valid transitions from each project state. All states are active work phases. */
export const STATE_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  planning: ["developing"],
  developing: ["reviewing", "planning"],
  reviewing: ["addressing-feedback", "developing"],
  "addressing-feedback": ["reviewing", "developing"],
}

/** All valid project states — derived from the schema. */
export const PROJECT_STATES: ProjectState[] = projectStateSchema.options

/** No terminal states — every state is an active work phase. */
export const TERMINAL_STATES: ProjectState[] = []

// ─── State transition schemas ─────────────────────────────────────────────────

export const stateHistoryEntrySchema = z.object({
  from: projectStateSchema.nullable(),
  to: projectStateSchema,
  timestamp: z.string().min(1),
})
export type StateHistoryEntry = z.infer<typeof stateHistoryEntrySchema>

export const stateDataSchema = z.object({
  state: projectStateSchema,
  stateHistory: z.array(stateHistoryEntrySchema).catch([]),
})
export type StateData = z.infer<typeof stateDataSchema>

// ─── Settings schemas ─────────────────────────────────────────────────────────

export interface SessionSwizSettings {
  autoContinue: boolean
  prMergeMode?: boolean
  ambitionMode?: AmbitionMode
  collaborationMode?: CollaborationMode
}

export type SettingsScope = "global" | "project" | "session"
export type SettingValueKind = "boolean" | "numeric" | "string"

export interface SettingDoc {
  valuePlaceholder?: string
  enableDescription?: string
  disableDescription?: string
  setDescription?: string
}

export interface SettingDef {
  key: string
  aliases: string[]
  kind: SettingValueKind
  scopes: readonly SettingsScope[]
  docs?: SettingDoc
  validate?: (value: string) => string | null
}

export const SETTINGS_REGISTRY: SettingDef[] = [
  {
    key: "autoContinue",
    aliases: ["auto-continue", "autocontinue", "auto_continue"],
    kind: "boolean",
    scopes: ["global", "session"],
    docs: {
      enableDescription: "Enable stop auto-continue behavior",
      disableDescription: "Disable stop auto-continue behavior",
    },
  },
  {
    key: "prMergeMode",
    aliases: ["pr-merge-mode", "prmergemode", "pr_merge_mode", "pr-merge", "prmerge"],
    kind: "boolean",
    scopes: ["global", "session"],
    docs: {
      enableDescription: "Enable merge-oriented PR hooks",
      disableDescription: "Disable merge-oriented PR hooks; keep creation-oriented guidance only",
    },
  },
  {
    key: "critiquesEnabled",
    aliases: ["critiques-enabled", "critiquesenabled", "critiques_enabled", "critiques"],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Show Process/Product critique lines in auto-continue output",
      disableDescription: "Suppress critique lines and emit only next-step directive",
    },
  },
  {
    key: "pushGate",
    aliases: ["push-gate", "pushgate", "push_gate"],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "sandboxedEdits",
    aliases: ["sandboxed-edits", "sandboxededits", "sandboxed_edits"],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Block file edits outside cwd and /tmp",
      disableDescription: "Allow file edits anywhere on the filesystem",
    },
  },
  {
    key: "speak",
    aliases: ["speak", "tts"],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Enable TTS narrator",
      disableDescription: "Disable TTS narrator",
    },
  },
  {
    key: "swizNotifyHooks",
    aliases: [
      "swiz-notify-hooks",
      "swiznotifyhooks",
      "swiz_notify_hooks",
      "swiz-notify",
      "notify-hooks",
    ],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Enable swiz-notify backed notification hooks",
      disableDescription: "Disable swiz-notify backed notification hooks",
    },
  },
  {
    key: "updateMemoryFooter",
    aliases: [
      "update-memory-footer",
      "updatememoryfooter",
      "update_memory_footer",
      "memory-footer",
    ],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Include update-memory guidance in ACTION REQUIRED footers",
      disableDescription: "Exclude update-memory guidance from ACTION REQUIRED footers",
    },
  },
  {
    key: "gitStatusGate",
    aliases: ["git-status-gate", "gitstatusgate", "git_status_gate", "git-status"],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "nonDefaultBranchGate",
    aliases: [
      "non-default-branch-gate",
      "nondefaultbranchgate",
      "non_default_branch_gate",
      "branch-gate",
    ],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "githubCiGate",
    aliases: ["github-ci-gate", "githubcigate", "github_ci_gate", "ci-gate"],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "changesRequestedGate",
    aliases: [
      "changes-requested-gate",
      "changesrequestedgate",
      "changes_requested_gate",
      "pr-review-gate",
    ],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "personalRepoIssuesGate",
    aliases: [
      "personal-repo-issues-gate",
      "personalrepoissuesgate",
      "personal_repo_issues_gate",
      "issue-gate",
    ],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "strictNoDirectMain",
    aliases: [
      "strict-no-direct-main",
      "strictnodirectmain",
      "strict_no_direct_main",
      "strict-main",
      "no-direct-main",
    ],
    kind: "boolean",
    scopes: ["global", "project"],
  },
  {
    key: "prAgeGateMinutes",
    aliases: ["pr-age-gate", "pragegate", "pr_age_gate", "pragegateminutes", "pr-age-gate-minutes"],
    kind: "numeric",
    scopes: ["global"],
    docs: { valuePlaceholder: "minutes" },
  },
  {
    key: "pushCooldownMinutes",
    aliases: [
      "push-cooldown-minutes",
      "pushcooldownminutes",
      "push_cooldown_minutes",
      "push-cooldown",
    ],
    kind: "numeric",
    scopes: ["global"],
    docs: { valuePlaceholder: "minutes" },
  },
  {
    key: "narratorSpeed",
    aliases: ["narrator-speed", "narratorspeed", "narrator_speed", "speed"],
    kind: "numeric",
    scopes: ["global"],
    docs: { valuePlaceholder: "wpm" },
  },
  {
    key: "memoryLineThreshold",
    aliases: ["memory-line-threshold", "memorylinethreshold", "memory_line_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    docs: { valuePlaceholder: "lines" },
  },
  {
    key: "memoryWordThreshold",
    aliases: ["memory-word-threshold", "memorywordthreshold", "memory_word_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    docs: { valuePlaceholder: "words" },
  },
  {
    key: "largeFileSizeKb",
    aliases: ["large-file-size-kb", "largefilesizekb", "large_file_size_kb"],
    kind: "numeric",
    scopes: ["global", "project"],
    docs: { valuePlaceholder: "kb" },
  },
  {
    key: "defaultBranch",
    aliases: ["default-branch", "defaultbranch", "default_branch"],
    kind: "string",
    scopes: ["project"],
    docs: { valuePlaceholder: "name" },
    validate: (v) => {
      if (!v.trim()) {
        return `Invalid value "${v}" for default-branch. Must be a non-empty branch name`
      }
      if (v !== v.trim()) {
        return `Invalid value "${v}" for default-branch. Do not include leading or trailing whitespace`
      }
      if (/\s/.test(v)) {
        return `Invalid value "${v}" for default-branch. Branch names cannot contain whitespace`
      }
      return null
    },
  },
  {
    key: "narratorVoice",
    aliases: ["narrator-voice", "narratorvoice", "narrator_voice", "voice"],
    kind: "string",
    scopes: ["global"],
    docs: { valuePlaceholder: "name" },
  },
  {
    key: "ambitionMode",
    aliases: ["ambition-mode", "ambitionmode", "ambition_mode", "ambition"],
    kind: "string",
    scopes: ["global", "project", "session"],
    docs: { valuePlaceholder: "standard|aggressive|creative|reflective" },
    validate: (v) =>
      ambitionModeSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for ambition-mode. Must be: ${ambitionModeSchema.options.join(" | ")}`,
  },
  {
    key: "collaborationMode",
    aliases: [
      "collaboration-mode",
      "collaborationmode",
      "collaboration_mode",
      "collaboration",
      "collab-mode",
      "collab",
    ],
    kind: "string",
    scopes: ["global", "project", "session"],
    docs: { valuePlaceholder: "auto|solo|team|relaxed-collab" },
    validate: (v) =>
      collaborationModeSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for collaboration-mode. Must be: ${collaborationModeSchema.options.join(" | ")}`,
  },
]

/** Project-local policy config — lives in <repo>/.swiz/config.json */
export interface ProjectSwizSettings {
  profile?: PolicyProfile
  trivialMaxFiles?: number
  trivialMaxLines?: number
  /** Project default branch override (e.g. "main", "master", "trunk"). */
  defaultBranch?: string
  memoryLineThreshold?: number
  memoryWordThreshold?: number
  largeFileSizeKb?: number
  ambitionMode?: AmbitionMode
  /** Per-project collaboration mode override (e.g. team repos require PR flow). */
  collaborationMode?: CollaborationMode
  /** Enforce feature-branch workflow even for solo repositories. */
  strictNoDirectMain?: boolean
  /** Hook filenames to skip for this project (e.g. "stop-github-ci.ts") */
  disabledHooks?: string[]
  /** External hook plugin bundles — package names or local paths */
  plugins?: string[]
  /** Project-local hook groups — merged after built-in and plugin hooks */
  hooks?: HookGroup[]
  /**
   * Allowed values for the `category:` frontmatter field in SKILL.md files.
   * When set, `swiz doctor` flags any skill whose category is not in this list.
   * When absent, the built-in default list in `DEFAULT_ALLOWED_SKILL_CATEGORIES` applies.
   */
  allowedSkillCategories?: string[]
}

/** Resolved policy thresholds after merging global + project config */
export interface ResolvedPolicy {
  trivialMaxFiles: number
  trivialMaxLines: number
  profile: PolicyProfile | null
  source: "project" | "default"
}

/** All available status-line segment names. */
export const ALL_STATUS_LINE_SEGMENTS = [
  "repo",
  "git",
  "pr",
  "model",
  "ctx",
  "state",
  "backlog",
  "mode",
  "flags",
  "time",
] as const

export type StatusLineSegment = (typeof ALL_STATUS_LINE_SEGMENTS)[number]

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

export interface SwizSettings {
  autoContinue: boolean
  critiquesEnabled: boolean
  ambitionMode: AmbitionMode
  collaborationMode: CollaborationMode
  narratorVoice: string
  narratorSpeed: number
  prAgeGateMinutes: number
  prMergeMode: boolean
  pushCooldownMinutes: number
  pushGate: boolean
  sandboxedEdits: boolean
  speak: boolean
  swizNotifyHooks: boolean
  updateMemoryFooter: boolean
  gitStatusGate: boolean
  nonDefaultBranchGate: boolean
  githubCiGate: boolean
  changesRequestedGate: boolean
  personalRepoIssuesGate: boolean
  /** When true, blocks all direct pushes to the default branch regardless of repo type. */
  strictNoDirectMain: boolean
  memoryLineThreshold: number
  memoryWordThreshold: number
  largeFileSizeKb: number
  /** Which segments to display in the status line. Defaults to all segments. */
  statusLineSegments: StatusLineSegment[]
  sessions: Record<string, SessionSwizSettings>
  /** Global hook filenames to skip (e.g. "stop-github-ci.ts") */
  disabledHooks?: string[]
}

type EffectiveSettingsBase = Omit<SwizSettings, "sessions" | "disabledHooks">

export interface EffectiveSwizSettings extends EffectiveSettingsBase {
  source: "global" | "session"
}

/** Default trivial-change thresholds (mirrors the gate hook's original hard-coded values) */
export const DEFAULT_MEMORY_LINE_THRESHOLD = 1400
export const DEFAULT_MEMORY_WORD_THRESHOLD = 5000
export const DEFAULT_LARGE_FILE_SIZE_KB = 500

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

/** Resolve effective memory thresholds with per-value source tracking. */
export interface ResolvedMemoryThresholds {
  memoryLineThreshold: number
  memoryLineSource: "project" | "user" | "default"
  memoryWordThreshold: number
  memoryWordSource: "project" | "user" | "default"
}

export function resolveMemoryThresholds(
  project: ProjectSwizSettings | null,
  user: { memoryLineThreshold?: number; memoryWordThreshold?: number },
  defaults: { memoryLineThreshold: number; memoryWordThreshold: number }
): ResolvedMemoryThresholds {
  // 3-tier hierarchy: project > user > default
  const memoryLineThreshold =
    project?.memoryLineThreshold ?? user.memoryLineThreshold ?? defaults.memoryLineThreshold
  const memoryLineSource = project?.memoryLineThreshold
    ? "project"
    : user.memoryLineThreshold
      ? "user"
      : "default"

  const memoryWordThreshold =
    project?.memoryWordThreshold ?? user.memoryWordThreshold ?? defaults.memoryWordThreshold
  const memoryWordSource = project?.memoryWordThreshold
    ? "project"
    : user.memoryWordThreshold
      ? "user"
      : "default"

  return {
    memoryLineThreshold,
    memoryLineSource,
    memoryWordThreshold,
    memoryWordSource,
  }
}

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
  swizNotifyHooks: false,
  updateMemoryFooter: false,
  gitStatusGate: true,
  nonDefaultBranchGate: true,
  githubCiGate: true,
  changesRequestedGate: true,
  personalRepoIssuesGate: true,
  strictNoDirectMain: false,
  memoryLineThreshold: DEFAULT_MEMORY_LINE_THRESHOLD,
  memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
  largeFileSizeKb: DEFAULT_LARGE_FILE_SIZE_KB,
  statusLineSegments: [...ALL_STATUS_LINE_SEGMENTS],
  sessions: {},
}

// ─── Zod schemas for settings objects ────────────────────────────────────────
// Each numeric field uses .catch(default) for soft fallback — invalid values
// revert to the configured default rather than rejecting the whole object.

export const sessionSwizSettingsSchema = z.object({
  autoContinue: z.boolean(),
  prMergeMode: z.boolean().optional(),
  ambitionMode: ambitionModeSchema.optional(),
  collaborationMode: collaborationModeSchema.optional(),
})

export const projectSettingsSchema = z.object({
  profile: policyProfileSchema.optional(),
  trivialMaxFiles: z.number().int().min(1).optional(),
  trivialMaxLines: z.number().int().min(1).optional(),
  defaultBranch: z.string().min(1).regex(/^\S+$/).optional(),
  memoryLineThreshold: z.number().int().min(1).optional(),
  memoryWordThreshold: z.number().int().min(1).optional(),
  largeFileSizeKb: z.number().int().min(1).optional(),
  ambitionMode: ambitionModeSchema.optional(),
  collaborationMode: collaborationModeSchema.optional(),
  strictNoDirectMain: z.boolean().optional(),
  disabledHooks: z.array(z.string().min(1)).optional(),
  plugins: z.array(z.string().min(1)).optional(),
  allowedSkillCategories: z.array(z.string().min(1)).optional(),
})

const statusLineSegmentSchema = z.enum(ALL_STATUS_LINE_SEGMENTS)

export const swizSettingsSchema = z.object({
  autoContinue: z.boolean().catch(DEFAULT_SETTINGS.autoContinue),
  critiquesEnabled: z.boolean().catch(DEFAULT_SETTINGS.critiquesEnabled),
  ambitionMode: ambitionModeSchema.catch(DEFAULT_SETTINGS.ambitionMode),
  collaborationMode: collaborationModeSchema.catch(DEFAULT_SETTINGS.collaborationMode),
  narratorVoice: z.string().max(200).catch(DEFAULT_SETTINGS.narratorVoice),
  narratorSpeed: z.number().min(0).max(600).catch(DEFAULT_SETTINGS.narratorSpeed),
  prAgeGateMinutes: z.number().int().min(0).catch(DEFAULT_SETTINGS.prAgeGateMinutes),
  prMergeMode: z.boolean().catch(DEFAULT_SETTINGS.prMergeMode),
  pushCooldownMinutes: z.number().int().min(0).catch(DEFAULT_SETTINGS.pushCooldownMinutes),
  pushGate: z.boolean().catch(DEFAULT_SETTINGS.pushGate),
  sandboxedEdits: z.boolean().catch(DEFAULT_SETTINGS.sandboxedEdits),
  speak: z.boolean().catch(DEFAULT_SETTINGS.speak),
  swizNotifyHooks: z.boolean().catch(DEFAULT_SETTINGS.swizNotifyHooks),
  updateMemoryFooter: z.boolean().catch(DEFAULT_SETTINGS.updateMemoryFooter),
  gitStatusGate: z.boolean().catch(DEFAULT_SETTINGS.gitStatusGate),
  nonDefaultBranchGate: z.boolean().catch(DEFAULT_SETTINGS.nonDefaultBranchGate),
  githubCiGate: z.boolean().catch(DEFAULT_SETTINGS.githubCiGate),
  changesRequestedGate: z.boolean().catch(DEFAULT_SETTINGS.changesRequestedGate),
  personalRepoIssuesGate: z.boolean().catch(DEFAULT_SETTINGS.personalRepoIssuesGate),
  strictNoDirectMain: z.boolean().catch(DEFAULT_SETTINGS.strictNoDirectMain),
  memoryLineThreshold: z.number().int().min(1).catch(DEFAULT_SETTINGS.memoryLineThreshold),
  memoryWordThreshold: z.number().int().min(1).catch(DEFAULT_SETTINGS.memoryWordThreshold),
  largeFileSizeKb: z.number().int().min(1).catch(DEFAULT_SETTINGS.largeFileSizeKb),
  statusLineSegments: z
    .array(statusLineSegmentSchema)
    .catch([...ALL_STATUS_LINE_SEGMENTS])
    .transform(normalizeStatusLineSegments),
  sessions: z.record(z.string(), sessionSwizSettingsSchema).catch({}),
  disabledHooks: z.array(z.string().min(1)).optional().catch(undefined),
})

const swizSettingsWithoutSessionsSchema = swizSettingsSchema.omit({ sessions: true })

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
    session.collaborationMode = obj.collaborationMode as CollaborationMode
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

function normalizeProjectSettings(value: unknown): ProjectSwizSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const result: ProjectSwizSettings = {}
  const profile = obj.profile
  if (profile !== undefined) {
    const parsed = policyProfileSchema.safeParse(profile)
    if (!parsed.success) return null
    result.profile = parsed.data
  }
  if (typeof obj.trivialMaxFiles === "number" && obj.trivialMaxFiles > 0) {
    result.trivialMaxFiles = obj.trivialMaxFiles
  }
  if (typeof obj.trivialMaxLines === "number" && obj.trivialMaxLines > 0) {
    result.trivialMaxLines = obj.trivialMaxLines
  }
  if (typeof obj.defaultBranch === "string") {
    const branch = obj.defaultBranch.trim()
    if (branch && !/\s/.test(branch)) result.defaultBranch = branch
  }
  if (typeof obj.memoryLineThreshold === "number" && obj.memoryLineThreshold > 0) {
    result.memoryLineThreshold = obj.memoryLineThreshold
  }
  if (typeof obj.memoryWordThreshold === "number" && obj.memoryWordThreshold > 0) {
    result.memoryWordThreshold = obj.memoryWordThreshold
  }
  if (typeof obj.largeFileSizeKb === "number" && obj.largeFileSizeKb > 0) {
    result.largeFileSizeKb = obj.largeFileSizeKb
  }
  const ambitionMode = ambitionModeSchema.safeParse(obj.ambitionMode)
  if (ambitionMode.success) {
    result.ambitionMode = ambitionMode.data
  }
  const collaborationMode = collaborationModeSchema.safeParse(obj.collaborationMode)
  if (collaborationMode.success) {
    result.collaborationMode = collaborationMode.data
  }
  if (typeof obj.strictNoDirectMain === "boolean") {
    result.strictNoDirectMain = obj.strictNoDirectMain
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
  if (
    Array.isArray(obj.allowedSkillCategories) &&
    obj.allowedSkillCategories.length > 0 &&
    obj.allowedSkillCategories.every((c: unknown) => typeof c === "string" && c.trim().length > 0)
  ) {
    result.allowedSkillCategories = (obj.allowedSkillCategories as string[]).map((c) => c.trim())
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

export async function readProjectState(cwd: string): Promise<ProjectState | null> {
  const data = await readStateData(cwd)
  return data?.state ?? null
}

export async function writeProjectState(cwd: string, state: ProjectState): Promise<void> {
  const path = getStatePath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const existing = await readStateData(cwd)

  const previousState = existing?.state ?? null
  const history = existing?.stateHistory ?? []
  history.push({ from: previousState, to: state, timestamp: new Date().toISOString() })

  await Bun.write(path, `${JSON.stringify({ state, stateHistory: history }, null, 2)}\n`)
  ensureGitExclude(cwd, ".swiz/")
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
  ensureGitExclude(cwd, ".swiz/")
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

export function getSwizSettingsPath(home = getHomeDirOrNull()): string | null {
  if (!home) return null
  return join(home, ".swiz", "settings.json")
}

export function getPrPollStatePath(home = getHomeDirOrNull()): string | null {
  if (!home) return null
  return join(home, ".swiz", "pr-poll-state.json")
}

export async function readSwizSettings(options: ReadOptions = {}): Promise<SwizSettings> {
  const path = getSwizSettingsPath(options.home)
  if (!path) return cloneDefaults()

  const file = Bun.file(path)
  if (!(await file.exists())) return cloneDefaults()

  try {
    return swizSettingsSchema.parse(await file.json()) as SwizSettings
  } catch (error) {
    if (options.strict) {
      throw new Error(`Failed to parse swiz settings at ${path}: ${String(error)}`)
    }
    return cloneDefaults()
  }
}

export function getEffectiveSwizSettings(
  settings: SwizSettings,
  sessionId?: string | null,
  projectSettings?: ProjectSwizSettings | null
): EffectiveSwizSettings {
  const base: EffectiveSettingsBase = {
    autoContinue: settings.autoContinue,
    critiquesEnabled: settings.critiquesEnabled,
    ambitionMode: projectSettings?.ambitionMode ?? settings.ambitionMode,
    collaborationMode: projectSettings?.collaborationMode ?? settings.collaborationMode,
    narratorVoice: settings.narratorVoice,
    narratorSpeed: settings.narratorSpeed,
    prAgeGateMinutes: settings.prAgeGateMinutes,
    prMergeMode: settings.prMergeMode,
    pushCooldownMinutes: settings.pushCooldownMinutes,
    pushGate: settings.pushGate,
    sandboxedEdits: settings.sandboxedEdits,
    speak: settings.speak,
    swizNotifyHooks: settings.swizNotifyHooks,
    updateMemoryFooter: settings.updateMemoryFooter,
    gitStatusGate: settings.gitStatusGate,
    nonDefaultBranchGate: settings.nonDefaultBranchGate,
    githubCiGate: settings.githubCiGate,
    changesRequestedGate: settings.changesRequestedGate,
    personalRepoIssuesGate: settings.personalRepoIssuesGate,
    strictNoDirectMain: projectSettings?.strictNoDirectMain ?? settings.strictNoDirectMain,
    memoryLineThreshold: settings.memoryLineThreshold,
    memoryWordThreshold: settings.memoryWordThreshold,
    largeFileSizeKb: projectSettings?.largeFileSizeKb ?? settings.largeFileSizeKb,
    statusLineSegments: settings.statusLineSegments,
  }

  if (sessionId && settings.sessions[sessionId]) {
    const sessionSettings = settings.sessions[sessionId]!
    return {
      ...base,
      autoContinue: sessionSettings.autoContinue,
      ambitionMode: sessionSettings.ambitionMode ?? base.ambitionMode,
      collaborationMode: sessionSettings.collaborationMode ?? base.collaborationMode,
      prMergeMode:
        typeof sessionSettings.prMergeMode === "boolean"
          ? sessionSettings.prMergeMode
          : base.prMergeMode,
      source: "session",
    }
  }
  return { ...base, source: "global" }
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

// ─── SettingsStore ────────────────────────────────────────────────────────────

/**
 * Centralised settings store — owns all read/merge/write logic for global,
 * project, and session scopes.  Callers should use SettingsStore methods
 * instead of calling read/write primitives directly.
 */
export class SettingsStore {
  private readonly options: ReadOptions & WriteOptions

  constructor(options: ReadOptions & WriteOptions = {}) {
    this.options = options
  }

  // ── Readers ──────────────────────────────────────────────────────────────

  async readGlobal(): Promise<SwizSettings> {
    return readSwizSettings(this.options)
  }

  async readProject(cwd: string): Promise<ProjectSwizSettings | null> {
    return readProjectSettings(cwd)
  }

  async effective(cwd: string, sessionId?: string | null): Promise<EffectiveSwizSettings> {
    const [global, project] = await Promise.all([this.readGlobal(), this.readProject(cwd)])
    return getEffectiveSwizSettings(global, sessionId, project)
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  /**
   * Set a single key in global settings.
   * Returns the path that was written.
   */
  async setGlobal(key: string, value: unknown): Promise<string> {
    const current = await readSwizSettings({ ...this.options, strict: true })
    return writeSwizSettings({ ...current, [key]: value }, this.options)
  }

  /**
   * Set a single key in project settings.
   * Returns the path that was written.
   */
  async setProject(cwd: string, key: string, value: unknown): Promise<string> {
    return writeProjectSettings(cwd, { [key]: value })
  }

  /**
   * Set a single key in a specific session's settings.
   * Returns the path that was written.
   */
  async setSession(sessionId: string, key: string, value: unknown): Promise<string> {
    const current = await readSwizSettings({ ...this.options, strict: true })
    return writeSwizSettings(
      {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...(current.sessions[sessionId] ?? { autoContinue: current.autoContinue }),
            [key]: value,
          },
        },
      },
      this.options
    )
  }

  /**
   * Add a hook filename to the disabled list for the given scope.
   * Returns { path, alreadyDisabled }.
   */
  async disableHook(
    scope: "global" | "project",
    filename: string,
    cwd?: string
  ): Promise<{ path: string; alreadyDisabled: boolean }> {
    if (scope === "project") {
      if (!cwd) throw new Error("cwd required for project scope")
      const project = await readProjectSettings(cwd)
      const existing = project?.disabledHooks ?? []
      if (existing.includes(filename))
        return { path: getProjectSettingsPath(cwd), alreadyDisabled: true }
      const path = await writeProjectSettings(cwd, { disabledHooks: [...existing, filename] })
      return { path, alreadyDisabled: false }
    }
    const current = await readSwizSettings({ ...this.options, strict: true })
    const existing = current.disabledHooks ?? []
    if (existing.includes(filename)) {
      return { path: getSwizSettingsPath(this.options.home) ?? "", alreadyDisabled: true }
    }
    const path = await writeSwizSettings(
      { ...current, disabledHooks: [...existing, filename] },
      this.options
    )
    return { path, alreadyDisabled: false }
  }

  /**
   * Remove a hook filename from the disabled list for the given scope.
   * Returns { path, wasEnabled }.
   */
  async enableHook(
    scope: "global" | "project",
    filename: string,
    cwd?: string
  ): Promise<{ path: string; wasEnabled: boolean }> {
    if (scope === "project") {
      if (!cwd) throw new Error("cwd required for project scope")
      const project = await readProjectSettings(cwd)
      const existing = project?.disabledHooks ?? []
      if (!existing.includes(filename))
        return { path: getProjectSettingsPath(cwd), wasEnabled: false }
      const path = await writeProjectSettings(cwd, {
        disabledHooks: existing.filter((f) => f !== filename),
      })
      return { path, wasEnabled: true }
    }
    const current = await readSwizSettings({ ...this.options, strict: true })
    const existing = current.disabledHooks ?? []
    if (!existing.includes(filename)) {
      return { path: getSwizSettingsPath(this.options.home) ?? "", wasEnabled: false }
    }
    const path = await writeSwizSettings(
      { ...current, disabledHooks: existing.filter((f) => f !== filename) },
      this.options
    )
    return { path, wasEnabled: true }
  }
}

/** Shared default store instance — used by commands that don't need custom options. */
export const settingsStore = new SettingsStore()
