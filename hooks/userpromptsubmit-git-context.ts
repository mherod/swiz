#!/usr/bin/env bun

import { git } from "../src/git-helpers.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { buildBehaviorSteeringContext } from "../src/settings/behavior-context.ts"
import { buildGitContextLine, DETACHED_HEAD_WARNING } from "../src/utils/git-context-messages.ts"

async function resolveBehaviorContext(
  cwd: string,
  sessionId?: string
): Promise<{
  context: string
  gitOptions: {
    collaborationMode?: string
    trunkMode?: boolean
    strictNoDirectMain?: boolean
    defaultBranch?: string
  }
}> {
  try {
    const { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } = await import(
      "../src/settings.ts"
    )
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings)
    const defaultBranch = projectSettings?.defaultBranch
    return {
      context: buildBehaviorSteeringContext(effective, {
        defaultBranch,
        memoryLineThreshold: projectSettings?.memoryLineThreshold,
        memoryWordThreshold: projectSettings?.memoryWordThreshold,
      }),
      gitOptions: {
        collaborationMode: effective.collaborationMode,
        trunkMode: effective.trunkMode,
        strictNoDirectMain: effective.strictNoDirectMain,
        defaultBranch,
      },
    }
  } catch {
    return { context: "", gitOptions: {} }
  }
}

function combineContext(...parts: string[]): string {
  return parts.filter(Boolean).join("\n")
}

export async function evaluateUserpromptsubmitGitContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = userPromptSubmitHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const behavior = await resolveBehaviorContext(cwd, hookInput.session_id)

  // Dynamic import to avoid circular dep (manifest → git-utils → settings → manifest)
  const { getGitStatusV2 } = await import("../src/utils/git-utils.ts")
  const gitStatus = await getGitStatusV2(cwd)

  if (!gitStatus) {
    const branch = (await git(["branch", "--show-current"], cwd)).trim() || "(unknown)"
    const line =
      branch === "(unknown)" ? `HEAD is detached. ${DETACHED_HEAD_WARNING}` : `On branch ${branch}.`
    return buildContextHookOutput("UserPromptSubmit", combineContext(line, behavior.context))
  }

  return buildContextHookOutput(
    "UserPromptSubmit",
    combineContext(buildGitContextLine(gitStatus, behavior.gitOptions), behavior.context)
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
