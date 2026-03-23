import { resolve } from "node:path"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import {
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
  resolveMemoryThresholds,
} from "../settings.ts"
import type { Command } from "../types.ts"

// ─── Line classification ─────────────────────────────────────────────────────

type LineClass = "pinned" | "shrinkable" | "empty"

/**
 * Lines matching these patterns are never removed during compaction.
 * Order matters: earlier patterns take priority.
 */
const PINNED_PATTERNS: RegExp[] = [
  /^#{1,6} /, // any heading
  /^- \*\*(DO|DON'T|NEVER|CRITICAL|IMPORTANT|WARNING)\b/, // directive bullets
  /^\*\*(DO|DON'T|NEVER|CRITICAL|IMPORTANT|WARNING)\b/, // bare directives
  /^```/, // code fence delimiter
]

function classifyLine(line: string, inCodeFence: boolean): LineClass {
  if (line.trim() === "") return "empty"
  if (inCodeFence) return "pinned" // content inside a code fence
  for (const pattern of PINNED_PATTERNS) {
    if (pattern.test(line)) return "pinned"
  }
  return "shrinkable"
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// ─── Core compaction ──────────────────────────────────────────────────────────

interface AnnotatedLine {
  text: string
  class: LineClass
  words: number
  index: number // original position
}

/**
 * Compact the given text to at most `threshold` words.
 *
 * Returns the compacted text and a summary of what was removed.
 * Pinned lines (headings, DO/DON'T directives, code blocks) are never removed.
 * Shrinkable lines are removed greedy-largest-first (deterministic).
 */
export function compactText(
  text: string,
  threshold: number
): { output: string; removedCount: number; before: number; after: number } {
  const rawLines = text.split("\n")

  // Annotate every line
  let inFence = false
  const annotated: AnnotatedLine[] = rawLines.map((raw, i) => {
    const cls = classifyLine(raw, inFence)
    // Toggle fence state AFTER classifying the delimiter line itself (pinned)
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence
    }
    return { text: raw, class: cls, words: countWords(raw), index: i }
  })

  const totalWords = annotated.reduce((sum, l) => sum + l.words, 0)

  const toRemove = new Set<number>()

  if (totalWords > threshold) {
    // Collect shrinkable lines, sort by word count desc then index asc (deterministic)
    const shrinkable = annotated
      .filter((l) => l.class === "shrinkable")
      .sort((a, b) => b.words - a.words || a.index - b.index)

    let freed = 0
    const deficit = totalWords - threshold

    for (const line of shrinkable) {
      if (freed >= deficit) break
      toRemove.add(line.index)
      freed += line.words
    }
  }

  // Always reconstruct to normalize whitespace (collapse 3+ consecutive empties to 2)
  const kept: string[] = []
  let consecutiveEmpties = 0

  for (const line of annotated) {
    if (toRemove.has(line.index)) continue

    if (line.class === "empty") {
      consecutiveEmpties++
      if (consecutiveEmpties <= 1) {
        kept.push(line.text)
      }
    } else {
      consecutiveEmpties = 0
      kept.push(line.text)
    }
  }

  const output = kept.join("\n")
  const after = kept.reduce((sum, l) => sum + countWords(l), 0)

  return { output, removedCount: toRemove.size, before: totalWords, after }
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

interface ParsedCompactArgs {
  filePath: string
  threshold: number
  dryRun: boolean
  targetDir: string
}

function extractFlagValue(args: string[], flag: string, shortFlag: string): string | undefined {
  const idx = args.findIndex((a) => a === flag || a === shortFlag)
  return idx >= 0 ? args[idx + 1] : undefined
}

function collectFlagIndices(args: string[]): Set<number> {
  const flagValues = new Set<number>()
  for (const flag of ["--dir", "-d", "--threshold", "-t"]) {
    const idx = args.indexOf(flag)
    if (idx >= 0) {
      flagValues.add(idx)
      flagValues.add(idx + 1)
    }
  }
  return flagValues
}

function parseCompactArgs(args: string[]): ParsedCompactArgs {
  const dryRun = args.includes("--dry-run")

  const dirRaw = extractFlagValue(args, "--dir", "-d")
  const targetDir = resolve(dirRaw ?? process.cwd())

  const thresholdRaw = extractFlagValue(args, "--threshold", "-t")
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : 0

  // The file path is the first positional argument (not a flag or flag value)
  const flagValues = collectFlagIndices(args)
  const positionals = args.filter((a, i) => !a.startsWith("-") && !flagValues.has(i))
  const fileArg = positionals[0]

  if (!fileArg) {
    throw new Error(
      "Usage: swiz compact-memory <file> [--threshold <words>] [--dry-run] [--dir <path>]"
    )
  }

  if (thresholdRaw !== undefined && (Number.isNaN(threshold) || threshold <= 0)) {
    throw new Error(`--threshold must be a positive integer, got: ${thresholdRaw}`)
  }

  return {
    filePath: resolve(fileArg),
    threshold,
    dryRun,
    targetDir,
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const compactCommand: Command = {
  name: "compact-memory",
  description:
    "Compact a memory file to stay under its word threshold, preserving pinned directives",
  usage: "swiz compact-memory <file> [--threshold <words>] [--dry-run] [--dir <path>]",
  options: [
    { flags: "<file>", description: "Memory file to compact (e.g. CLAUDE.md)" },
    {
      flags: "--threshold, -t <words>",
      description: `Word cap (default: resolved from project/user settings or ${DEFAULT_MEMORY_WORD_THRESHOLD})`,
    },
    { flags: "--dry-run", description: "Preview removals without writing the file" },
    {
      flags: "--dir, -d <path>",
      description: "Project directory for settings resolution (default: cwd)",
    },
  ],
  async run(args: string[]) {
    const { filePath, threshold: explicitThreshold, dryRun, targetDir } = parseCompactArgs(args)

    // Resolve threshold from settings (project > user > default) unless explicit
    let threshold = explicitThreshold
    if (!threshold) {
      const projectSettings = await readProjectSettings(targetDir)
      const userSettings = await readSwizSettings({ strict: false })
      const userThresholdInputs = {
        memoryLineThreshold: userSettings?.memoryLineThreshold,
        memoryWordThreshold: userSettings?.memoryWordThreshold,
      }
      const defaultInput = {
        memoryLineThreshold: 1400,
        memoryWordThreshold: DEFAULT_MEMORY_WORD_THRESHOLD,
      }
      const resolved = resolveMemoryThresholds(projectSettings, userThresholdInputs, defaultInput)
      threshold = resolved.memoryWordThreshold
    }

    // Read file
    const file = Bun.file(filePath)
    const exists = await file.exists()
    if (!exists) {
      throw new Error(`File not found: ${filePath}`)
    }

    const text = await file.text()
    const { output, removedCount, before, after } = compactText(text, threshold)

    console.log(`\n  ${BOLD}swiz compact-memory${RESET}`)
    console.log(`  File:      ${filePath}`)
    console.log(`  Threshold: ${CYAN}${threshold} words${RESET}`)
    console.log(`  Before:    ${before > threshold ? YELLOW : GREEN}${before} words${RESET}`)

    if (removedCount === 0) {
      console.log(`  Status:    ${GREEN}✓ within threshold — no changes needed${RESET}\n`)
      return
    }

    const afterColor = after > threshold ? RED : GREEN
    console.log(`  Removed:   ${removedCount} shrinkable line(s)`)
    console.log(`  After:     ${afterColor}${after} words${RESET}`)

    if (after > threshold) {
      console.log(
        `\n  ${YELLOW}⚠ Warning: all shrinkable lines removed but file still exceeds threshold.${RESET}`
      )
      console.log(
        `  ${DIM}Pinned lines (headings, DO/DON'T directives, code blocks) cannot be removed.${RESET}`
      )
      console.log(`  ${DIM}Manual review required to reduce further.${RESET}`)
    }

    if (dryRun) {
      console.log(`\n  ${DIM}--dry-run: file not modified${RESET}\n`)
      return
    }

    await Bun.write(filePath, output)
    console.log(`\n  ${GREEN}✓ File updated${RESET}\n`)
  },
}
