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
import { containsConcurrentWorkGuidance } from "../src/utils/concurrent-work-guidance.ts"
import { buildGitContextLine, DETACHED_HEAD_WARNING } from "../src/utils/git-context-messages.ts"
import {
  appendSessionFileOwnershipContext,
  resolveSessionFileOwnership,
} from "../src/utils/session-file-ownership.ts"

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
  const hasExplicitBranchPolicy = Boolean(
    behavior.gitOptions.trunkMode || behavior.gitOptions.strictNoDirectMain
  )

  // Dynamic import to avoid circular dep (manifest → git-utils → settings → manifest)
  const { getGitStatusV2 } = await import("../src/utils/git-utils.ts")
  const gitStatus = await getGitStatusV2(cwd)

  if (!gitStatus) {
    const branch = (await git(["branch", "--show-current"], cwd)).trim() || "(unknown)"
    const line =
      branch === "(unknown)" ? `HEAD is detached. ${DETACHED_HEAD_WARNING}` : `On branch ${branch}.`
    return buildContextHookOutput("UserPromptSubmit", combineContext(line, behavior.context), {
      rephrase: !hasExplicitBranchPolicy,
    })
  }

  let gitLine = buildGitContextLine(gitStatus, behavior.gitOptions)
  if (gitStatus.total > 0 && gitStatus.lines && gitStatus.lines.length > 0) {
    const ownership = await resolveSessionFileOwnership(cwd, hookInput.session_id, gitStatus.lines)
    gitLine = appendSessionFileOwnershipContext(gitLine, ownership)
  }

  const context = combineContext(gitLine, behavior.context)
  return buildContextHookOutput("UserPromptSubmit", context, {
    rephrase: !hasExplicitBranchPolicy && !containsConcurrentWorkGuidance(context),
  })
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
