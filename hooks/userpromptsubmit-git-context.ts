#!/usr/bin/env bun

import { git } from "../src/git-helpers.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { userPromptSubmitHookInputSchema } from "../src/schemas.ts"

export async function evaluateUserpromptsubmitGitContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = userPromptSubmitHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  // Dynamic import to avoid circular dep (manifest → git-utils → settings → manifest)
  const { getGitStatusV2, buildGitContextLine, DETACHED_HEAD_WARNING } = await import(
    "../src/utils/git-utils.ts"
  )
  const gitStatus = await getGitStatusV2(cwd)

  if (!gitStatus) {
    const branch = (await git(["branch", "--show-current"], cwd)).trim() || "(unknown)"
    const line =
      branch === "(unknown)"
        ? `[git] HEAD is detached. ${DETACHED_HEAD_WARNING}`
        : `[git] On branch ${branch}.`
    return buildContextHookOutput("UserPromptSubmit", line)
  }

  return buildContextHookOutput("UserPromptSubmit", buildGitContextLine(gitStatus))
}

const userpromptsubmitGitContext: SwizHook<Record<string, any>> = {
  name: "userpromptsubmit-git-context",
  event: "userPromptSubmit",
  timeout: 5,
  run(input) {
    return evaluateUserpromptsubmitGitContext(input)
  },
}

export default userpromptsubmitGitContext

if (import.meta.main) {
  await runSwizHookAsMain(userpromptsubmitGitContext)
}
