#!/usr/bin/env bun

/**
 * PreToolUse hook: refuse a deletion that would destroy deliberately staged work.
 *
 * `trash <path>` and `git rm --cached <path>` name exactly one file and are as precisely scoped
 * as a command can be — which is why the wildcard rules (`git add -A`, `git clean`, `rm -rf`)
 * miss them entirely, and why `trash` is recommended elsewhere in this manifest as the *safe*
 * alternative to `rm`. In a shared checkout that recommendation has a hole: the file may be a
 * peer's, staged minutes ago, and single-path scoping does nothing to protect it.
 *
 * The check is one question — does the index say someone put this here on purpose — and it
 * fails open on anything it cannot answer.
 */

import {
  extractDeletionTargets,
  findStagedPaths,
  formatStagedPathDenial,
} from "../src/peer-staged-paths.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"

export async function evaluatePeerStagedPathDeletion(
  input: ShellHookInput
): Promise<SwizHookOutput> {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command = input.tool_input?.command ?? ""
  if (!command) return {}

  const targets = extractDeletionTargets(command)
  if (targets.length === 0) return {}

  const cwd = input.cwd ?? process.cwd()
  const staged = await findStagedPaths(targets, cwd)
  if (staged.length === 0) return {}

  return preToolUseDeny(formatStagedPathDenial(staged))
}

const pretooluesePeerStagedPathDeletion: SwizHook<ShellHookInput> = {
  name: "pretooluse-peer-staged-path-deletion",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,
  run(input) {
    return evaluatePeerStagedPathDeletion(input)
  },
}

export default pretooluesePeerStagedPathDeletion

if (import.meta.main) {
  await runSwizHookAsMain(pretooluesePeerStagedPathDeletion)
}
