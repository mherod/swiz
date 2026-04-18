import type { DiagnosticCheck } from "../types.ts"
import { agentBinaryAndSettingsCheck } from "./agent-binary-and-settings.ts"
import { agentConfigSyncCheck } from "./agent-config-sync.ts"
import { bunRuntimeCheck } from "./bun-runtime.ts"
import { configScriptsCheck } from "./config-scripts.ts"
import { ghAuthCheck } from "./gh-auth.ts"
import { hookScriptsCheck } from "./hook-scripts.ts"
import { invalidSkillEntriesCheck } from "./invalid-skill-entries.ts"
import { manifestPathsCheck } from "./manifest-paths.ts"
import { pluginCacheCheck } from "./plugin-cache.ts"
import { scriptPermissionsCheck } from "./script-permissions.ts"
import { skillConflictsCheck } from "./skill-conflicts.ts"
import { swizSettingsCheck } from "./swiz-settings.ts"
import { ttsBackendCheck } from "./tts-backend.ts"

/** All pluggable diagnostic checks. Order determines display order. */
export const DIAGNOSTIC_CHECKS: DiagnosticCheck[] = [
  bunRuntimeCheck,
  ghAuthCheck,
  ttsBackendCheck,
  agentBinaryAndSettingsCheck,
  hookScriptsCheck,
  manifestPathsCheck,
  configScriptsCheck,
  scriptPermissionsCheck,
  agentConfigSyncCheck,
  skillConflictsCheck,
  invalidSkillEntriesCheck,
  pluginCacheCheck,
  swizSettingsCheck,
]
