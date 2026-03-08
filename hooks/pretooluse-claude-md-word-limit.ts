#!/usr/bin/env bun

// PreToolUse hook: Prevent CLAUDE.md files from exceeding the configured word limit.
// Blocks Edit/Write operations that would push the file over the threshold.
// Threshold is read from project > global > default (5000) settings, matching
// posttooluse-memory-size.ts and `swiz memory --strict` pre-commit enforcement.

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

async function countWords(text: string): Promise<number> {
  // Remove YAML frontmatter with BOM and line-ending variants
  // Matches: [optional BOM] + 3+ dashes + [line ending] + [content] + [line ending] + 3+ dashes + [line ending]
  // Handles CRLF (\r\n), CR (\r), and LF (\n) line endings, plus UTF-8 BOM
  let processed = text.replace(/^\uFEFF?---+[\r\n]+[\s\S]*?[\r\n]+---+[\r\n]+/, "")

  // Strip fenced code blocks (```...```)
  processed = processed.replace(/```[\s\S]*?```/g, "")

  // Remove indented code blocks (consecutive lines with 4+ spaces or tab indentation)
  // Matches one or more lines that start with 4+ spaces or a tab
  processed = processed.replace(/(?:^(?: {4}|\t).*\n?)+/gm, "")

  // Strip HTML comments (<!-- ... -->)
  processed = processed.replace(/<!--[\s\S]*?-->/g, "")

  // Remove markdown heading syntax (##, ###, etc.)
  processed = processed.replace(/^#+\s/gm, "")

  // Remove markdown emphasis markers (**, __, *, _, ``)
  processed = processed.replace(/[*_`]/g, "")

  // Remove markdown list markers (-, *, +) at line start
  processed = processed.replace(/^[\s]*[-*+]\s+/gm, "")

  // Remove blockquote markers (>) at line start
  processed = processed.replace(/^>\s+/gm, "")

  // Remove markdown link syntax [text](url) -> extract only text
  processed = processed.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  // Remove markdown image syntax ![alt](url)
  processed = processed.replace(/!\[[^\]]*\]\([^)]+\)/g, "")

  // Remove inline HTML tags
  processed = processed.replace(/<[^>]+>/g, "")

  // Remove markdown horizontal rules (---, ***, ___)
  processed = processed.replace(/^[\s]*(?:---|===|\*\*\*|___)/gm, "")

  // Normalize whitespace
  processed = processed.trim().replace(/\s+/g, " ")

  // Split on whitespace and count words (minimum 1 character per word)
  const words = processed.split(/\s+/).filter((w) => w.length > 0)

  return words.length
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
    const projectedWordCount = await countWords(projectedContent)

    if (projectedWordCount > wordThreshold) {
      const currentWordCount = await countWords(currentContent)
      const skill = skillAdvice(
        "compact-memory",
        `Use the /compact-memory skill to reduce the file below ${wordThreshold} words, then retry this edit.`,
        manualCompactionGuidanceFallback()
      )
      const inlineChecklist = formatActionPlan(
        compactionChecklistSteps(`Re-check size: \`wc -w ${filePath}\``)
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

main().catch(() => {
  process.exit(0)
})
