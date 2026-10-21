/**
 * Parse transcript timestamps as milliseconds, or null when absent or invalid.
 * Finite numeric values are already milliseconds; strings retain Date.parse semantics.
 * For example, parseTimestampMs("1970-01-01T00:00:00Z") returns 0.
 */
export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
