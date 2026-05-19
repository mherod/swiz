#!/usr/bin/env bun
/**
 * PreToolUse hook: Block `--no-git-checks` (and the env-var equivalent) for
 * npm and pnpm. These flags bypass the dirty-worktree / unsynced-branch
 * safeguards around `publish`; checks should be fixed, not skipped.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { preToolUseDeny } from "../src/utils/hook-utils.ts"
import { SHELL_SEGMENT_BOUNDARY, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

const PNPM_INVOKE_RE = new RegExp(`${SHELL_SEGMENT_BOUNDARY}\\s*(npm|pnpm)\\b`)
const NO_GIT_CHECKS_FLAG_RE = /(?:^|\s)--no-git-checks(?:=|\s|$)/
const NO_GIT_CHECKS_ENV_RE =
  /(?:^|[\s;&]|^env\s+)(?:npm|pnpm)_config_no_git_checks\s*=\s*(?:1|true|yes|on)\b/i

const DENY_MESSAGE =
  "Do not use `--no-git-checks` (or `npm_config_no_git_checks=1`) with npm or pnpm.\n\n" +
  "These flags suppress the dirty-worktree / branch-sync checks that guard `publish`.\n\n" +
  "Fix the underlying issue instead:\n" +
  "  • Commit or stash uncommitted changes\n" +
  "  • Push outstanding commits and ensure the branch is in sync\n" +
  "  • Re-run the publish without the flag"

function evaluate(input: ShellHookInput): SwizHookOutput {
  if (!isShellTool(input.tool_name ?? "")) return {}
  const command: string = input.tool_input?.command ?? ""
  if (!command) return {}

  const stripped = stripQuotedShellStrings(command, { preserveQuotePairs: true })

  if (NO_GIT_CHECKS_FLAG_RE.test(stripped) && PNPM_INVOKE_RE.test(stripped)) {
    return preToolUseDeny(DENY_MESSAGE)
  }
  if (NO_GIT_CHECKS_ENV_RE.test(stripped)) {
    return preToolUseDeny(DENY_MESSAGE)
  }
  return {}
}

const pretooluseNoGitChecks: SwizShellHook = {
  name: "pretooluse-no-git-checks",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,
  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretooluseNoGitChecks

if (import.meta.main) await runSwizHookAsMain(pretooluseNoGitChecks)
