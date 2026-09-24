import type { StopHookInput } from "./schemas.ts"
import type { EffectiveSwizSettings } from "./settings.ts"
import { getEffectiveSwizSettingsForToolHook } from "./utils/hook-effective-settings.ts"
import { readMacOSIdleSeconds } from "./utils/macos-idle.ts"

export type StopContinuationMode = "all" | "delivery" | "commit"
export type IdleSecondsProvider = () => Promise<number | null>

/** Resolve once per stop event; never change persisted auto-continue settings. */
export async function resolveStopContinuationMode(
  settings: Pick<EffectiveSwizSettings, "autoContinue" | "idleDeliveryMinutes">,
  readIdleSeconds: IdleSecondsProvider = readMacOSIdleSeconds
): Promise<StopContinuationMode> {
  if (settings.autoContinue !== false) return "all"
  const minutes = settings.idleDeliveryMinutes
  if (!Number.isFinite(minutes) || minutes <= 0) return "commit"
  try {
    const seconds = await readIdleSeconds()
    return seconds !== null && Number.isFinite(seconds) && seconds >= minutes * 60
      ? "delivery"
      : "commit"
  } catch {
    return "commit"
  }
}

/** Inline and worker hooks share the dispatcher's sample; standalone hooks sample locally. */
export async function stopContinuationModeForHook(
  input: StopHookInput
): Promise<StopContinuationMode> {
  const mode = input._stopContinuationMode
  if (mode === "all" || mode === "delivery" || mode === "commit") return mode
  const settings = await getEffectiveSwizSettingsForToolHook({
    cwd: input.cwd ?? process.cwd(),
    session_id: input.session_id,
    payload: input,
  })
  return await resolveStopContinuationMode(settings)
}
