#!/usr/bin/env bun

// PostToolUse hook: Warn when an Edit or Write operation dramatically shrinks a file.
// Detects silent truncation (e.g., Edit tool reducing 1300-line files to 0–1 lines)
// by comparing the post-edit line count against the git HEAD version.
// Non-blocking — injects additionalContext so the agent can self-correct before committing.

import { basename, isAbsolute, resolve } from "node:path"
import { git } from "../src/git-helpers.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"

const MIN_NET_LINE_LOSS = 50
const MIN_PCT_LINE_LOSS = 0.5
const APPLY_PATCH_FILE_PREFIXES = [
  "*** Update File: ",
  "*** Delete File: ",
  "*** Add File: ",
  "*** Move to: ",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function addNonEmptyPath(paths: Set<string>, value: unknown): void {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (trimmed) paths.add(trimmed)
}

function extractApplyPatchFilePaths(command: string): string[] {
  const paths = new Set<string>()
  for (const line of command.split("\n")) {
    const prefix = APPLY_PATCH_FILE_PREFIXES.find((candidate) => line.startsWith(candidate))
    if (!prefix) continue
    addNonEmptyPath(paths, line.slice(prefix.length))
  }
  return Array.from(paths)
}

function extractEditedFilePaths(toolInput: unknown): string[] {
  if (!isRecord(toolInput)) return []

  const paths = new Set<string>()
  addNonEmptyPath(paths, toolInput.file_path)

  if (typeof toolInput.command === "string") {
    for (const filePath of extractApplyPatchFilePaths(toolInput.command)) {
      paths.add(filePath)
    }
  }

  return Array.from(paths)
}

function resolveEditedPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

async function readDiffOutput(filePath: string, cwd: string): Promise<string | null> {
  try {
    return await git(["diff", "HEAD", "--unified=0", "--", filePath], cwd)
  } catch {
    return null
  }
}

function countDiffLineChanges(diffOutput: string): { addedLines: number; removedLines: number } {
  let removedLines = 0
  let addedLines = 0
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) removedLines++
    else if (line.startsWith("+") && !line.startsWith("+++")) addedLines++
  }
  return { addedLines, removedLines }
}

function computeLineLoss(
  currentLines: number,
  changes: { addedLines: number; removedLines: number }
): { headLines: number; netLoss: number; pctLoss: number } | null {
  const netLoss = changes.removedLines - changes.addedLines
  const headLines = currentLines - changes.addedLines + changes.removedLines
  if (netLoss < MIN_NET_LINE_LOSS || headLines <= 0) return null

  const pctLoss = netLoss / headLines
  if (pctLoss < MIN_PCT_LINE_LOSS) return null

  return { headLines, netLoss, pctLoss }
}

async function buildTruncationContext(filePath: string, cwd: string): Promise<string | null> {
  const absolutePath = resolveEditedPath(cwd, filePath)

  const file = Bun.file(absolutePath)
  if (!(await file.exists())) return null

  const currentContent = await file.text()
  const currentLines = currentContent.length === 0 ? 0 : currentContent.split("\n").length
  const diffOutput = await readDiffOutput(absolutePath, cwd)
  if (!diffOutput) return null

  const lineLoss = computeLineLoss(currentLines, countDiffLineChanges(diffOutput))
  if (!lineLoss) return null

  const pctStr = Math.round(lineLoss.pctLoss * 100)
  return [
    `${basename(filePath)} lost ${lineLoss.netLoss} lines after this edit (${pctStr}% reduction: ${lineLoss.headLines} → ${currentLines} lines).`,
    `This matches the file-edit silent truncation pattern. Verify the file is complete before committing.`,
    `Run: \`wc -l "${absolutePath}"\` and compare against the expected size.`,
    `If the file was unintentionally truncated, recover with: \`git checkout HEAD -- "${absolutePath}"\` and re-apply the intended change.`,
  ].join("\n")
}

export async function evaluateFileTruncationGuard(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const filePaths = extractEditedFilePaths(hookInput.tool_input)
  if (filePaths.length === 0) return {}

  const contexts: string[] = []
  for (const filePath of filePaths) {
    const context = await buildTruncationContext(filePath, cwd)
    if (context) contexts.push(context)
  }

  if (contexts.length === 0) return {}

  return buildContextHookOutput("PostToolUse", contexts.join("\n\n"))
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
