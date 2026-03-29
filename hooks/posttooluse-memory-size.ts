#!/usr/bin/env bun

// PostToolUse hook: Advise compaction when CLAUDE.md or memory files exceed size thresholds.
// Fires after Edit|Write on files matching CLAUDE.md or .claude/**/memory/**/*.md.
// Non-blocking — injects additionalContext with compaction instructions.
// Thresholds are configurable via global (~/.swiz/settings.json) and project (.swiz/config.json).

import {
  COMPACT_MEMORY_SKILL_ID,
  compactionChecklistSteps,
  manualCompactionFallback,
  USE_COMPACT_MEMORY_SKILL,
} from "../src/memory-compaction-guidance.ts"
import { getMemoryThresholdViolations } from "../src/memory-thresholds.ts"
import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
} from "../src/settings.ts"
import {
  emitContext,
  formatActionPlan,
  isFileEditTool,
  skillAdvice,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/** Check whether the given path is a CLAUDE.md or a memory .md file. */
export function isMemoryFile(filePath: string): boolean {
  if (/\/CLAUDE\.md$/.test(filePath)) return true
  if (/\/MEMORY\.md$/.test(filePath)) return true
  // Memory files under .claude/projects/*/memory/*.md or .claude/memory/*.md
  if (/\/\.claude\/.*\/memory\/.*\.md$/.test(filePath)) return true
  return false
}

export function countStats(content: string): { lines: number; words: number } {
  if (content.length === 0) return { lines: 0, words: 0 }
  const parts = content.split("\n")
  const lines = content.endsWith("\n") ? parts.length - 1 : parts.length
  const words = content.split(/\s+/).filter(Boolean).length
  return { lines, words }
}

/** Resolve thresholds: project config > global config > defaults. */
export async function resolveThresholds(
  cwd: string
): Promise<{ lineThreshold: number; wordThreshold: number }> {
  const globalSettings = await readSwizSettings()
  const projectSettings = await readProjectSettings(cwd)

  return {
    lineThreshold:
      projectSettings?.memoryLineThreshold ??
      globalSettings.memoryLineThreshold ??
      DEFAULT_MEMORY_LINE_THRESHOLD,
    wordThreshold:
      projectSettings?.memoryWordThreshold ??
      globalSettings.memoryWordThreshold ??
      DEFAULT_MEMORY_WORD_THRESHOLD,
  }
}

function resolveMemoryEditTarget(
  input: ReturnType<typeof toolHookInputSchema.parse>
): string | null {
  const tool = input.tool_name ?? ""
  const filePath = (input.tool_input?.file_path as string) ?? ""
  if (!isFileEditTool(tool)) return null
  if (!filePath || !isMemoryFile(filePath)) return null
  return filePath
}

function buildViolationContext(filePath: string, violations: string[]): string {
  const basename = filePath.split("/").pop() ?? filePath
  const compactAdvice = skillAdvice(
    COMPACT_MEMORY_SKILL_ID,
    `${USE_COMPACT_MEMORY_SKILL} to reduce ${basename} below thresholds.`,
    manualCompactionFallback(basename)
  )
  const compactionChecklist = formatActionPlan(
    compactionChecklistSteps(
      `Re-check size after edits: \`wc -l "${filePath}" && wc -w "${filePath}"\`.`
    ),
    { header: "Compaction checklist:" }
  ).trimEnd()

  return [
    `${basename} exceeds size thresholds after edit: ${violations.join(", ")}.`,
    compactAdvice,
    compactionChecklist,
  ].join("\n\n")
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const filePath = resolveMemoryEditTarget(input)
  if (!filePath) return

  const cwd = input.cwd ?? process.cwd()
  const { lineThreshold, wordThreshold } = await resolveThresholds(cwd)

  const file = Bun.file(filePath)
  if (!(await file.exists())) return
  const { lines, words } = countStats(await file.text())

  const violations = getMemoryThresholdViolations(
    { lines, words },
    { lineThreshold, wordThreshold }
  )
  if (violations.length === 0) return

  await emitContext("PostToolUse", buildViolationContext(filePath, violations), cwd)
}

if (import.meta.main) void main()
