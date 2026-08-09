#!/usr/bin/env bun

// PreToolUse hook: Flag files a concurrent agent session changed recently.
//
// Reassurance, not a block: another agent editing the same repo is expected.
// The point is to re-read before writing and to stay inside your own change.

import { relative } from "node:path"
import { formatDuration } from "../src/format-duration.ts"
import {
  preToolUseAllowWithContext,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "../src/schemas.ts"
import { isFileEditTool } from "../src/tool-matchers.ts"

/** How recently another session must have touched a file to count as concurrent work. */
export const CONCURRENT_EDIT_WINDOW_MS = 2 * 60 * 60 * 1000

/** Render an absolute path relative to the project when it sits inside it. */
export function displayPathFor(cwd: string, filePath: string): string {
  if (!cwd) return filePath
  const rel = relative(cwd, filePath)
  return rel && !rel.startsWith("..") ? rel : filePath
}

export function formatConcurrentEditContext(displayPath: string, ageMs: number): string {
  return [
    `Re-read ${displayPath} before you change it — another agent working in this repo touched it ${formatDuration(ageMs)} ago.`,
    "",
    "That is expected and nothing has gone wrong. Stay inside your own change: leave their edits alone, do not refactor around them, and do not tidy files you did not come here for. They are getting the same note about your work.",
  ].join("\n")
}

export async function evaluatePretooluseConcurrentSessionEdits(
  input: FileEditHookInput,
  nowMs = Date.now()
): Promise<SwizHookOutput> {
  const parsed = fileEditHookInputSchema.parse(input)
  if (!isFileEditTool(parsed.tool_name ?? "")) return {}

  const filePath = parsed.tool_input?.file_path ?? ""
  const cwd = parsed.cwd ?? ""
  const sessionId = parsed.session_id ?? ""
  if (!filePath || !cwd || !sessionId) return {}

  const [{ getIssueStore }, { projectKeyFromCwd }] = await Promise.all([
    import("../src/issue-store.ts"),
    import("../src/transcript-utils.ts"),
  ])

  const projectKey = projectKeyFromCwd(cwd)
  if (!projectKey) return {}

  const store = getIssueStore()
  const since = nowMs - CONCURRENT_EDIT_WINDOW_MS
  const editors = store.listOtherSessionEditors(projectKey, sessionId, filePath, since)
  const latest = editors[0]
  if (!latest) return {}

  // Already reconciled: this session wrote the file after they did, so the
  // working copy in hand already carries their change.
  const ownEditAt = store.getSessionEditAt(projectKey, sessionId, filePath)
  if (ownEditAt !== null && ownEditAt >= latest.updated_at) return {}

  const context = formatConcurrentEditContext(
    displayPathFor(cwd, filePath),
    Math.max(0, nowMs - latest.updated_at)
  )
  return preToolUseAllowWithContext("Another agent session is working in this repo", context)
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
