import { z } from "zod"
import type { HookGroup } from "../manifest.ts"

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
  autoContinue?: boolean
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

/** Project-local policy config — lives in <repo>/.swiz/config.json */
export interface ProjectSwizSettings {
  /** Per-project auto-continue override. */
  autoContinue?: boolean
  profile?: PolicyProfile
  trivialMaxFiles?: number
  trivialMaxLines?: number
  /** Project default branch override (e.g. "main", "master", "trunk"). */
  defaultBranch?: string
  memoryLineThreshold?: number
  memoryWordThreshold?: number
  largeFileSizeKb?: number
  dirtyWorktreeThreshold?: number
  ambitionMode?: AmbitionMode
  /** Per-project collaboration mode override (e.g. team repos require PR flow). */
  collaborationMode?: CollaborationMode
  /** Run lint and typecheck quality checks before allowing session stop. */
  qualityChecksGate?: boolean
  /** Enforce feature-branch workflow even for solo repositories. */
  strictNoDirectMain?: boolean
  /** When true, work directly on the default branch — no feature branches or PRs. */
  trunkMode?: boolean
  /** Warn when an in-progress task exceeds this runtime. */
  taskDurationWarningMinutes?: number
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
  /** Glob patterns for files exempt from large-file checks (e.g. "test-fixtures/**") */
  largeFileAllowPatterns?: string[]
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
  /** When true, types "Continue" into the terminal after every tool call via AppleScript. */
  autoSteer: boolean
  updateMemoryFooter: boolean
  gitStatusGate: boolean
  nonDefaultBranchGate: boolean
  githubCiGate: boolean
  changesRequestedGate: boolean
  personalRepoIssuesGate: boolean
  /** When true, blocks issue close commands unless explicitly allowed. */
  issueCloseGate: boolean
  /** When true, runs lint and typecheck quality checks before allowing session stop. */
  qualityChecksGate: boolean
  /** When true, blocks all direct pushes to the default branch regardless of repo type. */
  strictNoDirectMain: boolean
  /** When true, work directly on the default branch — no feature branches or PRs. */
  trunkMode: boolean
  taskDurationWarningMinutes: number
  memoryLineThreshold: number
  memoryWordThreshold: number
  largeFileSizeKb: number
  /** Dirty-file count threshold for the worktree gate hook. */
  dirtyWorktreeThreshold: number
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

/** Resolve effective memory thresholds with per-value source tracking. */
export interface ResolvedMemoryThresholds {
  memoryLineThreshold: number
  memoryLineSource: "project" | "user" | "default"
  memoryWordThreshold: number
  memoryWordSource: "project" | "user" | "default"
}

// ─── Zod schemas for settings objects ────────────────────────────────────────

export const sessionSwizSettingsSchema = z.object({
  autoContinue: z.boolean().optional(),
  prMergeMode: z.boolean().optional(),
  ambitionMode: ambitionModeSchema.optional(),
  collaborationMode: collaborationModeSchema.optional(),
})

export const projectSettingsSchema = z.object({
  autoContinue: z.boolean().optional(),
  profile: policyProfileSchema.optional(),
  trivialMaxFiles: z.number().int().min(1).optional(),
  trivialMaxLines: z.number().int().min(1).optional(),
  defaultBranch: z.string().min(1).regex(/^\S+$/).optional(),
  memoryLineThreshold: z.number().int().min(1).optional(),
  memoryWordThreshold: z.number().int().min(1).optional(),
  largeFileSizeKb: z.number().int().min(1).optional(),
  dirtyWorktreeThreshold: z.number().int().min(1).optional(),
  ambitionMode: ambitionModeSchema.optional(),
  collaborationMode: collaborationModeSchema.optional(),
  qualityChecksGate: z.boolean().optional(),
  strictNoDirectMain: z.boolean().optional(),
  trunkMode: z.boolean().optional(),
  taskDurationWarningMinutes: z.number().int().min(1).optional(),
  disabledHooks: z.array(z.string().min(1)).optional(),
  plugins: z.array(z.string().min(1)).optional(),
  allowedSkillCategories: z.array(z.string().min(1)).optional(),
  largeFileAllowPatterns: z.array(z.string().min(1)).optional(),
})
