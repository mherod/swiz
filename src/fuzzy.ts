/** Compute Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}

/**
 * Return the candidate most similar to `input` from `candidates`, or null if
 * no candidate is within the edit-distance threshold (max(3, floor(len/2))).
 */
export function suggest(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const c of candidates) {
    const dist = editDistance(input.toLowerCase(), c.toLowerCase())
    if (dist < bestDist) {
      bestDist = dist
      best = c
    }
  }
  const threshold = Math.max(3, Math.floor(input.length / 2))
  return best !== null && bestDist <= threshold ? best : null
}
