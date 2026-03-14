// Barrel file — re-exports everything for backward compatibility.
// External consumers continue importing from "./settings" or "../settings" unchanged.

// Persistence (file I/O)
export {
  DEFAULT_SETTINGS,
  getProjectSettingsPath,
  getPrPollStatePath,
  getStatePath,
  getSwizSettingsPath,
  type ReadOptions,
  readProjectSettings,
  readProjectState,
  readStateData,
  readSwizSettings,
  resolveProjectHooks,
  swizSettingsSchema,
  type WriteOptions,
  writeProjectSettings,
  writeProjectState,
  writeSwizSettings,
} from "./persistence"

// Registry
export { SETTINGS_REGISTRY } from "./registry"

// Resolution logic
export {
  DEFAULT_DIRTY_WORKTREE_THRESHOLD,
  DEFAULT_LARGE_FILE_SIZE_KB,
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  DEFAULT_TASK_DURATION_WARNING_MINUTES,
  DEFAULT_TRIVIAL_MAX_FILES,
  DEFAULT_TRIVIAL_MAX_LINES,
  getEffectiveSwizSettings,
  POLICY_PROFILES,
  resolveMemoryThresholds,
  resolveNumericSetting,
  resolvePolicy,
} from "./resolution"
// SettingsStore
export { SettingsStore, settingsStore } from "./store"
// Types and schemas
export {
  ALL_STATUS_LINE_SEGMENTS,
  type AmbitionMode,
  ambitionModeSchema,
  // Derived constants
  COLLABORATION_MODES,
  type CollaborationMode,
  collaborationModeSchema,
  type EffectiveSwizSettings,
  // TypeScript types
  type PolicyProfile,
  PROJECT_STATES,
  type ProjectState,
  type ProjectSwizSettings,
  // Zod enum schemas
  policyProfileSchema,
  projectSettingsSchema,
  projectStateSchema,
  type ResolvedMemoryThresholds,
  type ResolvedPolicy,
  type SessionSwizSettings,
  type SettingDef,
  type SettingDoc,
  type SettingsScope,
  type SettingValueKind,
  STATE_TRANSITIONS,
  type StateData,
  type StateHistoryEntry,
  type StatusLineSegment,
  type SwizSettings,
  sessionSwizSettingsSchema,
  stateDataSchema,
  stateHistoryEntrySchema,
  TERMINAL_STATES,
} from "./types"
