#!/usr/bin/env bun
// Stop hook: Block stop if any memory file exceeds the configured size thresholds.
// Scans CLAUDE.md and MEMORY.md files reachable from the session cwd at stop time.
// Uses the same threshold resolution and file matching as posttooluse-memory-size.ts
// to ensure the two hooks cannot drift independently.
//
// Performance: uses an incremental mtime/size index at .swiz/memory-index.json so
// unchanged files are not re-read on every stop invocation.

import { mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { GIT_DIR_NAME } from "../src/git-helpers.ts"
import { getHomeDirWithFallback } from "../src/home.ts"
import {
  compactionChecklistSteps,
  manualCompactionFallback,
} from "../src/memory-compaction-guidance.ts"
import { getMemoryThresholdViolations } from "../src/memory-thresholds.ts"
import { NODE_MODULES_DIR } from "../src/node-modules-path.ts"
import { blockStop, formatActionPlan, isGitRepo, skillAdvice } from "./hook-utils.ts"
import { countStats, isMemoryFile, resolveThresholds } from "./posttooluse-memory-size.ts"
import { stopHookInputSchema } from "./schemas.ts"

interface MemoryViolation {
  filePath: string
  basename: string
  lines: number
  words: number
  violations: string[]
}

/** Cached entry stored in .swiz/memory-index.json per discovered file. */
interface IndexEntry {
  /** Last-modified time in milliseconds (from stat.mtimeMs). */
  mtime: number
  /** File size in bytes (from stat.size). Used alongside mtime as cache key. */
  size: number
  lines: number
  words: number
}

type MemoryIndex = Record<string, IndexEntry>

/** Path to the persistent incremental index for a project. */
export function indexPath(cwd: string): string {
  return join(cwd, ".swiz", "memory-index.json")
}

/** Load the existing index from disk; returns empty object on any error. */
export async function loadIndex(cwd: string): Promise<MemoryIndex> {
  try {
    const text = await Bun.file(indexPath(cwd)).text()
    return JSON.parse(text) as MemoryIndex
  } catch {
    return {}
  }
}

/** Persist the updated index. Silently ignores write failures. */
export async function saveIndex(cwd: string, index: MemoryIndex): Promise<void> {
  try {
    const dir = join(cwd, ".swiz")
    await mkdir(dir, { recursive: true })
    await Bun.write(indexPath(cwd), JSON.stringify(index, null, 2))
  } catch {
    // Non-fatal: next invocation will simply do a full read for missed entries.
  }
}

/**
 * Recursively walk `dir` (up to `maxDepth`) and collect every path for which
 * `isMemoryFile()` returns true.
 */
async function findMemoryFiles(dir: string, maxDepth = 4): Promise<string[]> {
  const results: string[] = []
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === NODE_MODULES_DIR || entry === GIT_DIR_NAME) continue
      const full = join(current, entry)
      if (isMemoryFile(full)) {
        results.push(full)
      } else if (!entry.includes(".")) {
        // Descend into directories (rough heuristic: no dot in name)
        await walk(full, depth + 1)
      }
    }
  }
  await walk(dir, 0)
  return results
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  // Only enforce inside git repos with a CLAUDE.md or .swiz config
  if (!(await isGitRepo(cwd))) return

  const { lineThreshold, wordThreshold } = await resolveThresholds(cwd)

  // Scan HOME/.claude hierarchy plus the project cwd
  const home = getHomeDirWithFallback("")
  const searchRoots = [cwd, join(home, ".claude")].filter(Boolean)

  const checkedFiles = new Set<string>()
  const allFiles: string[] = []
  for (const root of searchRoots) {
    const found = await findMemoryFiles(root)
    for (const f of found) {
      if (!checkedFiles.has(f)) {
        checkedFiles.add(f)
        allFiles.push(f)
      }
    }
  }

  // Load the incremental index and build updated stats, reading only changed files.
  const index = await loadIndex(cwd)
  const updatedIndex: MemoryIndex = {}
  const violations: MemoryViolation[] = []

  for (const filePath of allFiles) {
    let fileInfo: { mtime: number; size: number }
    try {
      const s = await stat(filePath)
      fileInfo = { mtime: s.mtimeMs, size: s.size }
    } catch {
      // File disappeared between discovery and stat — skip it.
      continue
    }

    const cached = index[filePath]
    let lines: number
    let words: number

    if (cached && cached.mtime === fileInfo.mtime && cached.size === fileInfo.size) {
      // Cache hit: file unchanged — reuse stored stats.
      ;({ lines, words } = cached)
    } else {
      // Cache miss: file is new or modified — read and recompute.
      const file = Bun.file(filePath)
      if (!(await file.exists())) continue
      const content = await file.text()
      ;({ lines, words } = countStats(content))
    }

    updatedIndex[filePath] = { mtime: fileInfo.mtime, size: fileInfo.size, lines, words }

    const fileViolations = getMemoryThresholdViolations(
      { lines, words },
      { lineThreshold, wordThreshold }
    )

    if (fileViolations.length > 0) {
      violations.push({
        filePath,
        basename: filePath.split("/").pop() ?? filePath,
        lines,
        words,
        violations: fileViolations,
      })
    }
  }

  // Persist the updated index (only entries for currently-discovered files).
  await saveIndex(cwd, updatedIndex)

  if (violations.length === 0) return

  const summary = violations.map((v) => `  ${v.filePath}: ${v.violations.join(", ")}`).join("\n")

  const perFileCommands = violations.map((v) => `  swiz compact-memory ${v.filePath}`).join("\n")

  const compactAdvice = skillAdvice(
    "compact-memory",
    `Use the /compact-memory skill or run these commands directly:\n${perFileCommands}`,
    `${manualCompactionFallback("each file")}\n\nOr run:\n${perFileCommands}`
  )

  const steps = [
    compactAdvice,
    ...compactionChecklistSteps("Re-check each file with `wc -l <file>` and `wc -w <file>`."),
  ]
  const actionPlan = formatActionPlan(steps)

  const reason =
    `Memory file(s) exceed size thresholds:\n\n${summary}\n\n` +
    `Thresholds: ${lineThreshold} lines, ${wordThreshold} words.\n\n` +
    `Compact the listed file(s) before stopping.\n` +
    actionPlan

  blockStop(reason)
}

if (import.meta.main) void main()
