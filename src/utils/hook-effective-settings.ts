/**
 * Resolve {@link EffectiveSwizSettings} for tool hooks, matching dispatch behaviour:
 * prefer `_effectiveSettings` when the dispatcher injected a full payload; otherwise
 * merge global + session + project settings from disk.
 */

import {
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../settings.ts"

/**
 * True when `value` looks like the dispatcher-injected effective settings object.
 * Uses `collaborationMode` as the sentinel (always present on effective settings).
 */
function isInjectedEffectiveSettings(value: unknown): value is EffectiveSwizSettings {
  if (value === null || typeof value !== "object") return false
  return typeof (value as { collaborationMode?: unknown }).collaborationMode === "string"
}

/**
 * @param payload - Hook stdin payload (e.g. PostToolUse) possibly containing `_effectiveSettings`.
 */
export async function getEffectiveSwizSettingsForToolHook(input: {
  cwd: string
  session_id?: string
  payload: Record<string, any>
}): Promise<EffectiveSwizSettings> {
  const injected = input.payload._effectiveSettings
  if (isInjectedEffectiveSettings(injected)) {
    return injected
  }
  const [settings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(input.cwd),
  ])
  return getEffectiveSwizSettings(settings, input.session_id, projectSettings)
}
