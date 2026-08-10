#!/usr/bin/env bun

// PreToolUse hook: Flag files a concurrent agent session changed recently.
//
// Reassurance, not a block: another agent editing the same repo is expected.
// The point is to re-read before writing and to stay inside your own change.

import { relative, resolve } from "node:path"
import { formatDuration } from "../src/format-duration.ts"
import {
  preToolUseAllowWithContext,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "../src/schemas.ts"
import { extractFileEditTargetPaths, isFileEditTool } from "../src/tool-matchers.ts"
import { buildConcurrentFileEditGuidance } from "../src/utils/concurrent-work-guidance.ts"
import { CONCURRENT_EDIT_WINDOW_MS } from "../src/utils/session-file-ownership.ts"

export { CONCURRENT_EDIT_WINDOW_MS } from "../src/utils/session-file-ownership.ts"

/** Render an absolute path relative to the project when it sits inside it. */
export function displayPathFor(cwd: string, filePath: string): string {
  if (!cwd) return filePath
  const rel = relative(cwd, filePath)
  return rel && !rel.startsWith("..") ? rel : filePath
}

export function formatConcurrentEditContext(displayPath: string, ageMs: number): string {
  return buildConcurrentFileEditGuidance(displayPath, formatDuration(ageMs))
}

export async function evaluatePretooluseConcurrentSessionEdits(
  input: FileEditHookInput,
  nowMs = Date.now()
): Promise<SwizHookOutput> {
  const parsed = fileEditHookInputSchema.parse(input)
  if (!isFileEditTool(parsed.tool_name ?? "")) return {}

  const cwd = parsed.cwd ?? ""
  const sessionId = parsed.session_id ?? ""
  const filePaths = extractFileEditTargetPaths(parsed.tool_input ?? {}).map((filePath) =>
    resolve(cwd, filePath)
  )
  if (filePaths.length === 0 || !cwd || !sessionId) return {}

  const [{ getIssueStore }, { projectKeyFromCwd }] = await Promise.all([
    import("../src/issue-store.ts"),
    import("../src/transcript-utils.ts"),
  ])

  const projectKey = projectKeyFromCwd(cwd)
  if (!projectKey) return {}

  const store = getIssueStore()
  const since = nowMs - CONCURRENT_EDIT_WINDOW_MS
  const pendingOverlaps = filePaths.flatMap((filePath) => {
    const latest = store.listOtherSessionEditors(projectKey, sessionId, filePath, since)[0]
    if (!latest) return []
    const ownEditAt = store.getSessionEditAt(projectKey, sessionId, filePath)
    if (ownEditAt !== null && ownEditAt >= latest.updated_at) return []
    return [{ filePath, updatedAt: latest.updated_at }]
  })
  pendingOverlaps.sort((a, b) => b.updatedAt - a.updatedAt)
  const latest = pendingOverlaps[0]
  if (!latest) return {}

  const context = formatConcurrentEditContext(
    displayPathFor(cwd, latest.filePath),
    Math.max(0, nowMs - latest.updatedAt)
  )
  return preToolUseAllowWithContext("Concurrent work is normal — continue your task", context, {
    rephrase: false,
  })
}

const pretooluseConcurrentSessionEdits: SwizHook<FileEditHookInput> = {
  name: "pretooluse-concurrent-session-edits",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  run(input) {
    return evaluatePretooluseConcurrentSessionEdits(input)
  },
}

export default pretooluseConcurrentSessionEdits

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseConcurrentSessionEdits)
}
