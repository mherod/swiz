#!/usr/bin/env bun

// PostToolUse hook: Advise compaction when CLAUDE.md or memory files exceed size thresholds.
// Fires after Edit|Write on files matching CLAUDE.md or .claude/**/memory/**/*.md.
// Non-blocking — injects additionalContext with compaction instructions.
// Thresholds are configurable via global (~/.swiz/settings.json) and project (.swiz/config.json).

import {
  DEFAULT_MEMORY_LINE_THRESHOLD,
  DEFAULT_MEMORY_WORD_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
} from "../src/settings.ts"
import { isFileEditTool, skillAdvice, type ToolHookInput } from "./hook-utils.ts"

/** Check whether the given path is a CLAUDE.md or a memory .md file. */
function isMemoryFile(filePath: string): boolean {
  if (/\/CLAUDE\.md$/.test(filePath)) return true
  if (/\/MEMORY\.md$/.test(filePath)) return true
  // Memory files under .claude/projects/*/memory/*.md or .claude/memory/*.md
  if (/\/\.claude\/.*\/memory\/.*\.md$/.test(filePath)) return true
  return false
}

function countStats(content: string): { lines: number; words: number } {
  const lines = content.split("\n").length
  const words = content.split(/\s+/).filter(Boolean).length
  return { lines, words }
}

/** Resolve thresholds: project config > global config > defaults. */
async function resolveThresholds(
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

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput
  const tool = input.tool_name ?? ""
  const filePath = (input.tool_input?.file_path as string) ?? ""

  if (!isFileEditTool(tool)) return
  if (!filePath || !isMemoryFile(filePath)) return

  const cwd = input.cwd ?? process.cwd()
  const { lineThreshold, wordThreshold } = await resolveThresholds(cwd)

  // Read the file content after the edit
  const file = Bun.file(filePath)
  if (!(await file.exists())) return
  const content = await file.text()
  const { lines, words } = countStats(content)

  const violations: string[] = []
  if (lines > lineThreshold) {
    violations.push(`${lines} lines (threshold: ${lineThreshold})`)
  }
  if (words > wordThreshold) {
    violations.push(`${words} words (threshold: ${wordThreshold})`)
  }

  if (violations.length === 0) return

  const basename = filePath.split("/").pop() ?? filePath
  const compactAdvice = skillAdvice(
    "compact-memory",
    `Use the /compact-memory skill to reduce ${basename} below thresholds.`,
    `Compact ${basename} manually: remove redundant modifiers, simplify compound phrases, consolidate repeated topics, and convert narrative to DO/DON'T directives.`
  )

  const context = [
    `${basename} exceeds size thresholds after edit: ${violations.join(", ")}.`,
    compactAdvice,
    "Key strategies: remove redundant modifiers, eliminate parenthetical redundancy, condense code snippets, collapse similar lists, convert session notes to DOs/DONTs.",
    "CLAUDE.md is a direct codebase guide, NOT a diary — all content must be prescriptive and actionable.",
  ].join(" ")

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    })
  )
}

main()
