#!/usr/bin/env bun

/**
 * PostToolUse hook: trigger background jbcontext reindexing after git commit / merge / pull.
 *
 * Runs asynchronously (fire-and-forget) so agent execution is never blocked.
 */

import { stripHeredocs } from "../src/command-utils.ts"
import { isJbcontextConfigured, triggerJbcontextIndex } from "../src/jbcontext.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { GIT_COMMIT_RE } from "../src/utils/shell-patterns.ts"

const REINDEX_COMMAND_RE = /\bgit\s+(?:-[^\s]+\s+)*(?:merge|rebase|pull|cherry-pick)\b/i

export function isReindexTriggeringCommand(command: string): boolean {
  if (!command) return false
  return GIT_COMMIT_RE.test(command) || REINDEX_COMMAND_RE.test(command)
}

export async function evaluatePosttooluseJbcontextReindex(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.safeParse(input)
  if (!parsed.success) return {}

  const { tool_name, tool_input, cwd } = parsed.data
  if (!tool_name || !isShellTool(tool_name)) return {}

  const rawCommand = String((tool_input as { command?: unknown } | undefined)?.command ?? "")
  const command = stripHeredocs(rawCommand)
  if (!isReindexTriggeringCommand(command)) return {}

  const targetDir = cwd ?? process.cwd()
  const configured = await isJbcontextConfigured({ projectPath: targetDir })
  if (!configured) return {}

  await triggerJbcontextIndex({
    projectPath: targetDir,
    silent: true,
  })

  return {}
}

const posttooluseJbcontextReindex: SwizHook<Record<string, any>> = {
  name: "posttooluse-jbcontext-reindex",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,
  async: true,
  asyncMode: "fire-and-forget",
  run(input) {
    return evaluatePosttooluseJbcontextReindex(input)
  },
}

export default posttooluseJbcontextReindex

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseJbcontextReindex)
}
