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
import { readSessionLines } from "../src/utils/transcript.ts"

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

/** Marker that `buildBehaviorSteeringContext` prefixes its block with. */
const STEERING_CONTEXT_MARKER = "Operating instructions:"

/**
 * The steering block is static for the life of a session, so re-injecting it on
 * every prompt is pure repetition — only the volatile lines (git state, task
 * counts) earn per-turn cost. Emit it once per session instead.
 *
 * `readSessionLines` returns only lines after the last compaction boundary, so a
 * compacted session — where the agent no longer sees the original block — gets it
 * re-emitted automatically. No sentinel file required.
 */
export async function shouldEmitSteeringContext(transcriptPath?: string): Promise<boolean> {
  if (!transcriptPath) return true
  const lines = await readSessionLines(transcriptPath)
  if (lines.length === 0) return true
  return !lines.some((line) => line.includes(STEERING_CONTEXT_MARKER))
}

/**
 * Resolve the behaviour context, dropping the static steering block when this
 * session has already been given it. `gitOptions` is always retained — it drives
 * the branch-policy decision on every turn, not just the first.
 */
async function resolveSteeringGatedBehaviorContext(
  cwd: string,
  sessionId?: string,
  transcriptPath?: string
): Promise<Awaited<ReturnType<typeof resolveBehaviorContext>>> {
  const resolved = await resolveBehaviorContext(cwd, sessionId)
  if (await shouldEmitSteeringContext(transcriptPath)) return resolved
  return { ...resolved, context: "" }
}

export async function evaluateUserpromptsubmitGitContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = userPromptSubmitHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const behavior = await resolveSteeringGatedBehaviorContext(
    cwd,
    hookInput.session_id,
    hookInput.transcript_path
  )
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
