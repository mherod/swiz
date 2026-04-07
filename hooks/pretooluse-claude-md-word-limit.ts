#!/usr/bin/env bun

// PreToolUse hook: Prevent CLAUDE.md files from exceeding the configured word limit.
// Blocks Edit/Write operations that would push the file over the threshold.
// Threshold is read from project > global > default (5000) settings, matching
// posttooluse-memory-size.ts and `swiz memory --strict` pre-commit enforcement.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { countMarkdownWords } from "../src/markdown-word-count.ts"
import {
  COMPACT_MEMORY_SKILL_ID,
  compactionChecklistSteps,
  manualCompactionGuidanceFallback,
  USE_COMPACT_MEMORY_SKILL,
} from "../src/memory-compaction-guidance.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
} from "../src/SwizHook.ts"
import type { FileEditHookInput } from "../src/schemas.ts"
import { DEFAULT_MEMORY_WORD_THRESHOLD, resolveNumericSetting } from "../src/settings.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { computeProjectedContent, isFileEditForPath } from "../src/utils/edit-projection.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

async function buildWordLimitDenyReason(
  filePath: string,
  projectedWordCount: number,
  wordThreshold: number
): Promise<string> {
  const currentContent = await Bun.file(filePath)
    .text()
    .catch(() => "")
  const currentWordCount = countMarkdownWords(currentContent)
  const skill = skillAdvice(
    COMPACT_MEMORY_SKILL_ID,
    `${USE_COMPACT_MEMORY_SKILL} to reduce the file below ${wordThreshold} words, then retry this edit.`,
    manualCompactionGuidanceFallback()
  )
  const inlineChecklist = formatActionPlan(
    compactionChecklistSteps(`Re-check size: \`wc -w ${filePath}\``),
    { header: "Compaction checklist:" }
  )
  return (
    `CLAUDE.md word limit exceeded.\n\n` +
    `Current: ${currentWordCount} words\n` +
    `After edit: ${projectedWordCount} words\n` +
    `Limit: ${wordThreshold} words\n\n` +
    `The CLAUDE.md file cannot exceed ${wordThreshold} words. ` +
    `This limit keeps the memory file focused and performant.\n\n` +
    `${skill}\n\n` +
    `${inlineChecklist}`
  )
}

async function checkWordLimit(input: FileEditHookInput) {
  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""
  const cwd = input.cwd ?? process.cwd()

  const wordThreshold = await resolveNumericSetting(
    cwd,
    "memoryWordThreshold",
    DEFAULT_MEMORY_WORD_THRESHOLD
  )
  const projectedContent = await computeProjectedContent(
    toolName,
    filePath,
    (input.tool_input as Record<string, any>) ?? {}
  )
  if (projectedContent === null) return preToolUseAllow("")
  const projectedWordCount = countMarkdownWords(projectedContent)

  if (projectedWordCount > wordThreshold) {
    return preToolUseDeny(
      await buildWordLimitDenyReason(filePath, projectedWordCount, wordThreshold)
    )
  }

  return preToolUseAllow("")
}

const pretoolusClaudeMdWordLimit: SwizHook<FileEditHookInput> = {
  name: "pretooluse-claude-md-word-limit",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  async run(rawInput) {
    const input = rawInput as FileEditHookInput
    if (!isFileEditForPath(input, "CLAUDE.md")) return {}

    try {
      return await checkWordLimit(input)
    } catch {
      return preToolUseAllow("")
    }
  },
}

export default pretoolusClaudeMdWordLimit

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusClaudeMdWordLimit)
