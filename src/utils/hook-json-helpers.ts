/**
 * Shared JSON and stderr helpers for hook subprocess output and dispatch.
 *
 * Keep this module free of imports from `hook-utils.ts`, `SwizHook.ts`, or
 * `settings.ts` so it can be used from those modules without cycles.
 */

/** Non-null `typeof value === "object"` (includes arrays and Dates). */
export function isJsonLikeRecord(value: unknown): value is Record<string, unknown> {
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
export function hasNonEmptyHookOutput(output: unknown): output is Record<string, unknown> {
  return isJsonLikeRecord(output) && Object.keys(output).length > 0
}
