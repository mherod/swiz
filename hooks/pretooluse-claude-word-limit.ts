#!/usr/bin/env bun
// PreToolUse hook: Block git push when CLAUDE.md exceeds the configured word limit.
// Threshold is configurable via `swiz settings set memory-word-threshold <N>` (default: 5000).

import { join } from "node:path"
import {
  compactionChecklistSteps,
  USE_COMPACT_MEMORY_SKILL,
} from "../src/memory-compaction-guidance.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { DEFAULT_MEMORY_WORD_THRESHOLD, resolveNumericSetting } from "../src/settings.ts"
import { countFileWords, formatActionPlan, isShellTool } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

export async function evaluatePretooluseClaudeWordLimit(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  if (!isShellTool(hookInput.tool_name ?? "")) return {}

  const command =
    typeof hookInput.tool_input?.command === "string" ? hookInput.tool_input.command : ""
  if (!command.includes("git push")) return {}

  const claudeMdPath = join(cwd, "CLAUDE.md")
  const [stats, wordLimit] = await Promise.all([
    countFileWords(claudeMdPath),
    resolveNumericSetting(cwd, "memoryWordThreshold", DEFAULT_MEMORY_WORD_THRESHOLD),
  ])

  if (stats === null) return {}

  if (stats.words > wordLimit) {
    const over = stats.words - wordLimit
    const reduction = over + 1
    const compactionChecklist = formatActionPlan(
      compactionChecklistSteps("Re-check after edits: `wc -w CLAUDE.md`"),
      { header: "Compaction checklist:" }
    )
    const message = `CLAUDE.md exceeds ${wordLimit}-word limit: ${stats.words} words (${over} over).

Reduce CLAUDE.md by at least ${reduction} words before pushing.

${USE_COMPACT_MEMORY_SKILL} to trim the file, or manually edit CLAUDE.md to remove redundancy.

${compactionChecklist}

Current: ${stats.words} words | Limit: ${wordLimit} words | Target: ${wordLimit - 10} words`

    return preToolUseDeny(message)
  }

  return {}
}

const pretooluseClaudeWordLimit: SwizToolHook = {
  name: "pretooluse-claude-word-limit",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluatePretooluseClaudeWordLimit(input)
  },
}

export default pretooluseClaudeWordLimit

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseClaudeWordLimit)
}
