#!/usr/bin/env bun

/**
 * PostToolUse hook: verify git commit author and committer identity after commit.
 *
 * This is a landing check: if a commit was created with a placeholder account or
 * with author/committer values that do not match git config, block immediately
 * so the commit is amended before push.
 */

import { checkHeadCommitIdentity } from "../src/git-identity.ts"
import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import {
  hookOutputSchema,
  type PostToolHookInput,
  postToolUseHookInputSchema,
} from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { hsoPostToolUseDenyBlock } from "../src/utils/hook-specific-output.ts"
import { GIT_COMMIT_RE } from "../src/utils/shell-patterns.ts"

function getCommitCommand(input: PostToolHookInput): string | null {
  if (!input.tool_name || !isShellTool(input.tool_name)) return null
  const command = input.tool_input?.command
  if (typeof command !== "string") return null
  return GIT_COMMIT_RE.test(command) ? command : null
}

function stringResponseFailed(response: string): boolean {
  return /\bnothing to commit\b|\bno changes added\b|\bexit code [1-9]\d*\b/i.test(response)
}

function exitCodeFailed(exitCode: unknown): boolean {
  if (typeof exitCode === "number") return exitCode !== 0
  if (typeof exitCode === "string" && /^\d+$/.test(exitCode)) return Number(exitCode) !== 0
  return false
}

function objectResponseFailed(fields: Record<string, unknown>): boolean {
  if (exitCodeFailed(fields.exit_code ?? fields.exitCode ?? fields.code)) return true
  return typeof fields.status === "string" && /fail|error/i.test(fields.status)
}

function commandFailed(input: PostToolHookInput): boolean {
  const response = input.tool_response
  if (typeof response === "string") return stringResponseFailed(response)
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  return objectResponseFailed(response as Record<string, unknown>)
}

function buildBlock(problems: string[]): SwizHookOutput {
  const reason =
    "Git commit author verification failed.\n\n" +
    `Problems:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
    "Amend the commit with the correct author/committer identity before pushing."

  return hookOutputSchema.parse({
    decision: "block",
    reason,
    suppressOutput: true,
    systemMessage: "Git commit author verification failed.",
    hookSpecificOutput: hsoPostToolUseDenyBlock(reason),
  })
}

export async function evaluatePosttooluseCommitAuthorVerification(
  input: unknown
): Promise<SwizHookOutput> {
  const parsed = postToolUseHookInputSchema.safeParse(input)
  if (!parsed.success) return {}
  if (!getCommitCommand(parsed.data as PostToolHookInput)) return {}
  if (commandFailed(parsed.data as PostToolHookInput)) return {}

  const cwd = parsed.data.cwd ?? process.cwd()
  const result = await checkHeadCommitIdentity(cwd)
  if (!result.isGitRepo || result.ok) return {}
  return buildBlock(result.problems)
}

const posttooluseCommitAuthorVerification: SwizHook<Record<string, any>> = {
  name: "posttooluse-commit-author-verification",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseCommitAuthorVerification(input)
  },
}

export default posttooluseCommitAuthorVerification

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseCommitAuthorVerification)
}
