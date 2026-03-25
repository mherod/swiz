#!/usr/bin/env bun

// PreToolUse hook: Prevent CLAUDE.md files from exceeding the configured word limit.
// Blocks Edit/Write operations that would push the file over the threshold.
// Threshold is read from project > global > default (5000) settings, matching
// posttooluse-memory-size.ts and `swiz memory --strict` pre-commit enforcement.

import { countMarkdownWords } from "../src/markdown-word-count.ts"
import {
  compactionChecklistSteps,
  manualCompactionGuidanceFallback,
} from "../src/memory-compaction-guidance.ts"
import { resolveThresholds } from "./posttooluse-memory-size.ts"
import type { FileEditHookInput } from "./schemas.ts"
import {
  allowPreToolUse,
  computeProjectedContent,
  denyPreToolUse,
  formatActionPlan,
  isEditTool,
  isWriteTool,
  skillAdvice,
} from "./utils/hook-utils.ts"

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
    "compact-memory",
    `Use the /compact-memory skill to reduce the file below ${wordThreshold} words, then retry this edit.`,
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

function isClaudeMdEdit(input: FileEditHookInput): boolean {
  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""
  return filePath.endsWith("CLAUDE.md") && (isEditTool(toolName) || isWriteTool(toolName))
}

async function main() {
  const input = (await Bun.stdin.json()) as FileEditHookInput
  if (!isClaudeMdEdit(input)) process.exit(0)

  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""

  try {
    const cwd = input.cwd ?? process.cwd()
    const { wordThreshold } = await resolveThresholds(cwd)
    const projectedContent = await computeProjectedContent(
      toolName,
      filePath,
      input.tool_input ?? {}
    )
    if (projectedContent === null) allowPreToolUse("")
    const projectedWordCount = countMarkdownWords(projectedContent!)

    if (projectedWordCount > wordThreshold) {
      denyPreToolUse(await buildWordLimitDenyReason(filePath, projectedWordCount, wordThreshold))
    }

    allowPreToolUse("")
  } catch {
    allowPreToolUse("")
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0)
  })
}
