#!/usr/bin/env bun
// PreToolUse hook: Prevent CLAUDE.md files from exceeding 5000 words.
// Blocks Edit/Write operations that would push the file over the threshold.

import { denyPreToolUse, isEditTool, isWriteTool, skillAdvice } from "./hook-utils.ts"

const WORD_LIMIT = 5000

interface ToolInput {
  file_path?: string
  old_string?: string
  new_string?: string
  content?: string
}

async function countWords(text: string): Promise<number> {
  // Remove YAML frontmatter (--- ... --- at file start)
  let processed = text.replace(/^---\n[\s\S]*?\n---\n/, "")

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

    if (projectedWordCount > WORD_LIMIT) {
      const currentWordCount = await countWords(currentContent)
      const skill = skillAdvice(
        "compact-memory",
        "Use the /compact-memory skill to reduce the file below 5000 words, then retry this edit.",
        "Run `bun ~/.claude/skills/compact-memory/scripts/compact.ts` to reduce the file."
      )

      denyPreToolUse(
        `CLAUDE.md word limit exceeded.\n\n` +
          `Current: ${currentWordCount} words\n` +
          `After edit: ${projectedWordCount} words\n` +
          `Limit: ${WORD_LIMIT} words\n\n` +
          `The CLAUDE.md file cannot exceed ${WORD_LIMIT} words. ` +
          `This limit keeps the memory file focused and performant.\n\n` +
          `${skill}`
      )
    }

    // Allow the edit
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      })
    )
  } catch (error) {
    // On any error, allow the edit (fail open) rather than blocking
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      })
    )
  }
}

main().catch(() => {
  process.exit(0)
})
