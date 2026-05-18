#!/usr/bin/env bun

// PostToolUse hook: Warn when an Edit or Write operation dramatically shrinks a file.
// Detects silent truncation (e.g., Edit tool reducing 1300-line files to 0–1 lines)
// by comparing the post-edit line count against the git HEAD version.
// Non-blocking — injects additionalContext so the agent can self-correct before committing.

import { git } from "../src/git-helpers.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"

const MIN_NET_LINE_LOSS = 50
const MIN_PCT_LINE_LOSS = 0.5

export async function evaluateFileTruncationGuard(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const filePath = hookInput.tool_input?.file_path as string | undefined
  if (!filePath) return {}

  const cwd = hookInput.cwd ?? process.cwd()

  const file = Bun.file(filePath)
  if (!(await file.exists())) return {}

  const currentContent = await file.text()
  const currentLines = currentContent.length === 0 ? 0 : currentContent.split("\n").length

  let diffOutput: string
  try {
    diffOutput = await git(["diff", "HEAD", "--unified=0", "--", filePath], cwd)
  } catch {
    return {}
  }

  if (!diffOutput) return {}

  let removedLines = 0
  let addedLines = 0
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) removedLines++
    else if (line.startsWith("+") && !line.startsWith("+++")) addedLines++
  }

  const netLoss = removedLines - addedLines
  if (netLoss < MIN_NET_LINE_LOSS) return {}

  const headLines = currentLines - addedLines + removedLines
  if (headLines <= 0) return {}

  const pctLoss = netLoss / headLines
  if (pctLoss < MIN_PCT_LINE_LOSS) return {}

  const basename = filePath.split("/").pop() ?? filePath
  const pctStr = Math.round(pctLoss * 100)
  const context = [
    `${basename} lost ${netLoss} lines after this edit (${pctStr}% reduction: ${headLines} → ${currentLines} lines).`,
    `This matches the Edit tool silent truncation pattern. Verify the file is complete before committing.`,
    `Run: \`wc -l "${filePath}"\` and compare against the expected size.`,
    `If the file was unintentionally truncated, recover with: \`git checkout HEAD -- "${filePath}"\` and re-apply the intended change.`,
  ].join("\n")

  return buildContextHookOutput("PostToolUse", context)
}

const posttooluseFileTruncationGuard: SwizHook<Record<string, any>> = {
  name: "posttooluse-file-truncation-guard",
  event: "postToolUse",
  matcher: "Edit|Write",
  timeout: 5,
  run(input) {
    return evaluateFileTruncationGuard(input)
  },
}

export default posttooluseFileTruncationGuard

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseFileTruncationGuard)
}
