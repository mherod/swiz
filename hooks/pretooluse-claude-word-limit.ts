#!/usr/bin/env bun
// PreToolUse hook: Block git push when CLAUDE.md exceeds the configured word limit.
// Threshold is configurable via `swiz settings set memory-word-threshold <N>` (default: 5000).

import { join } from "node:path"
import {
  compactionChecklistSteps,
  USE_COMPACT_MEMORY_SKILL,
} from "../src/memory-compaction-guidance.ts"
import { DEFAULT_MEMORY_WORD_THRESHOLD, resolveNumericSetting } from "../src/settings.ts"
import {
  countFileWords,
  denyPreToolUse,
  formatActionPlan,
  isShellTool,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  // Only check for shell commands
  if (!isShellTool(input.tool_name ?? "")) return

  // Only check if the command is git push
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : ""
  if (!command.includes("git push")) return

  // Check CLAUDE.md word count
  const claudeMdPath = join(cwd, "CLAUDE.md")
  const [stats, wordLimit] = await Promise.all([
    countFileWords(claudeMdPath),
    resolveNumericSetting(cwd, "memoryWordThreshold", DEFAULT_MEMORY_WORD_THRESHOLD),
  ])

  // If CLAUDE.md doesn't exist or can't be read, allow the push
  if (stats === null) return

  // If word count exceeds limit, block the push
  if (stats.words > wordLimit) {
    const over = stats.words - wordLimit
    const reduction = over + 1 // Suggest reducing at least (over + 1) words to get back under
    const compactionChecklist = formatActionPlan(
      compactionChecklistSteps("Re-check after edits: `wc -w CLAUDE.md`"),
      { header: "Compaction checklist:" }
    )
    const message = `CLAUDE.md exceeds ${wordLimit}-word limit: ${stats.words} words (${over} over).

Reduce CLAUDE.md by at least ${reduction} words before pushing.

${USE_COMPACT_MEMORY_SKILL} to trim the file, or manually edit CLAUDE.md to remove redundancy.

${compactionChecklist}

Current: ${stats.words} words | Limit: ${wordLimit} words | Target: ${wordLimit - 10} words`

    denyPreToolUse(message)
  }
}

if (import.meta.main) await main()
