/**
 * Format a millisecond duration into a human-readable string.
 * e.g. 90000 → "1m", 3661000 → "1h 1m", 90061000 → "1d 1h"
 */
/**
 * Format a millisecond duration in seconds or minutes without losing precision.
 * e.g. 45000 → "45s", 120000 → "2m", 130000 → "2m 10s", 1500 → "1.5s"
 */
export function formatDurationPrecise(ms: number): string {
  const totalSeconds = ms / 1000
  const renderSeconds = (seconds: number): string =>
    Number.isInteger(seconds) ? `${seconds}s` : `${Number(seconds.toFixed(1))}s`
  if (totalSeconds < 60) return renderSeconds(totalSeconds)
  const mins = Math.floor(totalSeconds / 60)
  const remainSeconds = Math.round((totalSeconds - mins * 60) * 10) / 10
  if (remainSeconds === 0) return `${mins}m`
  return `${mins}m ${renderSeconds(remainSeconds)}`
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`
}
