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
import {
  allowPreToolUse,
  denyPreToolUse,
  formatActionPlan,
  isEditTool,
  isWriteTool,
  skillAdvice,
} from "./hook-utils.ts"
import { resolveThresholds } from "./posttooluse-memory-size.ts"

interface ToolInput {
  file_path?: string
  old_string?: string
  new_string?: string
  content?: string
}

async function main() {
  const input = (await Bun.stdin.json()) as {
    tool_name?: string
    tool_input?: ToolInput
    cwd?: string
  }

  const toolName = input.tool_name ?? ""
  const filePath = input.tool_input?.file_path ?? ""

  // Only guard CLAUDE.md files
  if (!filePath.endsWith("CLAUDE.md")) {
    process.exit(0)
  }

  // Only guard Edit and Write tools
  if (!isEditTool(toolName) && !isWriteTool(toolName)) {
    process.exit(0)
  }

  try {
    // Resolve threshold from settings: project > global > default (5000)
    const cwd = input.cwd ?? process.cwd()
    const { wordThreshold } = await resolveThresholds(cwd)

    // Read the current file content
    let currentContent = ""
    try {
      currentContent = await Bun.file(filePath).text()
    } catch {
      // File doesn't exist yet (Write to new file) - use empty content
      currentContent = ""
    }

    // Calculate projected content after edit
    let projectedContent = currentContent
    if (isEditTool(toolName)) {
      // Edit: replace old_string with new_string
      const oldString = input.tool_input?.old_string ?? ""
      const newString = input.tool_input?.new_string ?? ""
      projectedContent = currentContent.replace(oldString, newString)
    } else {
      // Write: use the new content directly
      projectedContent = input.tool_input?.content ?? ""
    }

    // Count words in projected content
    const projectedWordCount = countMarkdownWords(projectedContent)

    if (projectedWordCount > wordThreshold) {
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

      denyPreToolUse(
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

    allowPreToolUse("")
  } catch {
    // On any error, allow the edit (fail open) rather than blocking
    allowPreToolUse("")
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0)
  })
}
