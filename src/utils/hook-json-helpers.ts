/**
 * Shared JSON and stderr helpers for hook subprocess output and dispatch.
 *
 * Keep this module free of imports from `hook-utils.ts`, `SwizHook.ts`, or
 * `settings.ts` so it can be used from those modules without cycles.
 */

/** Non-null `typeof value === "object"` (includes arrays and Dates). */
export function isJsonLikeRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object"
}

/** Safe message for `catch (err)` — matches the common `instanceof Error` pattern. */
export function messageFromUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Hook envelopes treat `{}` as "no output". Matches
 * `output && Object.keys(output).length > 0` used before emitting stdout.
 */
export function hasNonEmptyHookOutput(output: unknown): output is Record<string, any> {
  return isJsonLikeRecord(output) && Object.keys(output).length > 0
}

/** Default max length for PreToolUse / short UI previews on `systemMessage`. */
export const DEFAULT_HOOK_PREVIEW_LEN = 70

/**
 * First logical line of `text`, trimmed, optionally capped with `...` for hook `systemMessage` previews.
 * Matches dispatch subprocess helpers (replaces ad-hoc `slice(0, 70)` first-line logic).
 */
export function extractHookSystemMessagePreview(
  text: string,
  maxLen = DEFAULT_HOOK_PREVIEW_LEN
): string {
  const line = text.split("\n").shift()?.trim() || ""
  if (maxLen <= 0) return line
  return line.length > maxLen ? `${line.slice(0, maxLen - 3).trimEnd()}...` : line
}
