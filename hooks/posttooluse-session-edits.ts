#!/usr/bin/env bun

// PostToolUse hook: Track file edits during a session in IssueStore
//
// Dual-mode: exports a SwizHook for inline dispatch and remains executable as a subprocess.

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type PostToolHookInput, toolHookInputSchema } from "../src/schemas.ts"
import { isFileEditTool } from "../src/utils/hook-utils.ts"

function resolveEditTarget(input: ReturnType<typeof toolHookInputSchema.parse>): string | null {
  const tool = input.tool_name ?? ""
  const file = (input.tool_input?.file_path as string) ?? ""
  if (!isFileEditTool(tool)) return null
  return file || null
}

export async function evaluatePosttooluseSessionEdits(
  input: PostToolHookInput
): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const file = resolveEditTarget(parsed)

  if (!file) return {}

  const cwd = parsed.cwd ?? process.cwd()
  const sessionId = (parsed.session_id as string) ?? ""

  const [{ getIssueStore }, { projectKeyFromCwd }] = await Promise.all([
    import("../src/issue-store.ts"),
    import("../src/transcript-utils.ts"),
  ])

  const projectKey = projectKeyFromCwd(cwd)

  if (sessionId && projectKey && file) {
    getIssueStore().recordSessionEdit(projectKey, sessionId, file)
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
