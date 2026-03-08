export interface MemoryStats {
  lines: number
  words: number
}

export interface MemoryThresholds {
  lineThreshold: number
  wordThreshold: number
}

/**
 * Return human-readable threshold violations for a memory file.
 *
 * Example:
 * `getMemoryThresholdViolations({ lines: 1500, words: 5200 }, { lineThreshold: 1400, wordThreshold: 5000 })`
 * -> ["1500 lines (threshold: 1400)", "5200 words (threshold: 5000)"]
 */
export function getMemoryThresholdViolations(
  stats: MemoryStats,
  thresholds: MemoryThresholds
): string[] {
  const violations: string[] = []
  if (stats.lines > thresholds.lineThreshold) {
    violations.push(`${stats.lines} lines (threshold: ${thresholds.lineThreshold})`)
  }
  if (stats.words > thresholds.wordThreshold) {
    violations.push(`${stats.words} words (threshold: ${thresholds.wordThreshold})`)
  }
  return violations
}

/** Convenience predicate for threshold checks. */
export function exceedsMemoryThresholds(stats: MemoryStats, thresholds: MemoryThresholds): boolean {
  return getMemoryThresholdViolations(stats, thresholds).length > 0
}
