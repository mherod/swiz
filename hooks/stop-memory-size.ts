#!/usr/bin/env bun
// Stop hook: Block stop if any memory file exceeds the configured size thresholds.
// Scans CLAUDE.md and MEMORY.md files reachable from the session cwd at stop time.
// Uses the same threshold resolution and file matching as posttooluse-memory-size.ts
// to ensure the two hooks cannot drift independently.

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  compactionChecklistSteps,
  manualCompactionFallback,
} from "../src/memory-compaction-guidance.ts"
import { getMemoryThresholdViolations } from "../src/memory-thresholds.ts"
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
      if (entry === "node_modules" || entry === ".git") continue
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
  const home = process.env.HOME ?? ""
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

  const violations: MemoryViolation[] = []

  for (const filePath of allFiles) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) continue
    const content = await file.text()
    const { lines, words } = countStats(content)

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

main()
