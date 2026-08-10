#!/usr/bin/env bun

// PostToolUse hook: Track file edits during a session in IssueStore
//
// Dual-mode: exports a SwizHook for inline dispatch and remains executable as a subprocess.

import { resolve } from "node:path"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type PostToolHookInput, toolHookInputSchema } from "../src/schemas.ts"
import { extractFileEditTargetPaths, isFileEditTool } from "../src/tool-matchers.ts"

export function resolveEditTargets(input: ReturnType<typeof toolHookInputSchema.parse>): string[] {
  const tool = input.tool_name ?? ""
  if (!isFileEditTool(tool)) return []
  return extractFileEditTargetPaths(input.tool_input ?? {})
}

export async function evaluatePosttooluseSessionEdits(
  input: PostToolHookInput
): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const files = resolveEditTargets(parsed)

  if (files.length === 0) return {}

  const cwd = parsed.cwd ?? process.cwd()
  const sessionId = (parsed.session_id as string) ?? ""

  const [{ getIssueStore }, { projectKeyFromCwd }] = await Promise.all([
    import("../src/issue-store.ts"),
    import("../src/transcript-utils.ts"),
  ])

  const projectKey = projectKeyFromCwd(cwd)

  if (sessionId && projectKey) {
    const store = getIssueStore()
    for (const file of files) store.recordSessionEdit(projectKey, sessionId, resolve(cwd, file))
  }

  return {}
}

const posttooluseSessionEdits: SwizHook<PostToolHookInput> = {
  name: "posttooluse-session-edits",
  event: "postToolUse",
  matcher: "Edit|Write|Replace",
  timeout: 5,

  run(input) {
    return evaluatePosttooluseSessionEdits(input)
  },
}

export default posttooluseSessionEdits

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseSessionEdits)
}
