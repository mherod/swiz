import { BOLD, CYAN, DIM, GREEN, RED, RESET } from "../ansi.ts"

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

export type DiffOp = { type: "equal" | "delete" | "insert"; line: string }

export function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  return dp
}

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const dp = computeLCS(a, b)
  const ops: DiffOp[] = []

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "delete", line: a[i]! })
      i++
    } else {
      ops.push({ type: "insert", line: b[j]! })
      j++
    }
  }
  while (i < a.length) {
    ops.push({ type: "delete", line: a[i]! })
    i++
  }
  while (j < b.length) {
    ops.push({ type: "insert", line: b[j]! })
    j++
  }
  return ops
}

export function buildHunk(
  tagged: Array<DiffOp & { oldLine: number; newLine: number }>,
  start: number,
  end: number
): DiffHunk {
  const lines: string[] = []
  let oldStart = 0
  let oldCount = 0
  let newStart = 0
  let newCount = 0

  for (let i = start; i <= end; i++) {
    const t = tagged[i]!
    if (t.type === "equal") {
      if (!oldStart) oldStart = t.oldLine
      if (!newStart) newStart = t.newLine
      oldCount++
      newCount++
      lines.push(`  ${DIM} ${t.line}${RESET}`)
    } else if (t.type === "delete") {
      if (!oldStart) oldStart = t.oldLine
      oldCount++
      lines.push(`  ${RED}-${t.line}${RESET}`)
    } else {
      if (!newStart) newStart = t.newLine
      newCount++
      lines.push(`  ${GREEN}+${t.line}${RESET}`)
    }
  }

  return {
    oldStart: oldStart || 1,
    oldCount,
    newStart: newStart || 1,
    newCount,
    lines,
  }
}

export function formatUnifiedDiff(
  path: string,
  oldText: string,
  newText: string,
  contextLines = 3
): string {
  if (oldText === newText) return `  ${DIM}${path}: no changes${RESET}\n`

  const ops = diffLines(oldText, newText)
  const hunks: DiffHunk[] = []

  let oldLine = 0
  let newLine = 0

  const tagged = ops.map((op) => {
    const entry = { ...op, oldLine: 0, newLine: 0 }
    if (op.type === "equal") {
      entry.oldLine = ++oldLine
      entry.newLine = ++newLine
    } else if (op.type === "delete") {
      entry.oldLine = ++oldLine
    } else {
      entry.newLine = ++newLine
    }
    return entry
  })

  const changeIndices = tagged.map((t, i) => (t.type !== "equal" ? i : -1)).filter((i) => i >= 0)

  if (changeIndices.length === 0) return `  ${DIM}${path}: no changes${RESET}\n`

  let hunkStart = -1
  let hunkEnd = -1

  for (const ci of changeIndices) {
    const lo = Math.max(0, ci - contextLines)
    const hi = Math.min(tagged.length - 1, ci + contextLines)

    if (hunkStart === -1) {
      hunkStart = lo
      hunkEnd = hi
    } else if (lo <= hunkEnd + 1) {
      hunkEnd = hi
    } else {
      hunks.push(buildHunk(tagged, hunkStart, hunkEnd))
      hunkStart = lo
      hunkEnd = hi
    }
  }
  if (hunkStart !== -1) hunks.push(buildHunk(tagged, hunkStart, hunkEnd))

  const lines: string[] = []
  lines.push(`  ${BOLD}--- ${path}${RESET}`)
  lines.push(`  ${BOLD}+++ ${path} (proposed)${RESET}`)

  for (const hunk of hunks) {
    lines.push(
      `  ${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}`
    )
    lines.push(...hunk.lines)
  }

  return `${lines.join("\n")}\n`
}
