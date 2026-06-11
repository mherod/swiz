/**
 * Format a millisecond duration into a human-readable string.
 * e.g. 90000 → "1m", 3661000 → "1h 1m", 90061000 → "1d 1h"
 */
/**
 * Format a millisecond duration in seconds, minutes, or hours without losing
 * precision. Tiers into an hour component at 60m, dropping zero parts the same
 * way `formatDuration()` does (e.g. 3630500 → "1h 30.5s", not "1h 0m 30.5s").
 * e.g. 45000 → "45s", 120000 → "2m", 130000 → "2m 10s", 1500 → "1.5s",
 *      3600000 → "1h", 7500000 → "2h 5m", 3661000 → "1h 1m 1s"
 */
export function formatDurationPrecise(ms: number): string {
  const totalSeconds = ms / 1000
  const renderSeconds = (seconds: number): string =>
    Number.isInteger(seconds) ? `${seconds}s` : `${Number(seconds.toFixed(1))}s`
  if (totalSeconds < 60) return renderSeconds(totalSeconds)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const remainSeconds = Math.round((totalSeconds - totalMinutes * 60) * 10) / 10
  if (totalMinutes < 60) {
    return remainSeconds === 0
      ? `${totalMinutes}m`
      : `${totalMinutes}m ${renderSeconds(remainSeconds)}`
  }
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  const parts = [`${hours}h`]
  if (mins > 0) parts.push(`${mins}m`)
  if (remainSeconds > 0) parts.push(renderSeconds(remainSeconds))
  return parts.join(" ")
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
