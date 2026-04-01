#!/usr/bin/env bun

import { git } from "../src/git-helpers.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import { buildContextHookOutput, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import { userPromptSubmitHookInputSchema } from "./schemas.ts"

export async function evaluateUserpromptsubmitGitContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = userPromptSubmitHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  const branch = (await git(["branch", "--show-current"], cwd)) || "(unknown)"
  const dirty = (await git(["status", "--porcelain"], cwd))?.split("\n").filter(Boolean).length ?? 0

  return buildContextHookOutput(
    "UserPromptSubmit",
    `[git] branch: ${branch} | uncommitted files: ${dirty}`
  )
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
